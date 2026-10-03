import { memo, useRef, useState } from 'react';
import { INSTRUMENTS, INSTRUMENT_KINDS, INSTRUMENT_CATEGORIES, STEP, patternLength, uid, COLORS } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { Knob } from './ui/Knob.jsx';
import { Led, DragNumber } from './ui/Controls.jsx';
import { Icon } from './ui/Icon.jsx';
import { usePlayheadLine } from '../lib/hooks.js';
import {
  addChannel, cloneChannel, renameChannel, deleteChannel, fillSteps, shiftSteps, randomizeSteps,
  setPatternSteps, addSamplerChannel, gesture
} from '../lib/actions.js';
import { getEngine } from '../audio/index.js';
import { DND_INSTRUMENT, DND_SAMPLE, isStudioDrag } from '../lib/dnd.js';

const STEP_W = 18;
const STEP_GAP = 2;
const GROUP_GAP = 5;
export const stepX = (i) => i * (STEP_W + STEP_GAP) + Math.floor(i / 4) * GROUP_GAP;

function isStepView(notes, channel) {
  if (!notes?.length) return true;
  return notes.every((n) => n.start % STEP === 0 && n.key === channel.rootKey && n.length <= STEP * 2);
}

const paint = { active: false, on: false, channelId: null, key: null }; // key: one undo step per paint stroke

const StepRow = memo(function StepRow({ channel, notes, steps, patternId }) {
  const st = useStore.getState();
  const byStep = new Map();
  for (const n of notes || []) if (n.start % STEP === 0) byStep.set(n.start / STEP, n);

  const setStep = (i, on) => {
    const existing = byStep.get(i);
    if (on && !existing) {
      st.dispatch([{ type: 'notes/add', patternId, channelId: channel.id, notes: [{ id: uid('n'), key: channel.rootKey, start: i * STEP, length: STEP, velocity: 0.8 }] }], { coalesce: paint.key });
    } else if (!on && existing) {
      const ids = (notes || []).filter((n) => n.start === i * STEP).map((n) => n.id);
      st.dispatch([{ type: 'notes/remove', patternId, channelId: channel.id, ids }], { coalesce: paint.key });
    }
  };

  const cells = [];
  for (let i = 0; i < steps; i++) {
    const n = byStep.get(i);
    const group = Math.floor(i / 4) % 2;
    cells.push(
      <button key={i} className={`step g${group} ${n ? 'on' : ''}`} style={{ left: stepX(i), '--vel': n ? 0.45 + n.velocity * 0.55 : 0 }}
        aria-label={`Step ${i + 1}${n ? ' on' : ''}`}
        onPointerDown={(e) => {
          if (e.button === 2) return;
          e.preventDefault();
          paint.active = true;
          paint.on = !n;
          paint.key = gesture('paint');
          paint.channelId = channel.id;
          setStep(i, paint.on);
          if (paint.on) getEngine()?.preview(channel.id, channel.rootKey, 0.8, 0.2);
        }}
        onPointerEnter={() => { if (paint.active && paint.channelId === channel.id) setStep(i, paint.on); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setStep(i, false); }}
        onWheel={(e) => {
          if (!n) return;
          e.stopPropagation();
          const v = Math.max(0.05, Math.min(1, n.velocity + (e.deltaY < 0 ? 0.05 : -0.05)));
          st.dispatch([{ type: 'notes/update', patternId, channelId: channel.id, notes: [{ id: n.id, velocity: v }] }], { coalesce: `vel:${n.id}` });
        }}
      />
    );
  }
  return <div className="steps" style={{ width: stepX(steps) }}>{cells}</div>;
});

function MiniRoll({ notes, length, onOpen }) {
  if (!notes?.length) return null;
  let lo = 127;
  let hi = 0;
  for (const n of notes) { lo = Math.min(lo, n.key); hi = Math.max(hi, n.key); }
  const range = Math.max(12, hi - lo + 1);
  return (
    <button className="mini-roll" onClick={onOpen} title="Open in piano roll">
      <svg viewBox={`0 0 ${length} ${range}`} preserveAspectRatio="none">
        {notes.map((n) => <rect key={n.id} x={n.start} y={hi - n.key + (range - (hi - lo + 1)) / 2} width={Math.max(6, n.length - 2)} height={0.9} />)}
      </svg>
    </button>
  );
}

