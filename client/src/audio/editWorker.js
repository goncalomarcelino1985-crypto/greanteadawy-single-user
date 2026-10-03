// Background worker for the slow sample edits (pitch shift, time stretch, speed, pitch tracking and correction), so
// the wave editor and Claude's edit_sample jobs never freeze the studio. Clips arrive as structured clones (copies)
// and go back transferred.
import { applyEdit, analyzeMelody, autotune } from '@greanteadawy/core';

self.onmessage = (e) => {
  const { id, kind, clip, args } = e.data;
  try {
    let res;
    if (kind === 'edit') {
      const r = applyEdit(clip, args);
      res = { clip: r.clip, note: r.note || null };
    } else if (kind === 'analyze') {
      const r = analyzeMelody(clip, args);
      res = { track: r.track, notes: r.notes };
    } else if (kind === 'autotune') {
      const r = autotune(clip, args);
      res = { clip: r.clip, notes: r.notes, maxMove: r.maxMove, scaleLabel: r.scaleLabel };
    } else {
      throw new Error(`Unknown edit job "${kind}"`);
    }
    self.postMessage({ id, ok: true, res }, res.clip ? [...new Set(res.clip.channels.map((c) => c.buffer))] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
