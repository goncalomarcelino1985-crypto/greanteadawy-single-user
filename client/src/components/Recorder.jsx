// The recorder: record from a microphone alone or while the song/pattern plays (count-in, metronome, latency
// compensation). Every take is saved as a WAV sample in the "Recordings" folder and, over the song, placed on the
// playlist where it was recorded. From the take list a take opens in the wave editor (or straight in its Pitch tab).
import { useState, useRef, useEffect } from 'react';
import { PPQ, beatsPerBar, ticksPerBar, songLength, uid, clipLength, encodeWav, MAX_TRACKS } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { Icon } from './ui/Icon.jsx';
import { Select } from './ui/Controls.jsx';
import { getEngine } from '../audio/index.js';
import { MicSession, recordingSupport, micErrorMessage, listInputs, recordingsFolder, freeTrackFor } from '../lib/recorder.js';
import { saveClipAsSample, uploadLimitBytes, secondsThatFit } from '../lib/audioEdit.js';
import { openSampleEditor } from '../lib/actions.js';
import { deleteSamplesWithWarning } from './SampleLibrary.jsx';
import { fmtTime } from './WaveEditor.jsx';

const PREFS_KEY = 'gtd.recorder';
const MAX_SECONDS = 600;
const DEFAULTS = { deviceId: '', channels: 1, along: 'song', countIn: 1, metronome: true, place: true, monitor: false, echo: false, noise: false, agc: false, offsetMs: 0 };