const ChannelRow = memo(function ChannelRow({ channel, notes, steps, length, patternId, selected, mixerCount, index }) {
  const st = useStore.getState();
  const stepView = isStepView(notes, channel);
  const menu = (e) => st.showContextMenu(e, [
    { header: channel.name },
    { label: 'Piano roll', shortcut: 'F7', onClick: () => st.openPianoRoll(channel.id) },
    { label: 'Channel settings', onClick: () => st.openChannelSettings(channel.id) },
    { label: 'Rename…', onClick: () => renameChannel(channel.id) },
    { label: 'Color', submenu: COLORS.map((c) => ({ label: <span className="swatch-label"><span className="swatch" style={{ background: c }} />{c}</span>, onClick: () => st.dispatch([{ type: 'channel/update', id: channel.id, patch: { color: c } }]) })) },
    { label: 'Clone', onClick: () => cloneChannel(channel.id) },
    '-',
    { label: 'Fill each 2 steps', onClick: () => fillSteps(patternId, channel.id, 2) },
    { label: 'Fill each 4 steps', onClick: () => fillSteps(patternId, channel.id, 4) },
    { label: 'Fill each 8 steps', onClick: () => fillSteps(patternId, channel.id, 8) },
    { label: 'Shift left', onClick: () => shiftSteps(patternId, channel.id, -1) },
    { label: 'Shift right', onClick: () => shiftSteps(patternId, channel.id, 1) },
    { label: 'Randomize', onClick: () => randomizeSteps(patternId, channel.id) },
    { label: 'Clear', onClick: () => st.dispatch([{ type: 'notes/remove', patternId, channelId: channel.id }]) },
    '-',
    { label: 'Move up', disabled: index === 0, onClick: () => st.dispatch([{ type: 'channel/move', id: channel.id, index: index - 1 }]) },
    { label: 'Move down', onClick: () => st.dispatch([{ type: 'channel/move', id: channel.id, index: index + 1 }]) },
    { label: 'Delete', danger: true, onClick: () => deleteChannel(channel.id) }
  ]);
  const upd = (patch, key) => st.dispatch([{ type: 'channel/update', id: channel.id, patch }], { coalesce: key ? `${key}:${channel.id}` : null });
  return (
    <div className={`ch-row ${selected ? 'selected' : ''} ${channel.mute ? 'muted' : ''}`} onContextMenu={menu}>
      <Led on={!channel.mute} label={`${channel.name} on`} title={channel.mute ? 'Unmute (Ctrl+click: solo)' : 'Mute (Ctrl+click: solo)'} color="var(--led)"
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) upd({ solo: !channel.solo });
          else upd({ mute: !channel.mute });
        }} />
      <Knob value={channel.pan} min={-1} max={1} def={0} bipolar size={22} title={`Pan ${Math.round(channel.pan * 100)}`} onChange={(v) => upd({ pan: v }, 'pan')} />
      <Knob value={channel.volume} min={0} max={1.25} def={0.78} size={22} title={`Volume ${Math.round(channel.volume * 100)}%`} onChange={(v) => upd({ volume: v }, 'vol')} />
      <DragNumber value={channel.mixerTrack} min={0} max={mixerCount - 1} step={1} sensitivity={0.08} className="ch-mixer"
        format={(v) => (v === 0 ? 'M' : String(v))} title="Mixer insert (drag / double-click)"
        onChange={(v) => upd({ mixerTrack: v }, 'route')} />
      <button className={`ch-name ${channel.solo ? 'solo' : ''}`} style={{ '--ch-color': channel.color }}
        onClick={() => { st.selectChannel(channel.id); }}
        onDoubleClick={() => st.openChannelSettings(channel.id)}
        title={`${channel.name} — ${INSTRUMENTS[channel.instrument.kind].label} (${channel.instrument.preset}). Double-click for settings`}>
        {channel.name}
      </button>
      <div className="ch-steps">
        {stepView
          ? <StepRow channel={channel} notes={notes} steps={steps} patternId={patternId} />
          : <MiniRoll notes={notes} length={length} onOpen={() => st.openPianoRoll(channel.id)} />}
      </div>
      <button className="ch-pr" title="Piano roll" onClick={() => st.openPianoRoll(channel.id)}><Icon name="piano" size={13} /></button>
    </div>
  );
});

