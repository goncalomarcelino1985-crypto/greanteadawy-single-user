// The wave editor's Pitch tab: the detected melody (grey curve), the notes found in it (blocks) and the corrected
// pitch (orange curve). Auto-tune snaps every note to the key/scale with Amount / Speed / Flatten; drag a note up or
// down to place it by hand (Alt/Shift = fine), double-click to give it back to the scale, right-click to split or join
// notes the detection got wrong, and more.
import { useState, useRef, useEffect, useMemo } from 'react';
import { SCALES, noteName, scaleSnapper, snapNotes, correctionCurve, correctedPitch, hzToMidi, noteCenter, parsePitchClass } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Select } from './ui/Controls.jsx';
import { capturePointer, useElementSize } from '../lib/hooks.js';
import { runAudioJob } from '../lib/audioEdit.js';

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const label = (k) => k.replace(/([A-Z])/g, ' $1').toLowerCase();
const SCALE_OPTIONS = [{ value: 'chromatic', label: 'chromatic (every semitone)' }, ...Object.keys(SCALES).filter((k) => k !== 'chromatic').map((k) => ({ value: k, label: label(k) }))];
export const PITCH_PRESETS = {
  Natural: { amount: 1, speedMs: 70, flatten: 0 },
  Tight: { amount: 1, speedMs: 20, flatten: 0.5 },
  Robotic: { amount: 1, speedMs: 0, flatten: 1 }
};

/** The project's key as one of KEYS (C, F#, Bb …), C when it has none. */
function projectKey(key) {
  const pc = parsePitchClass(key || 'C');
  return KEYS[pc ?? 0];
}

function drawPitch(canvas, { view, sr, track, notes, corrected, lo, hi, scalePcs, selId, sel }) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const xAtSec = (t) => ((t * sr - view.start) / (view.end - view.start)) * W;
  const semi = H / (hi - lo);
  const yAt = (m) => H - (m - lo) * semi;
  // semitone lanes: notes of the scale lighter, C labelled
  g.font = '10px ui-monospace, monospace';
  g.textBaseline = 'middle';
  for (let m = Math.floor(lo); m <= Math.ceil(hi); m++) {
    const y = yAt(m + 0.5);
    g.fillStyle = scalePcs.has(((m % 12) + 12) % 12) ? 'rgba(255, 255, 255, 0.045)' : 'rgba(0, 0, 0, 0.18)';
    g.fillRect(0, y, W, semi);
    g.fillStyle = 'rgba(255, 255, 255, 0.06)';
    g.fillRect(0, Math.round(y), W, 1);
    if (semi >= 9 && (m % 12 === 0 || semi >= 14)) {
      g.fillStyle = m % 12 === 0 ? 'rgba(255, 255, 255, 0.55)' : 'rgba(255, 255, 255, 0.3)';
      g.fillText(noteName(m), 3, yAt(m));
    }
  }
  if (sel.end > sel.start) {
    g.fillStyle = 'rgba(245, 159, 66, 0.12)';
    const a = ((sel.start - view.start) / (view.end - view.start)) * W;
    g.fillRect(a, 0, ((sel.end - sel.start) / (view.end - view.start)) * W, H);
  }
  if (!track) return;
  const hop = track.hop;
  const f0 = Math.max(0, Math.floor(view.start / sr / hop) - 1);
  const f1 = Math.min(track.hz.length, Math.ceil(view.end / sr / hop) + 1);
  // loudness envelope at the bottom: where there is sound at all
  let top = 1e-9;
  for (let f = 0; f < track.rms.length; f++) top = Math.max(top, track.rms[f]);
  g.fillStyle = 'rgba(154, 217, 79, 0.12)';
  for (let f = f0; f < f1; f++) {
    const h = Math.min(1, track.rms[f] / top) * H * 0.25;
    g.fillRect(xAtSec(f * hop), H - h, Math.max(1, xAtSec(hop) - xAtSec(0)), h);
  }
  // notes
  for (const n of notes) {
    const x0 = xAtSec(n.startSec);
    const x1 = xAtSec(n.endSec);
    if (x1 < 0 || x0 > W) continue;
    const y = yAt(n.target);
    const h = Math.max(6, semi * 0.8);
    g.fillStyle = n.bypass ? 'rgba(140, 151, 163, 0.18)' : n.id === selId ? 'rgba(245, 159, 66, 0.55)' : 'rgba(90, 184, 240, 0.35)';
    g.strokeStyle = n.bypass ? 'rgba(140, 151, 163, 0.6)' : n.id === selId ? '#f59f42' : 'rgba(90, 184, 240, 0.85)';
    g.setLineDash(n.bypass ? [3, 3] : []);
    g.beginPath();
    g.roundRect?.(x0, y - h / 2, Math.max(2, x1 - x0), h, 3);
    if (!g.roundRect) g.rect(x0, y - h / 2, Math.max(2, x1 - x0), h);
    g.fill();
    g.stroke();
    g.setLineDash([]);
    if (Math.abs(n.target - n.center) > 0.02 && !n.bypass) {
      // where it was sung
      g.strokeStyle = 'rgba(255, 255, 255, 0.45)';
      g.beginPath();
      g.moveTo(x0, yAt(n.center));
      g.lineTo(x1, yAt(n.center));
      g.stroke();
    }
    if (x1 - x0 > 26) {
      g.fillStyle = 'rgba(255, 255, 255, 0.85)';
      const cents = Math.round((n.target - Math.round(n.target)) * 100);
      g.fillText(`${noteName(Math.round(n.target))}${cents ? `${cents > 0 ? '+' : ''}${cents}` : ''}`, x0 + 3, y - h / 2 - 7);
    }
  }
  // detected (grey) and corrected (orange) pitch
  const curve = (val, color, width) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    let pen = false;
    for (let f = f0; f < f1; f++) {
      const m = val(f);
      if (!Number.isFinite(m)) { pen = false; continue; }
      const x = xAtSec(f * hop);
      const y = yAt(m);
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
    g.lineWidth = 1;
  };
  curve((f) => (track.hz[f] > 0 ? hzToMidi(track.hz[f]) : NaN), 'rgba(255, 255, 255, 0.45)', 1.2);
  if (corrected) curve((f) => corrected[f], '#f59f42', 1.6);
}

