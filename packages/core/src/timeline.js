// Turns patterns + playlist into absolute-time events. Used by the audio engine
// (realtime scheduler and offline render), MIDI export and summaries.
import { STEP } from './constants.js';
import { patternLength } from './model.js';

/**
 * Swing as a time warp of each 8th note: the off-beat 16th moves late by swing × half a step (swing 0..1), the
 * downbeat stays put and everything in between moves proportionally — so humanized or slightly-off notes keep
 * their swing instead of losing it for not sitting exactly on the grid.
 */
export function swingTicks(start, swing) {
  if (!swing) return 0;
  const pair = STEP * 2;
  const u = ((start % pair) + pair) % pair;
  const delay = swing * STEP * 0.5;
  return u <= STEP ? (u / STEP) * delay : ((pair - u) / STEP) * delay;
}

/**
 * Notes of one pattern whose start lies in [from, to) (pattern-local ticks, no looping).
 * Returns [{ channelId, key, start, length, velocity, pan, noteId }]
 */
export function patternNotesInRange(pattern, from, to) {
  const out = [];
  for (const [channelId, list] of Object.entries(pattern.notes || {})) {
    for (const n of list) {
      if (n.start >= from && n.start < to) {
        out.push({ channelId, key: n.key, start: n.start, local: n.start, length: n.length, velocity: n.velocity, pan: n.pan || 0, noteId: n.id });
      }
    }
  }
  return out;
}

/**
 * Song-mode note events with absolute start in [from, to).
 * Pattern clips loop their pattern for the length of the clip; notes are cut at the clip end.
 */
export function songNotesInRange(project, from, to) {
  const out = [];
  const tracks = project.playlist.tracks;
  for (const clip of project.playlist.clips) {
    if (clip.kind !== 'pattern' || clip.mute || tracks[clip.track]?.mute) continue;
    const cs = clip.start;
    const ce = clip.start + clip.length;
    if (ce <= from || cs >= to) continue;
    const pattern = project.patterns.find((p) => p.id === clip.refId);
    if (!pattern) continue;
    const P = patternLength(project, pattern);
    const origin = cs - (clip.offset % P); // absolute tick where a pattern instance begins
    const lo = Math.max(from, cs);
    const hi = Math.min(to, ce);
    const kStart = Math.floor((lo - origin) / P) - 1;
    const kEnd = Math.ceil((hi - origin) / P);
    for (let k = Math.max(kStart, -1); k <= kEnd; k++) {
      const base = origin + k * P;
      for (const [channelId, list] of Object.entries(pattern.notes || {})) {
        for (const n of list) {
          if (n.start >= P) continue;
          const abs = base + n.start;
          if (abs < lo || abs >= hi) continue;
          out.push({
            channelId, key: n.key, start: abs, local: n.start, length: Math.max(1, Math.min(n.length, ce - abs)),
            velocity: n.velocity, pan: n.pan || 0, noteId: n.id, clipId: clip.id
          });
        }
      }
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Audio clips that start in [from, to). */
export function songAudioInRange(project, from, to) {
  const tracks = project.playlist.tracks;
  return project.playlist.clips.filter((c) => c.kind === 'audio' && !c.mute && !tracks[c.track]?.mute && c.start >= from && c.start < to);
}

/** Audio clips that are sounding at tick t (started earlier). Used when playback starts mid-clip. */
export function songAudioCovering(project, t) {
  const tracks = project.playlist.tracks;
  return project.playlist.clips.filter((c) => c.kind === 'audio' && !c.mute && !tracks[c.track]?.mute && c.start < t && c.start + c.length > t);
}

/** Automation clips overlapping [from, to). */
export function songAutomationInRange(project, from, to) {
  const tracks = project.playlist.tracks;
  const out = [];
  for (const clip of project.playlist.clips) {
    if (clip.kind !== 'automation' || clip.mute || tracks[clip.track]?.mute) continue;
    if (clip.start + clip.length <= from || clip.start >= to) continue;
    const automation = project.automations.find((a) => a.id === clip.refId);
    if (automation) out.push({ clip, automation });
  }
  return out;
}

/** Value (0..1) of an automation at a local tick (loops over automation.length). */
export function automationValueAt(automation, localTick) {
  const pts = automation.points;
  if (!pts.length) return 0.5;
  const t = ((localTick % automation.length) + automation.length) % automation.length;
  if (t <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      if (b.t === a.t) return b.v;
      return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
    }
  }
  return pts[pts.length - 1].v;
}

/** All note events for the whole song (or one pattern), absolute ticks. */
export function allSongNotes(project) {
  let end = 0;
  for (const c of project.playlist.clips) end = Math.max(end, c.start + c.length);
  return songNotesInRange(project, 0, end + 1);
}
