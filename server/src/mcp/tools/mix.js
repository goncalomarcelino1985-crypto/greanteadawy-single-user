// Mixer, effects and render_mix (mixdown + analysis in the user's browser).
import { EFFECTS, EFFECT_TYPES, uid, findPattern, findChannel, ticksPerBar, songLength, sanitizeParams, sanitizePluginValues } from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, findEffect } from '../util.js';
import { requirePlugin, pluginValues } from './plugins.js';

/** Validate effect params; channel references (the pump's sidechain source) may be given by name. */
function resolveEffectParams(p, type, params) {
  if (!params) return params;
  const out = { ...params };
  for (const def of EFFECTS[type].params) {
    if (def.type !== 'channel' || !(def.key in out)) continue;
    const v = out[def.key];
    out[def.key] = v === null || v === '' || v === 'none' ? null : findChannel(p, v).id;
  }
  sanitizeParams(EFFECTS[type].params, out, { strict: true }); // unknown keys / out-of-range values -> clear error
  return out;
}

/** Loudness references per target: integrated LUFS, true-peak ceiling and a typical crest range. */
export const MIX_TARGETS = {
  streaming: { lufs: -14, truePeak: -1, label: 'streaming (Spotify/YouTube/Apple normalise to about -14 LUFS)' },
  'apple-music': { lufs: -16, truePeak: -1, label: 'Apple Music (Sound Check -16 LUFS)' },
  club: { lufs: -8, truePeak: -0.5, label: 'club / DJ (-9..-6 LUFS)' },
  'hip-hop': { lufs: -9, truePeak: -1, label: 'modern hip-hop / trap master (-10..-7 LUFS)' },
  edm: { lufs: -7, truePeak: -0.5, label: 'EDM / festival (-8..-5 LUFS)' },
  'lo-fi': { lufs: -14, truePeak: -1, label: 'lo-fi / chill (dynamic, -16..-12 LUFS)' },
  broadcast: { lufs: -23, truePeak: -1, label: 'broadcast EBU R128 (-23 LUFS)' },
  podcast: { lufs: -16, truePeak: -1, label: 'podcast / spoken word (-16 LUFS)' }
};