function AddChannelButton() {
  const st = useStore.getState();
  return (
    <button className="btn add-channel" title="Add channel" onClick={(e) => st.showContextMenu(e, [
      { header: 'Add instrument' },
      // category → instrument → preset (plugin instruments are added from the Browser)
      ...INSTRUMENT_CATEGORIES.filter(([cat]) => cat !== 'plugins').map(([cat, label]) => ({
        label,
        submenu: INSTRUMENT_KINDS.filter((k) => INSTRUMENTS[k].category === cat).map((k) => {
          const presets = Object.keys(INSTRUMENTS[k].presets);
          return { label: INSTRUMENTS[k].label, submenu: presets.map((pr) => ({ label: pr, onClick: () => addChannel(k, { preset: pr, name: presets.length > 1 && pr !== presets[0] ? pr : undefined }) })) };
        })
      }))
    ])}>
      <Icon name="plus" size={14} /> Channel
    </button>
  );
}

export function ChannelRack() {
  const project = useStore((s) => s.project);
  const patternId = useStore((s) => s.selectedPatternId);
  const selectedChannelId = useStore((s) => s.selectedChannelId);
  const mode = useStore((s) => s.mode);
  const st = useStore.getState();
  const playRef = useRef(null);
  const [dropOver, setDropOver] = useState(false);
  const pattern = project.patterns.find((p) => p.id === patternId) || project.patterns[0];
  const length = patternLength(project, pattern);
  const steps = Math.round(length / STEP);

  usePlayheadLine(playRef, (tick) => {
    if (useStore.getState().mode !== 'pattern') return null;
    const i = Math.floor(tick / STEP) % steps;
    return stepX(i);
  }, [steps]);

  const onDrop = (e) => {
    setDropOver(false);
    const inst = e.dataTransfer.getData(DND_INSTRUMENT);
    const smp = e.dataTransfer.getData(DND_SAMPLE);
    if (inst) { e.preventDefault(); const { kind, preset } = JSON.parse(inst); addChannel(kind, { preset }); }
    else if (smp) { e.preventDefault(); addSamplerChannel(JSON.parse(smp)); }
  };

  const toolbar = (
    <>
      <span className="rack-pattern" style={{ '--pat-color': pattern.color }}>{pattern.name}</span>
      <span className="label">Swing</span>
      <Knob value={project.swing} min={0} max={1} def={0} size={22} title={`Swing ${Math.round(project.swing * 100)}%`}
        onChange={(v) => st.dispatch([{ type: 'project/update', patch: { swing: v } }], { coalesce: 'swing' })} />
      <span className="label">Steps</span>
      <DragNumber value={steps} min={1} max={256} step={1} sensitivity={0.15} className="steps-num"
        onChange={(v) => setPatternSteps(pattern.id, v)} title="Pattern length in steps (drag / double-click)" />
    </>
  );

  return (
    <Window name="channelRack" title="Channel rack" icon="rack" toolbar={toolbar} minW={420} minH={140}>
      <div className={`channel-rack ${dropOver ? 'drop' : ''}`}
        onDragOver={(e) => { if (isStudioDrag(e)) { e.preventDefault(); setDropOver(true); } }}
        onDragLeave={() => setDropOver(false)} onDrop={onDrop}
        onPointerUp={() => { paint.active = false; }} onPointerLeave={() => { paint.active = false; }}>
        <div className="rack-rows">
          <div className="rack-playhead-wrap">
            <div ref={playRef} className="rack-playhead" style={{ width: STEP_W }} />
          </div>
          {project.channels.map((c, i) => (
            <ChannelRow key={c.id} channel={c} index={i} notes={pattern.notes[c.id]} steps={steps} length={length}
              patternId={pattern.id} selected={c.id === selectedChannelId} mixerCount={project.mixer.length} />
          ))}
          {!project.channels.length && <p className="empty-hint">No channels. Add an instrument from the Browser or the button below — or ask Claude to build a beat.</p>}
        </div>
        <div className="rack-footer">
          <AddChannelButton />
          <span className="hint">{mode === 'song' ? 'Song mode: switch to PAT to loop this pattern' : 'Click/drag steps to paint · right-click to erase · wheel = velocity'}</span>
        </div>
      </div>
    </Window>
  );
}