const readPrefs = () => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
};
const writePrefs = (p) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* not remembered */ }
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Recorder() {
  const open = useStore((s) => !!s.windows.recorder?.open);
  const playing = useStore((s) => s.playing);
  const projectName = useStore((s) => s.project?.name);
  const openRef = useRef(open);
  openRef.current = open;
  const [opts, setOpts] = useState(readPrefs);
  const [devices, setDevices] = useState([]);
  const [mic, setMic] = useState(null);
  const [phase, setPhase] = useState('off'); // off | arming | ready | countin | recording | saving
  const [error, setError] = useState(null);
  const [takes, setTakes] = useState([]); // { id, name, seconds, placed } — or a take that couldn't be saved: { id, name, seconds, failed, clip, place }
  const [maxSec, setMaxSec] = useState(MAX_SECONDS);
  const meterRef = useRef(null);
  const timeRef = useRef(null);
  const run = useRef(null); // the take being recorded: { t0, startTick, mode }
  const st = useStore.getState();
  const unsupported = recordingSupport();
  const recording = phase === 'countin' || phase === 'recording';
  // audio only this page holds: signing out asks first, and leaving the page warns
  const holding = recording || phase === 'saving' || takes.some((t) => t.failed);
  useEffect(() => {
    useStore.setState({ recorderBusy: holding });
    if (!holding) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); useStore.setState({ recorderBusy: false }); };
  }, [holding]);

  const set = (patch) => setOpts((o) => {
    const n = { ...o, ...patch };
    writePrefs(n);
    return n;
  });

  // closing the window releases the microphone (a take in progress is saved first)
  useEffect(() => {
    if (open) return undefined;
    if (run.current) stopRecording();
    mic?.close();
    setMic(null);
    setPhase('off');
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => mic?.close(), [mic]);
  // the studio's own Stop (Space, the toolbar) ends a take that plays along
  useEffect(() => {
    const r = run.current;
    if (!playing && r && r.mode !== 'none' && r.t0 !== null) stopRecording();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  useEffect(() => { mic?.setMonitor(opts.monitor); }, [mic, opts.monitor]);

  // the meter and the clock
  useEffect(() => {
    if (!mic) return undefined;
    let id;
    let hold = 0;
    let holdAt = 0;
    const tick = () => {
      const p = mic.peak();
      const now = performance.now();
      if (p >= hold || now - holdAt > 1200) { hold = p; holdAt = now; }
      const el = meterRef.current;
      if (el) {
        const db = (v) => (v > 0 ? 20 * Math.log10(v) : -96);
        const pos = (v) => Math.max(0, Math.min(100, ((db(v) + 60) / 60) * 100));
        el.style.setProperty('--level', `${pos(p)}%`);
        el.style.setProperty('--hold', `${pos(hold)}%`);
        el.classList.toggle('clip', hold >= 0.99);
        el.dataset.db = db(hold).toFixed(1);
        el.setAttribute('aria-valuenow', String(Math.max(-60, Math.round(db(p)))));
      }
      const r = run.current;
      if (timeRef.current && r) {
        const waiting = r.mode !== 'none' && r.t0 === null; // the transport is still starting
        const t = r.t0 !== null ? mic.ctx.currentTime - r.t0 : mic.elapsed;
        timeRef.current.textContent = waiting ? 'count-in' : t < 0 ? `count-in ${Math.ceil(-t / (60 / (useStore.getState().project?.bpm || 120)))}` : `${mmss(t)}.${Math.floor((t % 1) * 10)}`;
        if (!waiting && t >= 0 && phase === 'countin') setPhase('recording');
        if (mic.elapsed >= maxSec) stopRecording();
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic, phase, maxSec]);

  const enable = async (patch = {}) => {
    if (unsupported) return setError(unsupported);
    const o = { ...opts, ...patch };
    setError(null);
    setPhase('arming');
    try {
      const eng = await st.unlockAudio();
      if (!eng) throw new Error('Audio is not available in this browser');
      mic?.close();
      const m = await MicSession.open(eng.ctx, { deviceId: o.deviceId, channels: o.channels, echoCancellation: o.echo, noiseSuppression: o.noise, autoGainControl: o.agc });
      if (!openRef.current) {
        // the window was closed while the browser asked for the microphone: let it go again
        m.close();
        setPhase('off');
        return;
      }
      setMic(m);
      setDevices(await listInputs());
      const limit = await uploadLimitBytes();
      setMaxSec(Math.max(1, Math.min(MAX_SECONDS, secondsThatFit(limit, { channels: o.channels, sampleRate: eng.ctx.sampleRate, bitDepth: 16 }))));
      setPhase('ready');
    } catch (e) {
      setMic(null);
      setError(micErrorMessage(e));
      setPhase('off');
    }
  };
  // input settings need a new stream
  const change = (patch) => {
    set(patch);
    if (mic && !recording) enable(patch);
  };

  const record = async () => {
    if (!mic || recording || phase === 'saving') return;
    const eng = getEngine();
    const s = useStore.getState();
    const p = s.project;
    const mode = opts.along === 'none' || !p ? 'none' : opts.along;
    setError(null);
    mic.start();
    run.current = { t0: null, startTick: 0, mode, prevMode: s.mode, clicks: [] };
    if (mode === 'none') {
      setPhase('recording');
      return;
    }
    // count-in clicks, then the transport starts exactly on the next beat
    const beat = 60 / p.bpm;
    const bpb = beatsPerBar(p);
    const countBeats = Math.round(opts.countIn * bpb);
    const first = eng.ctx.currentTime + 0.15;
    for (let k = 0; k < countBeats; k++) run.current.clicks.push(eng.click(first + k * beat, k % Math.max(1, Math.round(bpb)) === 0));
    setPhase(countBeats ? 'countin' : 'recording');
    // over the song, play on past its end instead of looping back (the take keeps going)
    const position = mode === 'song' ? s.songStart : 0;
    const loopRegion = mode === 'song' ? { start: 0, end: Math.max(songLength(p), position) + Math.ceil(maxSec * (p.bpm / 60) * PPQ) + ticksPerBar(p) } : undefined;
    await s.play({ mode, position, at: first + countBeats * beat, metronome: opts.metronome || s.metronome, loopRegion });
    const tr = eng.transport;
    if (run.current && tr.playing) run.current = { ...run.current, t0: tr.anchor.time, startTick: tr.anchor.tick };
  };

  async function stopRecording() {
    const r = run.current;
    if (!r || !mic) return;
    run.current = null;
    setPhase('saving');
    const eng = getEngine();
    const s = useStore.getState();
    for (const o of r.clicks || []) { try { o.stop(); } catch { /* already played */ } }
    if (r.mode !== 'none') {
      s.stop();
      eng.metronome = s.metronome;
      if (s.mode !== r.prevMode) useStore.setState({ mode: r.prevMode }); // "over the pattern" switched to PAT
    }
    let take = null;
    try {
      const raw = await mic.stop();
      if (!raw) throw new Error('Nothing was recorded (no audio from the input)');
      // line the take up with what the performer heard: output + input latency (+ the user's fine offset)
      let from = 0;
      if (r.t0 !== null) {
        const latency = (eng.ctx.outputLatency || 0) + (eng.ctx.baseLatency || 0) + mic.inputLatency + opts.offsetMs / 1000;
        from = Math.max(0, Math.round((r.t0 + latency - raw.startTime) * raw.sampleRate));
      }
      const channels = raw.channels.map((c) => c.slice(from));
      const clip = { sampleRate: raw.sampleRate, channels };
      const n = clipLength(clip);
      if (n < raw.sampleRate * 0.1) throw new Error(r.t0 !== null && from > 0 ? 'The take was stopped during the count-in' : 'The take is too short');
      const fade = Math.min(n, Math.round(raw.sampleRate * 0.003));
      for (const c of channels) for (let i = 0; i < fade; i++) { c[i] *= i / fade; c[n - 1 - i] *= i / fade; }
      const p = useStore.getState().project;
      const bar = p && r.mode === 'song' ? Math.floor(r.startTick / ticksPerBar(p)) + 1 : null;
      take = { clip, seconds: n / raw.sampleRate, place: r.mode === 'song' && opts.place ? r.startTick : null, bar, projectId: p?.id || null, projectName: p?.name || '' };
      await saveTake(take);
    } catch (e) {
      setError(e.message);
      // the audio is never thrown away because saving failed: keep it here to retry or download
      if (take) setTakes((t) => [{ id: uid('take'), name: `Unsaved take${take.bar ? ` (bar ${take.bar})` : ''}`, seconds: take.seconds, failed: true, ...take }, ...t]);
    } finally {
      setPhase(mic ? 'ready' : 'off');
    }
  }

  /** Save a take as a sample in Recordings (and place it on the playlist when it was recorded over the song). */
  async function saveTake(take) {
    const folder = await recordingsFolder();
    const existing = useStore.getState().samples.filter((x) => x.folderId === folder?.id).length;
    // named after the project it was recorded in (a retry may come after switching projects)
    const from = take.projectName ?? projectName;
    const name = Array.from(`Take ${existing + 1}${take.bar ? ` (bar ${take.bar})` : ''}${from ? ` — ${from}` : ''}`).slice(0, 80).join('');
    const item = await saveClipAsSample(take.clip, { name, folderId: folder?.id || null });
    let placed = false;
    let why = '';
    const p = useStore.getState().project;
    const wanted = take.place !== null && take.place !== undefined;
    // placed only in the project it was recorded over (a retry may come after switching projects)
    if (wanted && p && take.projectId && take.projectId !== p.id) why = ` — not placed: it was recorded over "${take.projectName || 'another project'}"`;
    else if (wanted && p) {
      const length = Math.max(1, Math.round(take.seconds * (p.bpm / 60) * PPQ));
      const track = freeTrackFor(p, take.place, take.place + length);
      if (track < MAX_TRACKS) {
        const ops = [];
        if (track >= p.playlist.tracks.length) ops.push({ type: 'track/add', count: track - p.playlist.tracks.length + 1 });
        ops.push({ type: 'clip/add', clips: [{ id: uid('clip'), kind: 'audio', refId: item.id, track, start: take.place, length }] });
        placed = useStore.getState().dispatch(ops) ? track + 1 : false;
      }
      if (!placed) why = ' — not placed: no free playlist track there';
    }
    setTakes((t) => [{ id: item.id, name: item.name, seconds: take.seconds, placed }, ...t]);
    st.toast(`Saved ${item.name}${placed ? ` on track ${placed}` : why}`, why ? 'info' : 'success', why ? 4000 : 2000);
    return item;
  }

  const retry = async (t) => {
    if (t.saving) return;
    setError(null);
    setTakes((l) => l.map((x) => (x.id === t.id ? { ...x, saving: true } : x)));
    try {
      await saveTake(t);
      setTakes((l) => l.filter((x) => x.id !== t.id));
    } catch (e) {
      setError(e.message);
      setTakes((l) => l.map((x) => (x.id === t.id ? { ...x, saving: false } : x)));
    }
  };
  const discard = async (t) => {
    if (await st.confirm({ title: `Discard "${t.name}"?`, message: 'This take was never saved: discarding it loses the recording. Download keeps a copy as a WAV file.', danger: true, okLabel: 'Discard' })) {
      setTakes((l) => l.filter((x) => x.id !== t.id));
    }
  };
  const download = (t) => {
    const url = URL.createObjectURL(new Blob([encodeWav(t.clip.channels, t.clip.sampleRate, { bitDepth: 24 })], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.name.replace(/[\\/:*?"<>|]+/g, ' ')}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const alongOptions = [
    { value: 'song', label: 'Over the song (from the song start marker)' },
    { value: 'pattern', label: 'Over the current pattern (looping)' },
    { value: 'none', label: 'Microphone only' }
  ];
  const latencyMs = mic ? Math.round(((mic.ctx.outputLatency || 0) + (mic.ctx.baseLatency || 0) + mic.inputLatency) * 1000) : null;

  return (
    <Window name="recorder" title="Record audio" icon="mic" minW={340} minH={300} className="recorder">
      {/* focusable, so a click on a blank part keeps Space here (not on the page, where it plays the song) */}
      <div className="rec-body" data-testid="recorder" tabIndex={-1} data-keyboard-home onKeyDown={(e) => {
        // Space here belongs to the recorder, not the studio's transport: a focused button is pressed (Record/Stop),
        // anywhere else it ends a take that is running
        if (e.key !== ' ' || e.target.closest('input, select, textarea')) return;
        e.stopPropagation();
        if (e.target.closest('button, summary')) return; // pressed/opened by the browser
        e.preventDefault();
        if (run.current) stopRecording();
      }}>
        {unsupported ? <p className="rec-error" role="alert">{unsupported}</p> : null}
        <div className="rec-row">
          <label className="rec-field grow">Input
            <Select value={opts.deviceId} disabled={recording} title="Microphone / audio input"
              options={[{ value: '', label: 'Default input' }, ...devices.map((d) => ({ value: d.deviceId, label: d.label }))]}
              onChange={(v) => change({ deviceId: v })} />
          </label>
          <label className="rec-field">Channels
            <Select value={String(opts.channels)} disabled={recording} options={[{ value: '1', label: 'Mono' }, { value: '2', label: 'Stereo' }]} onChange={(v) => change({ channels: Number(v) })} />
          </label>
        </div>
        {!mic ? (
          <button className="btn primary rec-enable" disabled={!!unsupported || phase === 'arming'} onClick={() => enable()}>
            <Icon name="mic" size={14} /> {phase === 'arming' ? 'Waiting for the microphone…' : 'Enable microphone'}
          </button>
        ) : (
          <div className="rec-meter" ref={meterRef} role="meter" aria-label={`Input level (${mic.label})`} aria-valuemin={-60} aria-valuemax={0} title={mic.label}>
            <i className="lvl" /><i className="hold" />
          </div>
        )}
        <div className="rec-row">
          <label className="rec-field grow">Play along
            <Select value={opts.along} options={alongOptions} onChange={(v) => set({ along: v })} />
          </label>
        </div>
        <div className="rec-row checks">
          <label title="Clicks before the transport starts"><span>Count-in</span>
            <Select value={String(opts.countIn)} disabled={opts.along === 'none'} options={[{ value: '0', label: 'off' }, { value: '1', label: '1 bar' }, { value: '2', label: '2 bars' }]} onChange={(v) => set({ countIn: Number(v) })} />
          </label>
          <label><input type="checkbox" checked={opts.metronome} disabled={opts.along === 'none'} onChange={(e) => set({ metronome: e.target.checked })} /> Metronome</label>
          <label title="Put each take on the playlist where it was recorded"><input type="checkbox" checked={opts.place} disabled={opts.along !== 'song'} onChange={(e) => set({ place: e.target.checked })} /> Place on playlist</label>
          <label title="Hear yourself — use headphones, or it will feed back"><input type="checkbox" checked={opts.monitor} onChange={(e) => set({ monitor: e.target.checked })} /> Monitor</label>
        </div>
        <details className="rec-advanced">
          <summary>Input processing &amp; latency</summary>
          <div className="rec-row checks">
            <label title="For speakers without headphones; changes the sound"><input type="checkbox" checked={opts.echo} disabled={recording} onChange={(e) => change({ echo: e.target.checked })} /> Echo cancellation</label>
            <label><input type="checkbox" checked={opts.noise} disabled={recording} onChange={(e) => change({ noise: e.target.checked })} /> Noise suppression</label>
            <label><input type="checkbox" checked={opts.agc} disabled={recording} onChange={(e) => change({ agc: e.target.checked })} /> Auto gain</label>
          </div>
          <div className="rec-row">
            <label className="rec-field" title="Added to the measured latency: raise it if takes land late, lower it if they land early">Offset (ms)
              <input type="number" min="-500" max="500" step="1" value={opts.offsetMs} onChange={(e) => set({ offsetMs: Math.max(-500, Math.min(500, Number(e.target.value) || 0)) })} />
            </label>
            <span className="muted rec-latency">{latencyMs !== null ? `Measured latency ≈ ${latencyMs} ms (compensated)` : 'Latency is measured once the microphone is on'}</span>
          </div>
        </details>
        <div className="rec-transport">
          {recording || phase === 'saving' ? (
            // not disabled while saving: a disabled button drops the focus to the page, where Space plays the song
            <button className="btn rec-btn stop" aria-disabled={phase === 'saving'} onClick={stopRecording}><Icon name="stop" size={14} /> {phase === 'saving' ? 'Saving…' : 'Stop'}</button>
          ) : (
            <button className="btn rec-btn" disabled={!mic} onClick={record} aria-label="Record"><Icon name="record" size={14} /> Record</button>
          )}
          <span className={`rec-time ${recording ? 'on' : ''}`} ref={timeRef} aria-live="off">{recording ? '' : '0:00.0'}</span>
          <span className="muted">max {mmss(maxSec)}</span>
        </div>
        {error && <p className="rec-error" role="alert">{error}</p>}
        <div className="rec-takes">
          <div className="br-cat">Takes (saved in Samples → Recordings)</div>
          {!takes.length && <p className="br-empty">No takes yet.</p>}
          {takes.map((t) => (t.failed ? (
            <div key={t.id} className="br-item rec-take failed">
              <Icon name="warn" size={13} />
              <span className="br-name" title="This take could not be saved">{t.name}</span>
              <span className="br-meta">{fmtTime(t.seconds)}</span>
              <button className="btn tiny" disabled={!!t.saving} onClick={() => retry(t)}>{t.saving ? 'Saving…' : 'Retry'}</button>
              <button className="btn tiny" title="Save the take as a WAV file on this computer" onClick={() => download(t)}>Download</button>
              <button className="br-add" title="Discard this take" aria-label={`Discard ${t.name}`} onClick={() => discard(t)}><Icon name="trash" size={12} /></button>
            </div>
          ) : (
            <div key={t.id} className="br-item rec-take">
              <Icon name="wave" size={13} />
              <button className="br-name" title="Play" onClick={async () => { await st.unlockAudio(); getEngine()?.previewSample(t.id); }}>{t.name}</button>
              <span className="br-meta">{fmtTime(t.seconds)}{t.placed ? ` · track ${t.placed}` : ''}</span>
              <button className="btn tiny" onClick={() => openSampleEditor(t.id, { tab: 'wave' })}>Edit</button>
              <button className="btn tiny" title="Pitch correction" onClick={() => openSampleEditor(t.id, { tab: 'pitch' })}>Tune</button>
              <button className="br-add" title="Delete take" aria-label={`Delete ${t.name}`} onClick={async () => {
                const s = useStore.getState().samples.find((x) => x.id === t.id);
                if (!s) return setTakes((l) => l.filter((x) => x.id !== t.id));
                try { if (await deleteSamplesWithWarning([s])) setTakes((l) => l.filter((x) => x.id !== t.id)); } catch (e) { st.toast(e.message, 'error'); }
              }}><Icon name="trash" size={12} /></button>
            </div>
          )))}
        </div>
      </div>
    </Window>
  );
}