export function registerMixTools({ tool, backend, load }) {
  tool('set_mixer', {
    title: 'Set mixer insert',
    description: 'Change a mixer insert (0 = Master): name, color, volume (0..1.25; inserts default 0.8 ≈ -1.9 dB, the master 1.0 = 0 dB — keep the master at 0 dB, it sits after the master limiter), pan, mute, solo, output routing and sends (e.g. to a shared reverb bus). Inserts that do not exist yet are created.',
    inputSchema: {
      projectId: projectIdArg,
      insert: z.number().int().min(0).max(64),
      name: z.string().min(1).max(64).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      volume: z.number().min(0).max(1.25).optional(),
      volumeDb: z.number().min(-60).max(1.9).optional().describe('Alternative to volume, in dB'),
      pan: z.number().min(-1).max(1).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      output: z.number().int().min(0).optional().describe('Route this insert into another insert (default 0 = master)'),
      sends: z.array(z.object({ to: z.number().int().min(0), amount: z.number().min(0).max(1) })).optional().describe('Extra sends (replaces the existing list)')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    if (a.sends) {
      const targets = a.sends.map((s) => s.to);
      if (new Set(targets).size !== targets.length) throw new Error('Each send target may appear only once');
      if (targets.includes(a.insert)) throw new Error("An insert can't send to itself");
      const out = a.output ?? p.mixer[a.insert]?.output ?? 0;
      if (targets.includes(out)) throw new Error(`Insert ${a.insert} already outputs to ${out}; a send there would double the signal`);
    }
    if (a.output !== undefined && a.output === a.insert && a.insert !== 0) throw new Error("An insert can't output to itself");
    if (a.insert === 0 && (a.output !== undefined || a.sends?.length)) throw new Error('The master (insert 0) always goes to the speakers: it has no output routing or sends');
    const ops = [];
    if (a.insert >= p.mixer.length) ops.push({ type: 'mixer/add', count: a.insert - p.mixer.length + 1 });
    const patch = {};
    for (const k of ['name', 'color', 'volume', 'pan', 'mute', 'solo', 'output', 'sends']) if (a[k] !== undefined) patch[k] = a[k];
    if (a.volumeDb !== undefined) patch.volume = Math.pow(10, a.volumeDb / 20);
    if (!Object.keys(patch).length && !ops.length) throw new Error('Nothing to change');
    if (Object.keys(patch).length) ops.push({ type: 'mixer/update', index: a.insert, patch });
    const after = await backend.applyOps(p.id, ops);
    const m = after.mixer[a.insert];
    const db = m.volume > 0 ? (20 * Math.log10(m.volume)).toFixed(1) : '-inf';
    return ok(`Insert ${a.insert} "${m.name}": vol ${Math.round(m.volume * 100) / 100} (${db} dB), pan ${m.pan}${m.mute ? ', muted' : ''}${m.solo ? ', solo' : ''}${a.insert ? `, out→${m.output}` : ''}${m.sends?.length ? `, sends ${m.sends.map((s) => `${s.to}@${s.amount}`).join(' ')}` : ''}.`);
  });

  tool('add_effect', {
    title: 'Add effect',
    description: `Add an effect to a mixer insert's chain (0 = master; on the master it is placed before the limiter). Types: ${EFFECT_TYPES.map((t) => `${t} (${EFFECTS[t].description})`).join('; ')}. Use list_effects for params. For a kick-triggered sidechain put pump on the bass/pad insert with params {"source":"Kick"}.`,
    inputSchema: {
      projectId: projectIdArg,
      insert: z.number().int().min(0),
      type: z.enum(EFFECT_TYPES),
      plugin: z.string().optional().describe('For type "plugin": the effect plugin id (list_plugins)'),
      preset: z.string().optional().describe('For type "plugin": one of its presets'),
      params: z.record(z.string(), z.any()).optional(),
      position: z.number().int().min(0).optional().describe('Slot index (default: end of chain)')
    },
    annotations: A.edit
  }, async ({ projectId, insert, type, plugin, preset, params, position }) => {
    const p = await load(projectId);
    if (!p.mixer[insert]) throw new Error(`Mixer insert ${insert} does not exist (0..${p.mixer.length - 1}; set_mixer creates inserts)`);
    let pluginId = null;
    if (type === 'plugin') {
      const m = await requirePlugin(backend, plugin, 'effect');
      params = pluginValues(m, preset, params);
      pluginId = m.id;
    } else {
      if (plugin) throw new Error('plugin only works with type "plugin"');
      params = resolveEffectParams(p, type, params);
    }
    const id = uid('fx');
    let pos = position;
    if (pos === undefined && insert === 0 && type !== 'limiter') {
      const lim = p.mixer[0].effects.findIndex((e) => e.type === 'limiter');
      if (lim >= 0) pos = lim;
    }
    await backend.applyOps(p.id, [{ type: 'effect/add', index: insert, position: pos, effect: { id, type, params, ...(pluginId && { plugin: pluginId }) } }]);
    return ok(`Added ${type}${pluginId ? ` ${pluginId}` : ''} [${id}] to insert ${insert} "${p.mixer[insert].name}".`);
  });

  tool('update_effect', {
    title: 'Update effect',
    description: "Change an effect's params or bypass it.",
    inputSchema: {
      projectId: projectIdArg,
      insert: z.number().int().min(0),
      effectId: z.string().describe('Effect id, or effect type if only one of that type is on the insert'),
      params: z.record(z.string(), z.any()).optional(),
      enabled: z.boolean().optional()
    },
    annotations: A.edit
  }, async ({ projectId, insert, effectId, params, enabled }) => {
    const p = await load(projectId);
    const fx = findEffect(p, insert, effectId);
    if (fx.type === 'plugin') {
      if (params) {
        const m = await requirePlugin(backend, fx.plugin, 'effect');
        pluginValues(m, null, params); // strict: clear errors for Claude
        params = sanitizePluginValues(m.params, params); // stored as the plugin will see them (stepped values rounded)
      }
    } else {
      params = resolveEffectParams(p, fx.type, params);
    }
    const patch = {};
    if (params) patch.params = params;
    if (enabled !== undefined) patch.enabled = enabled;
    if (!Object.keys(patch).length) throw new Error('Nothing to change');
    await backend.applyOps(p.id, [{ type: 'effect/update', index: insert, effectId: fx.id, patch }]);
    return ok(`Updated ${fx.type} on insert ${insert}.`);
  });

  tool('remove_effect', {
    title: 'Remove effect',
    description: 'Remove an effect from a mixer insert (its automations are removed too).',
    inputSchema: { projectId: projectIdArg, insert: z.number().int().min(0), effectId: z.string() },
    annotations: A.destructive
  }, async ({ projectId, insert, effectId }) => {
    const p = await load(projectId);
    const fx = findEffect(p, insert, effectId);
    await backend.applyOps(p.id, [{ type: 'effect/remove', index: insert, effectId: fx.id }]);
    return ok(`Removed ${fx.type} from insert ${insert}.`);
  });

  tool('move_effect', {
    title: 'Reorder effect',
    description: 'Move an effect to another slot in the insert chain (0 = first). Order matters: e.g. EQ → compressor → reverb.',
    inputSchema: { projectId: projectIdArg, insert: z.number().int().min(0), effectId: z.string(), position: z.number().int().min(0) },
    annotations: A.edit
  }, async ({ projectId, insert, effectId, position }) => {
    const p = await load(projectId);
    const fx = findEffect(p, insert, effectId);
    const slot = Math.min(position, p.mixer[insert].effects.length - 1);
    await backend.applyOps(p.id, [{ type: 'effect/move', index: insert, effectId: fx.id, position: slot }]);
    const chain = p.mixer[insert].effects.filter((e) => e.id !== fx.id);
    chain.splice(slot, 0, fx);
    return ok(`Moved ${fx.type} to slot ${slot} on insert ${insert}. Chain: ${chain.map((e) => e.type).join(' → ')}.`);
  });

  tool('render_mix', {
    title: 'Render & analyse the mix',
    description: `Render the song (or a pattern) in the user's browser and analyse it like a mastering engineer's meters: integrated loudness (LUFS), loudness range, sample and true peak, crest factor, clipping, master limiter gain reduction, spectral balance (sub/low/low-mid/mid/high-mid/high), the strongest low frequency, stereo width and low-end mono-ness, loudness per 4-bar section and (stems=true) per-channel loudness/spectrum/low-end note. target compares against a delivery standard and tells you exactly how much to change the master limiter's input gain. save=true also stores the WAV (24-bit by default) in the user's exports. Targets: ${Object.keys(MIX_TARGETS).join(', ')}. Needs the studio open in a browser.`,
    inputSchema: {
      projectId: projectIdArg,
      mode: z.enum(['song', 'pattern']).optional().describe('Default: song if the playlist has clips, else pattern'),
      pattern: z.string().optional().describe('For mode=pattern (default: first pattern)'),
      loops: z.number().int().min(1).max(16).optional().describe('Pattern mode: how many loops to render (default 2)'),
      stems: z.boolean().optional().describe('Also analyse each channel on its own (default true)'),
      target: z.enum(Object.keys(MIX_TARGETS)).optional().describe('Delivery target to compare against (default streaming)'),
      targetLufs: z.number().min(-30).max(-4).optional().describe('Custom integrated loudness target (overrides target)'),
      save: z.boolean().optional().describe('Keep the rendered WAV in exports (default false)'),
      bitDepth: z.union([z.literal(16), z.literal(24)]).optional().describe('WAV bit depth when saving (default 24; 16-bit is dithered)')
    },
    // not read-only: save=true writes a WAV into the user's exports
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ projectId, mode, pattern, loops = 2, stems = true, save = false, target = 'streaming', targetLufs, bitDepth = 24 }, extra) => {
    const p = await load(projectId);
    const m = mode || (p.playlist.clips.length ? 'song' : 'pattern');
    const patternId = pattern ? findPattern(p, pattern).id : p.patterns[0]?.id;
    const result = await backend.requestJob(
      { kind: 'render', projectId: p.id, mode: m, patternId, loops, stems, save, bitDepth, name: p.name, segmentBars: 4 },
      { projectId: p.id, timeoutMs: 240000, onProgress: progressNotifier(extra, 'Rendering in the browser') }
    );
    const goal = { ...MIX_TARGETS[target], ...(targetLufs !== undefined ? { lufs: targetLufs, label: `custom ${targetLufs} LUFS` } : {}) };
    return ok(formatMixReport(result, p, m, goal), { mix: compactAnalysis(result.mix), stems: result.stems, limiter: result.limiter || null, export: result.export || null });
  });

  tool('export_stems', {
    title: 'Export stems',
    description: "Render every channel that plays (and the audio clips) as its own WAV into the user's exports — the delivery a mixing/mastering engineer or a collaborator expects. Each stem keeps its channel, mixer insert, effects and sends (e.g. its reverb) but skips the master bus effects unless masterFx=true, so the stems sum back to the pre-master mix. Needs the studio open in a browser; takes a while for long songs (progress is reported).",
    inputSchema: {
      projectId: projectIdArg,
      mode: z.enum(['song', 'pattern']).optional().describe('Default: song if the playlist has clips, else pattern'),
      pattern: z.string().optional().describe('For mode=pattern (default: first pattern)'),
      loops: z.number().int().min(1).max(16).optional().describe('Pattern mode: loops to render (default 2)'),
      bitDepth: z.union([z.literal(16), z.literal(24)]).optional().describe('Default 24'),
      masterFx: z.boolean().optional().describe('Print the master bus effects (limiter…) on every stem (default false)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ projectId, mode, pattern, loops = 2, bitDepth = 24, masterFx = false }, extra) => {
    const p = await load(projectId);
    const m = mode || (p.playlist.clips.length ? 'song' : 'pattern');
    const patternId = pattern ? findPattern(p, pattern).id : p.patterns[0]?.id;
    const r = await backend.requestJob(
      { kind: 'export-stems', projectId: p.id, mode: m, patternId, loops, bitDepth, masterFx },
      { projectId: p.id, timeoutMs: 1800000, onProgress: progressNotifier(extra, 'Rendering stems in the browser') }
    );
    const files = r.files || [];
    const channelStems = files.filter((f) => f.stem !== 'Audio clips').length;
    const skipped = r.skipped?.length ? `\nOnly the first ${channelStems} channels were exported (the limit); skipped: ${r.skipped.join(', ')}.` : '';
    return ok(`${skipped ? skipped.trim() + '\n' : ''}Exported ${files.length} stems (${r.bitDepth || bitDepth}-bit WAV, ${r.mode || m}${masterFx ? ', with master effects' : ', without master bus effects'}) to the user's exports (Projects → Exports):\n${files.map((f) => `- ${f.name} (${Math.round(f.bytes / 1024)} KB): ${f.url}`).join('\n')}`, { files });
  });
}

/** MCP progress notifications (when the client asked for them) — keeps long renders from timing out. */
export function progressNotifier(extra, message) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return null;
  return (progress) => {
    extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round(progress * 100), total: 100, message } }).catch(() => {});
  };
}

