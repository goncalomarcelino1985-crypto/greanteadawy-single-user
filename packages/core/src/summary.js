// Text summary of a project, so Claude can "see" the beat it is working on.
import { STEP, ticksPerBar, stepsPerBeat } from './constants.js';
import { patternLength, songLength } from './model.js';
import { toStepString, isStepLike, formatNoteList } from './notation.js';
import { INSTRUMENTS } from './instruments.js';
import { EFFECTS } from './effects.js';
import { isSpatialObject } from './spatial.js';

const r2 = (x) => Math.round(x * 100) / 100;

export function summarizeProject(project, { notes = true, maxNotes = 64 } = {}) {
  const bar = ticksPerBar(project);
  const lines = [];
  const songBars = r2(songLength(project) / bar);
  lines.push(`PROJECT "${project.name}" [${project.id}] — ${project.bpm} BPM, ${project.timeSig.join('/')}, swing ${Math.round(project.swing * 100)}%, key ${project.key} ${project.scale}, song length ${songBars} bars`);
  lines.push('');
  lines.push(`CHANNELS (${project.channels.length}) — "x" = hit, "X" = accent, "o" = ghost, "-" = rest:`);
  project.channels.forEach((c, i) => {
    const flags = [
      c.mute && 'MUTED', c.solo && 'SOLO', c.chokeGroup && `choke ${c.chokeGroup}`,
      c.nudge && `nudge ${c.nudge > 0 ? '+' : ''}${r2(c.nudge)}ms`, c.swingMix !== undefined && c.swingMix !== 1 && `swing ×${r2(c.swingMix)}`
    ].filter(Boolean).join(', ');
    const sample = c.instrument.kind === 'sampler' ? ` sample=${c.instrument.params.sampleId || 'none'}` : c.instrument.kind === 'plugin' ? ` plugin=${c.instrument.plugin || 'missing'}` : '';
    lines.push(`  ${i}. ${c.name} [${c.id}] ${c.instrument.kind}/${c.instrument.preset}${sample} → mixer ${c.mixerTrack}, vol ${r2(c.volume)}, pan ${r2(c.pan)}${c.pitch ? `, pitch ${c.pitch}st` : ''}${flags ? ` (${flags})` : ''}`);
  });
  lines.push('');
  lines.push(`PATTERNS (${project.patterns.length}):`);
  for (const p of project.patterns) {
    const len = patternLength(project, p);
    const steps = Math.round(len / STEP);
    lines.push(`  "${p.name}" [${p.id}] — ${r2(len / bar)} bar(s) / ${steps} steps`);
    if (!notes) continue;
    for (const c of project.channels) {
      const list = p.notes[c.id];
      if (!list?.length) continue;
      const melodic = INSTRUMENTS[c.instrument.kind]?.melodic;
      if (!melodic && isStepLike(list)) {
        lines.push(`    ${c.name.padEnd(12)} ${toStepString(list, steps, { barSteps: Math.round(bar / STEP), group: stepsPerBeat(project) })}`);
      } else {
        const shown = list.slice(0, maxNotes);
        lines.push(`    ${c.name.padEnd(12)} ${list.length} notes (note@step+lengthSteps): ${formatNoteList(shown)}${list.length > maxNotes ? ` … +${list.length - maxNotes} more` : ''}`);
      }
    }
  }
  lines.push('');
  const clips = [...project.playlist.clips].sort((a, b) => a.track - b.track || a.start - b.start);
  lines.push(`PLAYLIST (${clips.length} clips${clips.length ? '' : ' — empty; use place_pattern/arrange_song for song mode'}):`);
  const byTrack = new Map();
  for (const c of clips) {
    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track).push(c);
  }
  for (const [t, list] of byTrack) {
    const track = project.playlist.tracks[t];
    const items = list.map((c) => {
      let name = c.refId;
      if (c.kind === 'pattern') name = project.patterns.find((p) => p.id === c.refId)?.name || c.refId;
      if (c.kind === 'automation') name = `auto:${project.automations.find((a) => a.id === c.refId)?.name || c.refId}`;
      if (c.kind === 'audio') {
        const extra = [
          c.gain !== undefined && c.gain !== 1 && `${r2(20 * Math.log10(Math.max(1e-4, c.gain)))} dB`,
          c.rate !== undefined && c.rate !== 1 && `rate ×${c.rate}`,
          c.fadeIn && `fade in ${r2(c.fadeIn / STEP)} steps`, c.fadeOut && `fade out ${r2(c.fadeOut / STEP)} steps`
        ].filter(Boolean);
        name = `audio:${c.refId}${extra.length ? ` (${extra.join(', ')})` : ''}`;
      }
      const whole = c.start % bar === 0 && c.length % bar === 0;
      const where = whole
        ? (c.length === bar ? `bar ${c.start / bar + 1}` : `bars ${c.start / bar + 1}–${(c.start + c.length) / bar}`)
        : `at bar ${r2(c.start / bar) + 1} for ${r2(c.length / bar)} bars`;
      return `${name} ${where}${c.mute ? ' (muted)' : ''} [${c.id}]`;
    });
    lines.push(`  Track ${t + 1}${track?.name && track.name !== `Track ${t + 1}` ? ` "${track.name}"` : ''}${track?.mute ? ' (MUTED)' : ''}: ${items.join('; ')}`);
  }
  if (project.markers?.length) {
    lines.push(`MARKERS: ${project.markers.map((m) => `${m.name} @ bar ${r2(m.tick / bar) + 1} [${m.id}]`).join(' · ')}`);
  }
  lines.push('');
  const sp = project.spatial;
  lines.push(sp?.enabled
    ? `MIXER — spatial (3D) mix ON, monitoring ${sp.monitor}; 3D objects (x -1 left…1 right, y -1 back…1 front, z 0 ear…1 ceiling) are marked "3D", the rest is the stereo bed:`
    : 'MIXER (inserts with routing, non-default settings or effects):');
  project.mixer.forEach((m, i) => {
    const used = project.channels.filter((c) => c.mixerTrack === i).map((c) => c.name);
    const obj = m.spatial?.enabled ? ` 3D(${r2(m.spatial.x)}, ${r2(m.spatial.y)}, ${r2(m.spatial.z)}${m.spatial.lfe ? `, lfe ${r2(m.spatial.lfe)}` : ''}${isSpatialObject(project, i) ? '' : sp?.enabled ? ', inactive: routed to a bus' : ', inactive: spatial mix off'})` : '';
    const changed = m.effects.length || m.volume !== 0.8 || m.pan !== 0 || m.mute || m.sends?.length || used.length || i === 0 || obj;
    if (!changed) return;
    const val = (k, v) => (typeof v === 'number' ? r2(v) : k === 'source' ? `"${project.channels.find((c) => c.id === v)?.name || v}"` : v);
    const fx = m.effects.map((e) => `${e.type}${e.type === 'plugin' ? `(${e.plugin || 'missing'})` : ''}${e.enabled ? '' : '(off)'}[${e.id}]{${Object.entries(e.params).filter(([, v]) => v !== null).map(([k, v]) => `${k}:${val(k, v)}`).join(',')}}`);
    lines.push(`  ${i}. ${m.name}: vol ${r2(m.volume)}, pan ${r2(m.pan)}${obj}${m.mute ? ', MUTED' : ''}${i ? `, out→${m.output}` : ''}${m.sends?.length ? `, sends ${m.sends.map((s) => `${s.to}@${r2(s.amount)}`).join(' ')}` : ''}${used.length ? `, channels: ${used.join(', ')}` : ''}${fx.length ? `\n      fx: ${fx.join(' → ')}` : ''}`);
  });
  if (project.automations.length) {
    lines.push('');
    lines.push('AUTOMATIONS:');
    for (const a of project.automations) {
      lines.push(`  ${a.name} [${a.id}] target ${JSON.stringify(a.target)} length ${r2(a.length / bar)} bars, ${a.points.length} points`);
    }
  }
  return lines.join('\n');
}

export function describeEffectShort(fx) {
  return `${EFFECTS[fx.type]?.label || fx.type}`;
}