/**
 * memory: a ref the wave editor keeps — { clip, track, notes, key, scale, params } — so switching to the Wave tab and
 * back keeps the notes moved by hand and the settings (for the same audio).
 */
const FINDING = 'Finding the melody…';
const TUNING = 'Tuning…';

export function PitchView({ memory, clip, view, setView, sel, setSel, onWheel, busy, setBusy, onApply, playClip, stopPlay, playing, playheadRef }) {
  const pKey = useStore((s) => s.project?.key);
  const pScale = useStore((s) => s.project?.scale);
  const kept = memory?.current?.clip === clip ? memory.current : null;
  const [key, setKey] = useState(() => kept?.key || projectKey(pKey));
  const [scale, setScale] = useState(() => kept?.scale || (pScale && Object.hasOwn(SCALES, pScale) ? pScale : 'chromatic'));
  const [params, setParams] = useState(() => kept?.params || PITCH_PRESETS.Natural);
  const [analysis, setAnalysis] = useState(() => (kept ? { clip, track: kept.track } : null)); // { clip, track }
  const [notes, setNotes] = useState(() => kept?.notes || []);
  const [selId, setSelId] = useState(null);
  const [error, setError] = useState(null);
  const canvasRef = useRef(null);
  const drag = useRef(null);
  const tuned = useRef(null); // { clip, key, out } — the last corrected audio, reused while nothing changed
  const size = useElementSize(canvasRef);
  const st = useStore.getState();
  const sr = clip.sampleRate;
  const snap = useMemo(() => scaleSnapper(key, scale), [key, scale]);
  const scalePcs = useMemo(() => {
    const root = parsePitchClass(key) ?? 0;
    return new Set((SCALES[scale] || SCALES.chromatic).map((x) => (root + x) % 12));
  }, [key, scale]);

  // analyse the melody of the current audio (again after every edit)
  useEffect(() => {
    if (analysis?.clip === clip) return undefined;
    let live = true;
    setError(null);
    // the editor's busy state is shared: claim it only when it is free (a save or an edit may be running), and clear it
    // only while it is still ours
    setBusy((b) => b || FINDING);
    const done = () => { if (live) { live = false; setBusy((b) => (b === FINDING ? null : b)); } };
    runAudioJob('analyze', clip, { key, scale }).then((r) => {
      if (!live) return;
      setAnalysis({ clip, track: r.track });
      setNotes(r.notes);
      setSelId(null);
    }, (e) => { if (live) setError(e.message); }).finally(done);
    return done; // leaving mid-analysis frees the editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip]);
  // remember the work for this audio while the Wave tab is shown
  useEffect(() => {
    if (memory && analysis?.clip === clip) memory.current = { clip, track: analysis.track, notes, key, scale, params };
  }, [memory, clip, analysis, notes, key, scale, params]);

  const track = analysis?.clip === clip ? analysis.track : null;
  const shifts = useMemo(() => (track ? correctionCurve(track, notes, params) : null), [track, notes, params]);
  const corrected = useMemo(() => (track && shifts ? correctedPitch(track, shifts) : null), [track, shifts]);
  const [lo, hi] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (const n of notes) { a = Math.min(a, n.center, n.target); b = Math.max(b, n.center, n.target); }
    if (!Number.isFinite(a)) { a = 55; b = 67; }
    const mid = (a + b) / 2;
    const span = Math.max(12, b - a + 5);
    return [mid - span / 2, mid + span / 2];
  }, [notes]);

  useEffect(() => {
    if (!canvasRef.current) return;
    drawPitch(canvasRef.current, { view, sr, track, notes, corrected, lo, hi, scalePcs, selId, sel });
  }, [view, sr, track, notes, corrected, lo, hi, scalePcs, selId, sel, size.width, size.height]);

  const setKeyScale = (k, s) => {
    setKey(k);
    setScale(s);
    setNotes((list) => snapNotes(list, k, s));
  };
  const patchNote = (id, patch) => setNotes((list) => list.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  /**
   * A note over frames [start, end) of the track: its sung pitch measured the way the detection does it (without the
   * slides at ends that touch another note), its target the nearest scale note.
   */
  const makeNote = (id, start, end, { slideIn = notes.some((x) => x.end === start), slideOut = notes.some((x) => x.start === end) } = {}) => {
    const center = noteCenter(track, start, end, { slideIn, slideOut });
    return Number.isFinite(center) ? { id, start, end, startSec: start * track.hop, endSec: end * track.hop, center, target: snap(center) } : null;
  };
  /** A piece of `from` (split or joined) keeps what was set by hand: bypass, and a locked target's offset from the scale. */
  const inherit = (from, note) => {
    if (!note) return null;
    const out = { ...note, bypass: !!from.bypass, locked: !!from.locked };
    if (from.locked) out.target = Math.abs(from.target - from.center) < 1e-6 ? note.center : Math.max(0, Math.min(127, snap(note.center) + (from.target - snap(from.center))));
    return out;
  };
  const nextId = () => notes.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  // the detection can be corrected by hand: split a note where two were sung, join two that are one
  const splitAt = (n, sec) => {
    const f = Math.round(sec / track.hop);
    const min = Math.round(0.04 / track.hop);
    if (f - n.start < min || n.end - f < min) return st.toast('Too close to the end of the note to split there', 'warn', 1600);
    const id = nextId();
    const a = inherit(n, makeNote(id, n.start, f, { slideOut: true }));
    const b = inherit(n, makeNote(id + 1, f, n.end, { slideIn: true }));
    if (!a || !b) return;
    setNotes((list) => list.flatMap((x) => (x.id === n.id ? [a, b] : [x])));
    setSelId(b.id);
  };
  const joinNext = (n) => {
    const i = notes.indexOf(n);
    const next = notes[i + 1];
    if (!next) return;
    const joined = inherit(n, makeNote(nextId(), n.start, next.end));
    if (!joined) return;
    setNotes((list) => list.filter((x) => x.id !== next.id).map((x) => (x.id === n.id ? joined : x)));
    setSelId(joined.id);
  };
  const noteMenu = (n, sec) => {
    const next = notes[notes.indexOf(n) + 1];
    return [
      { label: 'Snap to the scale', onClick: () => patchNote(n.id, { target: snap(n.center), locked: false, bypass: false }) },
      { label: 'Keep as sung (no correction)', onClick: () => patchNote(n.id, { target: n.center, locked: true, bypass: false }) },
      { label: n.bypass ? 'Correct this note again' : 'Leave this note alone (bypass)', onClick: () => patchNote(n.id, { bypass: !n.bypass }) },
      ...[-12, -1, 1, 12].map((d) => ({ label: `${d > 0 ? 'Up' : 'Down'} ${Math.abs(d) === 12 ? 'an octave' : 'a semitone'}`, onClick: () => patchNote(n.id, { target: Math.round(n.target) + d, locked: true, bypass: false }) })),
      '-',
      { label: 'Split the note here', disabled: sec === undefined, onClick: () => splitAt(n, sec) },
      { label: 'Join with the next note', disabled: !next || next.startSec - n.endSec > 0.15, onClick: () => joinNext(n) }
    ];
  };

  // ---- pointer: notes move up/down, empty space selects time
  const geom = () => {
    const r = canvasRef.current.getBoundingClientRect();
    return { r, semi: r.height / (hi - lo) };
  };
  const hit = (e) => {
    const { r, semi } = geom();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const t = (view.start + (x / r.width) * (view.end - view.start)) / sr;
    const m = lo + (r.height - y) / semi;
    const h = Math.max(6, semi * 0.8) / semi / 2 + 3 / semi;
    return notes.find((n) => t >= n.startSec && t <= n.endSec && Math.abs(m - n.target) <= h) || null;
  };
  const onPointerDown = (e) => {
    if (e.button !== 0 || !track) return;
    capturePointer(e);
    e.currentTarget.closest('.we-body')?.focus({ preventScroll: true });
    const n = hit(e);
    const { r } = geom();
    if (n) {
      setSelId(n.id);
      drag.current = { kind: 'note', id: n.id, y: e.clientY, target: n.target, moved: false };
    } else {
      setSelId(null);
      const f = Math.round(view.start + ((e.clientX - r.left) / r.width) * (view.end - view.start));
      drag.current = { kind: 'time', anchor: f, r };
      setSel({ start: f, end: f });
    }
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) {
      e.currentTarget.style.cursor = track && hit(e) ? 'ns-resize' : 'text';
      return;
    }
    if (d.kind === 'note') {
      const { semi } = geom();
      const delta = (d.y - e.clientY) / semi;
      if (!d.moved && Math.abs(d.y - e.clientY) < 3) return;
      d.moved = true;
      const fine = e.altKey || e.shiftKey;
      const target = fine ? Math.round((d.target + delta) * 100) / 100 : Math.round(d.target + delta);
      patchNote(d.id, { target: Math.max(0, Math.min(127, target)), locked: true, bypass: false });
    } else {
      const f = Math.max(0, Math.min(view.end, Math.round(view.start + ((e.clientX - d.r.left) / d.r.width) * (view.end - view.start))));
      setSel({ start: Math.min(d.anchor, f), end: Math.max(d.anchor, f) });
    }
  };
  const onPointerUp = () => { drag.current = null; };
  const onDoubleClick = (e) => {
    const n = hit(e);
    if (n) patchNote(n.id, { target: snap(n.center), locked: false, bypass: false });
  };
  const onContextMenu = (e) => {
    const n = hit(e);
    if (!n) return;
    setSelId(n.id);
    const { r } = geom();
    const sec = (view.start + ((e.clientX - r.left) / r.width) * (view.end - view.start)) / sr;
    st.showContextMenu(e, noteMenu(n, sec));
  };
  const onKeyDown = (e) => {
    if (e.target.closest('input, select, textarea, button')) return; // the sliders and lists keep their arrow keys
    const n = notes.find((x) => x.id === selId);
    if (!n) return;
    const step = e.shiftKey || e.altKey ? 0.1 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const t = e.key === 'ArrowUp' ? n.target + step : n.target - step;
      patchNote(n.id, { target: Math.round(t * 100) / 100, locked: true, bypass: false });
    } else if (e.key === '0') patchNote(n.id, { target: snap(n.center), locked: false, bypass: false });
    else if (e.key.toLowerCase() === 'b') patchNote(n.id, { bypass: !n.bypass });
    else if (e.key === 'Escape') setSelId(null);
    else if (e.key === ']' || e.key === '[') {
      const i = notes.indexOf(n);
      const next = notes[(i + (e.key === '[' ? notes.length - 1 : 1)) % notes.length];
      setSelId(next.id);
      if (next.startSec * sr < view.start || next.endSec * sr > view.end) setView((v) => { const span = v.end - v.start; const a = Math.max(0, next.startSec * sr - span * 0.2); return { start: a, end: a + span }; });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // ---- render the correction (worker), reused until notes or settings change
  const tunedAudio = async () => {
    const k = JSON.stringify([notes.map((n) => [n.id, n.target, !!n.bypass]), params]);
    if (tuned.current?.clip === clip && tuned.current.key === k) return tuned.current.out;
    setBusy(TUNING);
    try {
      const r = await runAudioJob('autotune', clip, { notes, track, amount: params.amount, speedMs: params.speedMs, flatten: params.flatten });
      tuned.current = { clip, key: k, out: r.clip };
      return r.clip;
    } finally {
      setBusy((b) => (b === TUNING ? null : b));
    }
  };
  const preview = async () => {
    if (playing) return stopPlay();
    try { playClip(await tunedAudio()); } catch (e) { st.toast(e.message, 'error'); }
  };
  const apply = async () => {
    if (busy) return;
    try {
      const base = clip;
      const out = await tunedAudio();
      if (!onApply(out, 'Pitch correction', base)) return;
      st.toast(`Tuned ${notes.filter((n) => !n.bypass).length} notes to ${scale === 'chromatic' ? 'the nearest semitone' : `${key} ${label(scale)}`}`, 'success', 1800);
    } catch (e) {
      st.toast(e.message, 'error');
    }
  };
  const active = notes.filter((n) => !n.bypass);
  const maxMove = active.reduce((m, n) => Math.max(m, Math.abs(n.target - n.center)), 0);
  const changed = active.some((n) => Math.abs(n.target - n.center) > 0.005) || params.flatten > 0;

  return (
    <div className="pv" onKeyDown={onKeyDown}>
      <div className="pv-controls" role="group" aria-label="Pitch correction">
        <label className="pv-field">Key
          <Select value={key} options={KEYS} onChange={(k) => setKeyScale(k, scale)} title="Key" />
        </label>
        <label className="pv-field">Scale
          <Select value={scale} options={SCALE_OPTIONS} onChange={(s) => setKeyScale(key, s)} title="Scale" />
        </label>
        <label className="pv-field" title="How far notes move to their target (100% = all the way)">Amount
          <input type="range" min="0" max="100" value={Math.round(params.amount * 100)} onChange={(e) => setParams((p) => ({ ...p, amount: Number(e.target.value) / 100 }))} />
          <span className="pv-val">{Math.round(params.amount * 100)}%</span>
        </label>
        <label className="pv-field" title="How long a note takes to reach its target: 0 ms = instant (the robotic effect), slower keeps scoops and slides">Speed
          <input type="range" min="0" max="200" step="5" value={params.speedMs} onChange={(e) => setParams((p) => ({ ...p, speedMs: Number(e.target.value) }))} />
          <span className="pv-val">{params.speedMs} ms</span>
        </label>
        <label className="pv-field" title="How much of the vibrato and drift inside each note is ironed out">Flatten
          <input type="range" min="0" max="100" value={Math.round(params.flatten * 100)} onChange={(e) => setParams((p) => ({ ...p, flatten: Number(e.target.value) / 100 }))} />
          <span className="pv-val">{Math.round(params.flatten * 100)}%</span>
        </label>
        <div className="pv-presets" role="group" aria-label="Presets">
          {Object.entries(PITCH_PRESETS).map(([name, p]) => (
            <button key={name} className={`btn tiny ${params.amount === p.amount && params.speedMs === p.speedMs && params.flatten === p.flatten ? 'on' : ''}`} onClick={() => setParams(p)}>{name}</button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn tiny" title="Give every note you did not move back to the scale" disabled={!track} onClick={() => setNotes((l) => l.map((n) => (n.locked ? n : { ...n, target: snap(n.center), bypass: false })))}>Snap all</button>
        <button className="btn tiny" title="Unlock every note and snap it to the scale" disabled={!track} onClick={() => setNotes((l) => l.map((n) => ({ ...n, target: snap(n.center), locked: false, bypass: false })))}>Reset</button>
        <button className={`btn tiny ${playing ? 'on' : ''}`} disabled={!track || !!busy || !notes.length} onClick={preview} title="Hear the corrected audio (the selection, or from the cursor)">{playing ? 'Stop' : 'Preview'}</button>
        <button className="btn tiny primary" disabled={!track || !!busy || !changed} onClick={apply} title="Write the correction into the audio (one undo step)">Apply</button>
      </div>
      <div className="pv-area we-canvas" onWheel={onWheel}>
        <canvas ref={canvasRef} className="pv-canvas" data-testid="pitch-canvas" tabIndex={-1} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick} onContextMenu={onContextMenu} />
        <div ref={playheadRef} className="we-playhead" />
        {track && !notes.length && <p className="pv-empty">No melody found. Pitch correction works on a solo voice or instrument (one note at a time).</p>}
        {error && <p className="pv-empty error">Pitch analysis failed: {error}</p>}
      </div>
      <div className="pv-status" data-testid="pitch-status">
        {track ? `${notes.length} note${notes.length === 1 ? '' : 's'} · ${active.length < notes.length ? `${notes.length - active.length} bypassed · ` : ''}largest move ${maxMove.toFixed(2)} semitones` : 'Finding the melody…'}
        <span className="muted"> · drag a note up/down (Alt = fine; ↑ ↓, [ ] next note), double-click = back to the scale, right-click = split, join and more</span>
      </div>
    </div>
  );
}