function compactAnalysis(a) {
  if (!a) return null;
  const { onsets, summary: _summary, ...rest } = a;
  return { ...rest, onsetsPerSecond: onsets?.perSecond };
}

/** Human-readable mix report with engineering hints. `goal` = { lufs, truePeak, label } (see MIX_TARGETS). */
export function formatMixReport(r, p, mode, goal = MIX_TARGETS.streaming) {
  const a = r.mix;
  if (!a) return 'The browser returned no analysis.';
  const lines = [];
  const bar = ticksPerBar(p);
  lines.push(`MIX ANALYSIS — "${p.name}" (${mode}, ${a.duration}s${mode === 'song' ? `, ${Math.round(songLength(p) / bar)} bars` : ''})`);
  if (a.invalidSamples) {
    lines.push(`INVALID RENDER: ${a.invalidSamples} NaN/Infinity samples were produced (treated as silence), so the numbers below are unreliable. An instrument or effect setting is producing broken audio; check recent changes (extreme filter/feedback/drive values).`);
  }
  const tp = a.truePeakDb ?? a.peakDb;
  lines.push(`Loudness: ${a.lufs} LUFS integrated, short-term max ${a.shortTermMaxLufs ?? '–'} LUFS, loudness range ${a.loudnessRangeLu ?? '–'} LU, peak ${a.peakDb} dBFS, true peak ${tp} dBTP, crest ${a.crestDb} dB${a.clipping.samples ? `, CLIPPING ${a.clipping.samples} samples` : ''}`);
  const masterLimiter = p.mixer[0]?.effects.find((e) => e.type === 'limiter' && e.enabled);
  const masterDb = Math.round(20 * Math.log10(Math.max(1e-4, p.mixer[0].volume)) * 10) / 10;
  if (r.limiter) lines.push(`Master limiter: gain reduction avg ${r.limiter.avgDb} dB, max ${r.limiter.maxDb} dB, working ${r.limiter.activePercent}% of the time${masterLimiter ? ` (input gain ${masterLimiter.params.gain} dB, ceiling ${masterLimiter.params.ceiling} dB)` : ''}; master fader after it ${masterDb > 0 ? '+' : ''}${masterDb} dB`);
  if (goal && Number.isFinite(a.lufs) && a.lufs > -70) {
    const delta = Math.round((goal.lufs - a.lufs) * 10) / 10;
    let advice;
    const faderDb = Math.round(20 * Math.log10(Math.max(1e-4, p.mixer[0].volume)) * 10) / 10;
    if (Math.abs(delta) < 0.5) advice = 'on target';
    else if (!masterLimiter) advice = `${delta > 0 ? 'raise' : 'lower'} the level by ${Math.abs(delta)} dB (add a limiter to the master)`;
    else if (delta > 0 && faderDb < -0.5) {
      // the master fader sits after the limiter: give back its headroom first, then drive the limiter
      const restDelta = Math.round((delta + faderDb) * 10) / 10;
      const wanted = Math.round((masterLimiter.params.gain + Math.max(0, restDelta)) * 10) / 10;
      advice = `set the master fader to 0 dB (set_mixer insert 0 volumeDb 0, +${-faderDb} dB — it sits after the limiter and wastes headroom)${restDelta > 0.4 ? `, then raise the master limiter input gain by +${restDelta} dB (to ${Math.min(24, wanted)} dB)` : restDelta < -0.4 ? `, then lower the master fader again by ${-restDelta} dB` : ''}`;
    } else {
      const gain = masterLimiter.params.gain;
      const wanted = Math.round((gain + delta) * 10) / 10;
      if (wanted < 0) {
        // the limiter input gain can't go below 0 dB: the rest has to come off the master fader
        const rest = Math.round(-wanted * 10) / 10;
        advice = `${gain > 0 ? `set the master limiter input gain to 0 dB and ` : ''}lower the master fader by ${rest} dB (set_mixer insert 0 volumeDb ${Math.round((faderDb - rest) * 10) / 10}; it sits after the limiter, so the peaks drop with it)`;
      } else if (wanted > 24) {
        advice = `the limiter can only add 24 dB: raise channel/insert levels first (the mix is ${Math.abs(delta)} dB too quiet)`;
      } else {
        advice = `change the master limiter input gain by ${delta > 0 ? '+' : ''}${delta} dB (to ${wanted} dB)${delta > 0 && (r.limiter?.maxDb ?? 0) < -6 ? ' — but the limiter is already working hard: get there with mix balance/compression first' : ''}`;
      }
    }
    lines.push(`Target ${goal.label}: ${goal.lufs} LUFS, true peak ≤ ${goal.truePeak} dBTP → ${delta > 0 ? '+' : ''}${delta} dB: ${advice}`);
  }
  const b = a.spectrum.bandsPercent;
  lines.push(`Spectrum: sub ${b.sub}% · low ${b.low}% · low-mid ${b.lowMid}% · mid ${b.mid}% · high-mid ${b.highMid}% · high ${b.high}% (centroid ${a.spectrum.centroidHz} Hz, ${a.spectrum.brightness}${a.spectrum.lowPeakHz ? `; strongest low frequency ${a.spectrum.lowPeakHz} Hz ≈ ${a.spectrum.lowPeakNote}` : ''})`);
  if (a.stereo) lines.push(`Stereo: correlation ${a.stereo.correlation}, width ${a.stereo.width} (side/mid), low end (<150 Hz) width ${a.stereo.lowWidth ?? '–'}, L/R balance ${a.stereo.balanceDb} dB`);
  if (a.loudnessPerSegment?.lufs?.length) {
    lines.push(`Loudness per ${a.loudnessPerSegment.label || `${a.loudnessPerSegment.segmentSeconds}s`}: ${a.loudnessPerSegment.lufs.map((v, i) => `${i + 1}:${v}`).join('  ')}`);
  }
  if (r.stems?.length) {
    const where = [...new Set(r.stems.map((s) => s.tap).filter(Boolean))];
    lines.push(`Stems (loudest first; measured ${where.includes('solo render') ? 'by rendering each channel alone' : 'after each channel\'s own mixer insert, or its channel strip when it shares an insert — before the master bus'}):`);
    for (const s of [...r.stems].sort((x, y) => (y.lufs ?? -200) - (x.lufs ?? -200))) {
      const sb = s.bandsPercent || {};
      const dom = Object.entries(sb).sort((x, y) => y[1] - x[1])[0];
      const width = Number.isFinite(s.stereoWidth) ? `  width ${s.stereoWidth}` : '';
      const shared = s.tap === 'channel' ? '  (shares its insert)' : '';
      const low = s.lowPeakHz && (sb.sub || 0) + (sb.low || 0) > 30 ? `  low peak ${s.lowPeakHz} Hz (${s.lowPeakNote})` : '';
      lines.push(`  ${String(s.name).padEnd(14)} ${String(s.lufs).padStart(6)} LUFS  peak ${String(s.peakDb).padStart(6)} dBFS  centroid ${String(s.centroidHz).padStart(5)} Hz  mostly ${dom ? `${dom[0]} (${dom[1]}%)` : '–'}${low}${width}${shared}`);
    }
  }
  const hints = [];
  if (a.clipping.samples > 0 || a.peakDb > -0.1) hints.push('Peaks hit 0 dBFS: lower the master or add/raise a limiter ceiling below -0.3 dB.');
  else if (goal && tp > goal.truePeak) {
    // move from the current ceiling by the measured overshoot (a fixed suggestion could repeat forever)
    const over = Math.round((tp - goal.truePeak + 0.2) * 10) / 10;
    const fix = masterLimiter ? `lower the master limiter ceiling by ${over} dB (to ${Math.round((masterLimiter.params.ceiling - over) * 10) / 10} dB)` : `add a limiter to the master with a ${goal.truePeak - 0.3} dB ceiling`;
    hints.push(`True peak ${tp} dBTP is above ${goal.truePeak} dBTP: lossy encoding (MP3/AAC/Opus) will clip — ${fix}${masterDb > 0 ? ' and set the master fader to 0 dB' : ''}.`);
  }
  if (r.limiter && r.limiter.maxDb < -8) hints.push(`The master limiter is squashing up to ${-r.limiter.maxDb} dB: transients will sound flat. Lower its input gain and get loudness from balance, saturation or bus compression instead.`);
  if (a.stereo && a.stereo.lowWidth > 0.3) hints.push(`The low end (<150 Hz) is wide (side/mid ${a.stereo.lowWidth}): it will cancel in mono and on club systems. Put a stereo effect with monoBelow ≈ 120 Hz on the bass/808/pad inserts, or remove stereo wideners/chorus from them.`);
  if (a.loudnessRangeLu !== null && a.loudnessRangeLu !== undefined && mode === 'song' && a.loudnessRangeLu < 2 && a.duration > 30) hints.push(`Loudness range is only ${a.loudnessRangeLu} LU: the song has almost no dynamics between sections.`);
  const lowStems = (r.stems || []).filter((s) => s.lowPeakHz && (s.bandsPercent?.sub || 0) + (s.bandsPercent?.low || 0) > 50 && s.lufs > -40);
  for (let i = 0; i < lowStems.length; i++) {
    for (let j = i + 1; j < lowStems.length; j++) {
      const x = lowStems[i]; const y = lowStems[j];
      const semis = Math.abs(12 * Math.log2(x.lowPeakHz / y.lowPeakHz));
      if (semis < 2) hints.push(`"${x.name}" (${x.lowPeakHz} Hz) and "${y.name}" (${y.lowPeakHz} Hz) peak at nearly the same low frequency: they mask each other. Tune one away (analyze_sound helps), sidechain the bass to the kick (pump with source), or EQ a dip.`);
    }
  }
  if (a.lufs < -20 && (!goal || goal.lufs > -20)) hints.push('Quiet overall: raise the limiter input gain or the master fader (see Target above).');
  else if (a.lufs > -7 && (!goal || goal.lufs < -7)) hints.push('Very loud: risk of over-compression/distortion; consider backing off the limiter.');
  if (a.crestDb < 6) hints.push('Low crest factor: the mix is heavily compressed/limited and may sound flat.');
  // spectral power share: bass-forward genres legitimately put ~70% of the power below 250 Hz
  const bassy = /hip-hop|club|edm/i.test(goal?.label || '') ? 75 : 62;
  if (b.sub + b.low > bassy) hints.push('Bass-heavy: check 808/bass vs kick levels, or high-pass non-bass channels.');
  if (b.lowMid > 25) hints.push('Muddy low-mids (250–500 Hz): EQ-cut pads/keys/bass around 300 Hz.');
  if (b.highMid + b.high < 6) hints.push('Dull top end: brighten hats/cymbals or add a high shelf.');
  if (b.highMid + b.high > 40) hints.push('Bright/harsh: tame hats, cymbals or bright synths (EQ high-mid cut).');
  if (a.stereo && a.stereo.correlation < 0.2) hints.push('Low stereo correlation: possible phase problems, check mono compatibility (stereo width effects).');
  if (a.stereo && a.stereo.width < 0.05) hints.push('Nearly mono mix: pan elements or add chorus/stereo width on pads and leads.');
  const seg = a.loudnessPerSegment?.lufs?.filter((v) => v > -60) || [];
  if (mode === 'song' && seg.length >= 3 && Math.max(...seg) - Math.min(...seg) < 3) hints.push('Little loudness contrast between sections: vary arrangement/energy (drops, breakdowns, fills).');
  if (hints.length) lines.push(`Hints:\n- ${hints.join('\n- ')}`);
  if (r.export?.url) lines.push(`Saved WAV: ${r.export.url}`);
  return lines.join('\n');
}
