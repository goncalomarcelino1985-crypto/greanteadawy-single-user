// Playlist arrangement, tracks, automation, transport and MIDI export.
import { STEP, ticksPerBar, uid, findChannel, findPattern, findAutomation, patternLength, songLength, MAX_TRACKS } from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, pickTrack, findEffect, barsOf } from '../util.js';
import { requirePlugin } from './plugins.js';

export function registerArrangeTools({ tool, backend, load, resolveProjectId }) {
  tool('place_pattern', {
    title: 'Place pattern in playlist',
    description: 'Put a pattern clip in the playlist (song arrangement). The clip loops the pattern for `bars` bars.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      startBar: z.number().min(1).describe('1-based bar where the clip starts (fractions allowed, e.g. 4.5)'),
      bars: z.number().positive().optional().describe('Clip length in bars (default: pattern length)'),
      track: z.number().int().min(1).max(MAX_TRACKS).optional().describe('1-based playlist track (default: the track this pattern already uses, else first empty track)'),
      repeat: z.number().int().min(1).max(64).optional().describe('Place this many consecutive copies (default 1)')
    },
    annotations: A.edit
  }, async ({ projectId, pattern, startBar, bars, track, repeat = 1 }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const bar = ticksPerBar(p);
    const t = track ? track - 1 : pickTrack(p, pt.id);
    const length = bars ? Math.round(bars * bar) : patternLength(p, pt);
    const start = Math.round((startBar - 1) * bar);
    const clips = Array.from({ length: repeat }, (_, i) => ({ id: uid('clip'), kind: 'pattern', refId: pt.id, track: t, start: start + i * length, length }));
    await backend.applyOps(p.id, [{ type: 'clip/add', clips }]);
    return ok(`Placed "${pt.name}" on track ${t + 1} at bar ${startBar}${repeat > 1 ? ` ×${repeat}` : ''} (${barsOf(p, length)} bars each) [${clips.map((c) => c.id).join(', ')}].`);
  });

  tool('arrange_song', {
    title: 'Arrange song',
    description: 'Build the playlist from consecutive sections, e.g. [{"name":"Intro","bars":4,"patterns":["Chords"]},{"name":"Hook","bars":8,"patterns":["Drums","808","Chords","Melody"]}]. Each pattern gets its own track (named after it) and loops for the section. Named sections become markers above the playlist (find them later in get_project). By default replaces existing pattern clips and markers (audio/automation clips are kept).',
    inputSchema: {
      projectId: projectIdArg,
      sections: z.array(z.object({
        name: z.string().optional(),
        bars: z.number().positive(),
        patterns: z.array(z.string()).describe('Pattern names/ids playing in this section')
      })).min(1).max(64),
      clear: z.boolean().optional().describe('Remove existing pattern clips first (default true)'),
      startBar: z.number().min(1).optional().describe('Where the first section starts (default 1)')
    },
    annotations: A.edit
  }, async ({ projectId, sections, clear = true, startBar = 1 }) => {
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    const ops = [];
    if (clear) {
      const ids = p.playlist.clips.filter((c) => c.kind === 'pattern').map((c) => c.id);
      if (ids.length) ops.push({ type: 'clip/remove', ids });
      if (p.markers?.length) ops.push({ type: 'marker/remove', ids: p.markers.map((m) => m.id) });
    }
    const markers = [];
    const trackOf = new Map();
    const remaining = clear ? p.playlist.clips.filter((c) => c.kind !== 'pattern') : p.playlist.clips;
    const usedTracks = new Set(remaining.map((c) => c.track));
    if (!clear) for (const c of p.playlist.clips) if (c.kind === 'pattern' && !trackOf.has(c.refId)) trackOf.set(c.refId, c.track);
    let nextTrack = 0;
    const clips = [];
    let pos = Math.round((startBar - 1) * bar);
    const lines = [];
    for (const s of sections) {
      const len = Math.round(s.bars * bar);
      for (const ref of s.patterns) {
        const pt = findPattern(p, ref);
        if (!trackOf.has(pt.id)) {
          while (usedTracks.has(nextTrack)) nextTrack++;
          trackOf.set(pt.id, nextTrack);
          usedTracks.add(nextTrack);
        }
        clips.push({ id: uid('clip'), kind: 'pattern', refId: pt.id, track: trackOf.get(pt.id), start: pos, length: len });
      }
      const whole = pos % bar === 0 && len % bar === 0;
      const where = whole ? `bars ${pos / bar + 1}–${(pos + len) / bar}` : `bar ${barsOf(p, pos) + 1} (+${barsOf(p, len)} bars)`;
      lines.push(`${where}: ${s.name ? `${s.name} — ` : ''}${s.patterns.join(', ') || '(silence)'}`);
      if (s.name) markers.push({ id: uid('mk'), tick: pos, name: s.name.slice(0, 64) });
      pos += len;
    }
    if (clips.length) ops.push({ type: 'clip/add', clips });
    if (markers.length) ops.push({ type: 'marker/add', markers });
    for (const [pid, t] of trackOf) {
      const name = p.patterns.find((x) => x.id === pid)?.name;
      // clip/add (applied first) creates any missing tracks, so tracks past the current count can be named too
      if (name) ops.push({ type: 'track/update', index: t, patch: { name } });
    }
    await backend.applyOps(p.id, ops);
    const ids = clips.length <= 40 ? `\nClip ids: ${clips.map((c) => c.id).join(', ')}` : '\n(Clip ids: see get_project.)';
    return ok(`Arranged ${sections.length} sections, ${clips.length} clips, ${Math.round(pos / bar)} bars total:\n${lines.join('\n')}${ids}`);
  });

  tool('update_clips', {
    title: 'Move / resize clips',
    description: 'Edit playlist clips by id (ids are shown by get_project): move (startBar, track), resize (bars), trim the start (offsetBars), mute; audio clips also take gainDb, fadeInSteps/fadeOutSteps and rate (1 = original speed; project bpm ÷ loop bpm repitches a loop to the project tempo).',
    inputSchema: {
      projectId: projectIdArg,
      clips: z.array(z.object({
        clipId: z.string(),
        startBar: z.number().min(1).optional(),
        bars: z.number().positive().optional(),
        track: z.number().int().min(1).max(MAX_TRACKS).optional(),
        offsetBars: z.number().min(0).optional().describe('Start playing this far into the pattern/audio'),
        mute: z.boolean().optional(),
        gainDb: z.number().min(-60).max(12).optional().describe('Audio clips: clip gain in dB'),
        fadeInSteps: z.number().min(0).optional().describe('Audio clips: fade-in length in steps'),
        fadeOutSteps: z.number().min(0).optional().describe('Audio clips: fade-out length in steps'),
        rate: z.number().min(0.25).max(4).optional().describe('Audio clips: playback speed (changes pitch too, like a turntable)')
      })).min(1).max(500)
    },
    annotations: A.edit
  }, async ({ projectId, clips }) => {
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    const ids = new Set(p.playlist.clips.map((c) => c.id));
    const missing = clips.filter((c) => !ids.has(c.clipId)).map((c) => c.clipId);
    if (missing.length) throw new Error(`Unknown clip id(s): ${missing.slice(0, 5).join(', ')}`);
    const audioOnly = clips.filter((c) => ['gainDb', 'fadeInSteps', 'fadeOutSteps', 'rate'].some((k) => c[k] !== undefined) && p.playlist.clips.find((x) => x.id === c.clipId)?.kind !== 'audio');
    if (audioOnly.length) throw new Error(`gainDb, fades and rate only apply to audio clips (not ${audioOnly.map((c) => c.clipId).slice(0, 3).join(', ')})`);
    const upd = clips.map((c) => ({
      id: c.clipId,
      ...(c.startBar !== undefined && { start: Math.round((c.startBar - 1) * bar) }),
      ...(c.bars !== undefined && { length: Math.max(1, Math.round(c.bars * bar)) }),
      ...(c.track !== undefined && { track: c.track - 1 }),
      ...(c.offsetBars !== undefined && { offset: Math.round(c.offsetBars * bar) }),
      ...(c.mute !== undefined && { mute: c.mute }),
      ...(c.gainDb !== undefined && { gain: Math.pow(10, c.gainDb / 20) }),
      ...(c.fadeInSteps !== undefined && { fadeIn: Math.round(c.fadeInSteps * STEP) }),
      ...(c.fadeOutSteps !== undefined && { fadeOut: Math.round(c.fadeOutSteps * STEP) }),
      ...(c.rate !== undefined && { rate: c.rate })
    }));
    const maxTrack = Math.max(...upd.map((u) => u.track ?? 0));
    const ops = [];
    if (maxTrack >= p.playlist.tracks.length) ops.push({ type: 'track/add', count: maxTrack - p.playlist.tracks.length + 1 });
    ops.push({ type: 'clip/update', clips: upd });
    await backend.applyOps(p.id, ops);
    return ok(`Updated ${upd.length} clip(s).`);
  });

  tool('set_markers', {
    title: 'Add / rename / remove song markers',
    description: 'Markers name positions in the song (section starts like "Verse 1", "Hook", "Drop") and show above the playlist; get_project lists them. arrange_song creates them for named sections. add: markers to add; remove: marker ids or names to delete; clear=true removes all first.',
    inputSchema: {
      projectId: projectIdArg,
      add: z.array(z.object({ bar: z.number().min(1).describe('1-based bar (fractions allowed)'), name: z.string().min(1).max(64) })).max(64).optional(),
      remove: z.array(z.string()).optional().describe('Marker ids or names'),
      clear: z.boolean().optional()
    },
    annotations: A.edit
  }, async ({ projectId, add = [], remove = [], clear = false }) => {
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    const existing = p.markers || [];
    const ops = [];
    let gone = [];
    if (clear) gone = existing;
    else if (remove.length) {
      gone = remove.map((ref) => {
        const m = existing.find((x) => x.id === ref) || existing.find((x) => x.name.toLowerCase() === String(ref).toLowerCase());
        if (!m) throw new Error(`Marker "${ref}" not found. Markers: ${existing.map((x) => `${x.name} [${x.id}]`).join(', ') || 'none'}`);
        return m;
      });
    }
    if (gone.length) ops.push({ type: 'marker/remove', ids: gone.map((m) => m.id) });
    const kept = existing.filter((m) => !gone.includes(m));
    // adding a marker that already exists (same name at the same position) is a no-op
    const added = add.map((m) => ({ id: uid('mk'), tick: Math.round((m.bar - 1) * bar), name: m.name }))
      .filter((m, i, all) => !kept.some((k) => k.tick === m.tick && k.name.toLowerCase() === m.name.toLowerCase())
        && all.findIndex((x) => x.tick === m.tick && x.name.toLowerCase() === m.name.toLowerCase()) === i);
    if (added.length) ops.push({ type: 'marker/add', markers: added });
    if (!ops.length && !add.length) throw new Error('Nothing to do: pass add, remove or clear');
    if (!ops.length) return ok(`Markers unchanged: ${existing.map((m) => `${m.name} @ bar ${barsOf(p, m.tick) + 1} [${m.id}]`).join(' · ')}.`);
    const after = await backend.applyOps(p.id, ops);
    return ok(`Markers: ${(after.markers || []).map((m) => `${m.name} @ bar ${barsOf(after, m.tick) + 1} [${m.id}]`).join(' · ') || 'none'}.`);
  });

  tool('remove_clips', {
    title: 'Remove playlist clips',
    description: 'Remove clips from the playlist. Filters combine (AND): clipIds, pattern, track, and a bar range (clips that START in bars fromBar..toBar, both inclusive). all=true removes every clip and cannot be combined with filters.',
    inputSchema: {
      projectId: projectIdArg,
      clipIds: z.array(z.string()).optional(),
      pattern: z.string().optional(),
      track: z.number().int().min(1).max(MAX_TRACKS).optional(),
      fromBar: z.number().int().min(1).optional().describe('First bar of the range (inclusive)'),
      toBar: z.number().int().min(1).optional().describe('Last bar of the range (inclusive)'),
      all: z.boolean().optional()
    },
    annotations: A.destructive
  }, async ({ projectId, clipIds, pattern, track, fromBar, toBar, all }) => {
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    let list = p.playlist.clips;
    const filtered = clipIds || pattern || track || fromBar !== undefined || toBar !== undefined;
    if (fromBar !== undefined && toBar !== undefined && toBar < fromBar) throw new Error('toBar must not be before fromBar');
    if (all && filtered) throw new Error('all=true removes every clip — leave out the other filters, or drop all to remove only the matching clips');
    if (!all) {
      if (!filtered) throw new Error('Say which clips: clipIds, pattern, track, a bar range, or all=true');
      if (clipIds) { const s = new Set(clipIds); list = list.filter((c) => s.has(c.id)); }
      if (pattern) { const pt = findPattern(p, pattern); list = list.filter((c) => c.kind === 'pattern' && c.refId === pt.id); }
      if (track) list = list.filter((c) => c.track === track - 1);
      if (fromBar !== undefined) list = list.filter((c) => c.start >= (fromBar - 1) * bar);
      if (toBar !== undefined) list = list.filter((c) => c.start < toBar * bar);
    }
    if (!list.length) return ok('No clips matched.');
    await backend.applyOps(p.id, [{ type: 'clip/remove', ids: list.map((c) => c.id) }]);
    return ok(`Removed ${list.length} clip(s).`);
  });

  tool('copy_bars', {
    title: 'Copy a section of the song',
    description: 'Copy a section of the arrangement — everything playing in bars fromBar..toBar (both inclusive) — to another position, e.g. repeat the hook (bars 9–16) at bar 33. Clips are cut to the range, so long clips copy only the part inside it. Clips keep their tracks.',
    inputSchema: {
      projectId: projectIdArg,
      fromBar: z.number().int().min(1).describe('First bar to copy'),
      toBar: z.number().int().min(1).describe('Last bar to copy (inclusive)'),
      toPosition: z.number().int().min(1).describe('Bar where the copy starts'),
      times: z.number().int().min(1).max(32).optional().describe('Number of copies placed back to back (default 1)')
    },
    annotations: A.edit
  }, async ({ projectId, fromBar, toBar, toPosition, times = 1 }) => {
    if (toBar < fromBar) throw new Error('toBar must not be before fromBar');
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    const lo = (fromBar - 1) * bar;
    const hi = toBar * bar;
    const src = p.playlist.clips.filter((c) => c.start < hi && c.start + c.length > lo);
    if (!src.length) throw new Error(`Nothing plays in bars ${fromBar}–${toBar}`);
    const span = hi - lo;
    const target = (toPosition - 1) * bar;
    if (target < hi && target + span * times > lo) throw new Error('The copy would overlap the bars being copied — choose a position after them');
    const clips = [];
    for (let k = 0; k < times; k++) {
      const delta = target - lo + k * span;
      for (const c of src) {
        const s = Math.max(c.start, lo);
        const e = Math.min(c.start + c.length, hi);
        clips.push({ ...c, id: uid('clip'), start: s + delta, length: e - s, offset: c.offset + (s - c.start) });
      }
    }
    await backend.applyOps(p.id, [{ type: 'clip/add', clips }]);
    return ok(`Copied bars ${fromBar}–${toBar} (${src.length} clip(s)) to bar ${toPosition}${times > 1 ? ` ×${times}` : ''}. New clip ids: ${clips.map((c) => c.id).join(', ')}`);
  });

  tool('update_track', {
    title: 'Update playlist track',
    description: 'Rename, recolor or mute a playlist track (1-based).',
    inputSchema: {
      projectId: projectIdArg,
      track: z.number().int().min(1).max(MAX_TRACKS),
      name: z.string().min(1).max(64).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      mute: z.boolean().optional()
    },
    annotations: A.edit
  }, async ({ projectId, track, name, color, mute }) => {
    if (name === undefined && color === undefined && mute === undefined) throw new Error('Nothing to update: pass name, color and/or mute.');
    const p = await load(projectId);
    const ops = [];
    if (track > p.playlist.tracks.length) ops.push({ type: 'track/add', count: track - p.playlist.tracks.length });
    const patch = {};
    if (name) patch.name = name;
    if (color) patch.color = color;
    if (mute !== undefined) patch.mute = mute;
    ops.push({ type: 'track/update', index: track - 1, patch });
    await backend.applyOps(p.id, ops);
    return ok(`Track ${track} updated.`);
  });

  // ---------------------------------------------------------------- automation
  tool('add_automation', {
    title: 'Add automation clip',
    description: 'Automate a parameter over time with an automation clip in the playlist (song mode). Targets: channel (volume|pan|pitch|filterCutoff|filterRes), mixer insert (volume|pan), effect (automatable param, e.g. filter cutoff, reverb mix, delay feedback), master (volume|pan). Point values are 0..1 across the parameter range (filterCutoff is log-scaled: 0 = 20 Hz, 0.5 ≈ 630 Hz, 1 = 20 kHz; pan 0.5 = center; pitch 0.5 = no shift; volume: 0.8 = unity gain (0 dB), 0.64 = the default insert fader, 0.62 ≈ the default channel volume, 1 = +1.9 dB).',
    inputSchema: {
      projectId: projectIdArg,
      name: z.string().max(64).optional(),
      target: z.object({
        type: z.enum(['channel', 'mixer', 'effect', 'master']),
        channel: z.string().optional().describe('For type=channel: channel id or name'),
        insert: z.number().int().min(0).optional().describe('For type=mixer/effect'),
        effectId: z.string().optional().describe('For type=effect: effect id (or type)'),
        param: z.string()
      }),
      points: z.array(z.object({ bar: z.number().min(0).describe('Position in bars from the clip start (0-based, fractional ok)'), value: z.number().min(0).max(1) })).min(1).max(512),
      startBar: z.number().min(1).describe('1-based bar where the automation clip starts'),
      bars: z.number().positive().optional().describe('Clip length in bars (default: up to the last point)'),
      track: z.number().int().min(1).max(MAX_TRACKS).optional()
    },
    annotations: A.edit
  }, async ({ projectId, name, target, points, startBar, bars, track }) => {
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    let t;
    if (target.type === 'channel') t = { type: 'channel', id: findChannel(p, target.channel).id, param: target.param };
    else if (target.type === 'mixer') t = { type: 'mixer', index: target.insert, param: target.param };
    else if (target.type === 'effect') {
      const fx = findEffect(p, target.insert, target.effectId);
      if (fx.type === 'plugin') {
        // only a plugin's automatable number params are AudioParams the engine can move
        const m = await requirePlugin(backend, fx.plugin, 'effect');
        const auto = m.params.filter((d) => d.type === 'number' && d.automatable).map((d) => d.key);
        if (!auto.includes(target.param)) throw new Error(`"${target.param}" of ${m.name} can't be automated. Automatable: ${auto.join(', ') || 'none'}`);
      }
      t = { type: 'effect', index: target.insert, effectId: fx.id, param: target.param };
    }
    else t = { type: 'master', param: target.param };
    const pts = points.map((pt) => ({ t: Math.round(pt.bar * bar), v: pt.value })).sort((a, b) => a.t - b.t);
    const length = Math.max(STEP, bars ? Math.round(bars * bar) : pts[pts.length - 1].t || bar);
    if (pts[pts.length - 1].t > length) throw new Error(`A point at bar ${pts[pts.length - 1].t / bar} lies beyond the clip length (${bars} bars) — lengthen bars or move the point`);
    const id = uid('auto');
    const clipId = uid('clip');
    const autoName = name || `${target.type} ${target.param}`;
    const trk = track ? track - 1 : pickTrack(p, id);
    const ops = [];
    if (trk >= p.playlist.tracks.length) ops.push({ type: 'track/add', count: trk - p.playlist.tracks.length + 1 });
    ops.push(
      { type: 'automation/add', automation: { id, name: autoName, target: t, length, points: pts } },
      { type: 'clip/add', clips: [{ id: clipId, kind: 'automation', refId: id, track: trk, start: Math.round((startBar - 1) * bar), length }] }
    );
    await backend.applyOps(p.id, ops);
    return ok(`Added automation "${autoName}" [${id}] as clip [${clipId}] on track ${trk + 1} from bar ${startBar} (${barsOf(p, length)} bars).`);
  });

  tool('update_automation', {
    title: 'Update automation',
    description: 'Change an automation curve (points replace the old ones), its length or name. Changing bars also resizes its playlist clips that were the full automation length.',
    inputSchema: {
      projectId: projectIdArg,
      automation: z.string().describe('Automation id or name'),
      name: z.string().max(64).optional(),
      points: z.array(z.object({ bar: z.number().min(0), value: z.number().min(0).max(1) })).min(1).max(512).optional(),
      bars: z.number().positive().optional()
    },
    annotations: A.edit
  }, async ({ projectId, automation, name, points, bars }) => {
    const p = await load(projectId);
    const a = findAutomation(p, automation);
    const bar = ticksPerBar(p);
    const patch = {};
    if (name) patch.name = name;
    if (bars) patch.length = Math.round(bars * bar);
    if (points) patch.points = points.map((pt) => ({ t: Math.round(pt.bar * bar), v: pt.value }));
    if (!Object.keys(patch).length) throw new Error('Nothing to change');
    const newLen = patch.length ?? a.length;
    const last = patch.points ? Math.max(...patch.points.map((x) => x.t)) : Math.max(...a.points.map((x) => x.t));
    if (last > newLen) throw new Error(`A point at bar ${last / bar} lies beyond the automation length (${newLen / bar} bars)`);
    const ops = [{ type: 'automation/update', id: a.id, patch }];
    if (patch.length) {
      const resize = p.playlist.clips.filter((c) => c.kind === 'automation' && c.refId === a.id && c.length === a.length);
      if (resize.length) ops.push({ type: 'clip/update', clips: resize.map((c) => ({ id: c.id, length: patch.length })) });
    }
    await backend.applyOps(p.id, ops);
    return ok(`Updated automation "${name || a.name}".`);
  });

  tool('remove_automation', {
    title: 'Remove automation',
    description: 'Delete an automation and its playlist clips.',
    inputSchema: { projectId: projectIdArg, automation: z.string() },
    annotations: A.destructive
  }, async ({ projectId, automation }) => {
    const p = await load(projectId);
    const a = findAutomation(p, automation);
    await backend.applyOps(p.id, [{ type: 'automation/remove', id: a.id }]);
    return ok(`Removed automation "${a.name}".`);
  });

  // ---------------------------------------------------------------- transport / export
  tool('play', {
    title: 'Play',
    description: "Start playback in the user's browser. mode \"pattern\" loops one pattern; mode \"song\" plays the playlist arrangement.",
    inputSchema: {
      projectId: projectIdArg,
      mode: z.enum(['pattern', 'song']).optional().describe('Default: song if the playlist has clips, else pattern'),
      pattern: z.string().optional().describe('Pattern to loop in pattern mode (default: first pattern)'),
      fromBar: z.number().min(1).optional()
    },
    annotations: A.edit
  }, async ({ projectId, mode, pattern, fromBar = 1 }) => {
    const p = await load(projectId);
    const m = mode || (p.playlist.clips.length ? 'song' : 'pattern');
    const pt = pattern ? findPattern(p, pattern) : p.patterns[0];
    const n = await backend.transport(p.id, { action: 'play', mode: m, patternId: pt?.id, position: Math.round((fromBar - 1) * ticksPerBar(p)) });
    if (!n) return ok('No browser has this project open, so nothing is playing. Ask the user to open GreanTeaDawy in their browser (and click once to enable audio).');
    return ok(`Playing ${m === 'song' ? `song (${Math.round(songLength(p) / ticksPerBar(p))} bars)` : `pattern "${pt.name}" (looping)`} in ${n} browser tab(s). Note: browsers need one user click before audio can start.`);
  });

  tool('stop', {
    title: 'Stop',
    description: 'Stop playback in the browser.',
    inputSchema: { projectId: projectIdArg },
    annotations: A.edit
  }, async ({ projectId }) => {
    const id = await resolveProjectId(projectId);
    await backend.transport(id, { action: 'stop' });
    return ok('Stopped.');
  });

  tool('export_midi', {
    title: 'Export MIDI',
    description: 'Export the song (or one pattern) as a .mid file into the user\'s exports. Returns a download URL. For audio use render_mix with save=true.',
    inputSchema: { projectId: projectIdArg, mode: z.enum(['song', 'pattern']).optional(), pattern: z.string().optional() },
    annotations: { ...A.edit, idempotentHint: true }
  }, async ({ projectId, mode = 'song', pattern }) => {
    const p = await load(projectId);
    const patternId = pattern ? findPattern(p, pattern).id : undefined;
    const res = await backend.exportMidi(p.id, { mode, patternId });
    return ok(`Exported MIDI "${res.name}" (${res.bytes} bytes).${res.url ? `\nDownload: ${res.url}` : ''}`);
  });

}
