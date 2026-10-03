import { useRef, useState } from 'react';
import { EFFECTS, uid, ticksPerBar, STEP } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { DragNumber } from './ui/Controls.jsx';
import { normalize } from '../audio/dsp.js';
import { useElementSize, capturePointer } from '../lib/hooks.js';

const CH_PARAMS = [
  ['volume', 'Volume', (c) => c.volume / 1.25],
  ['pan', 'Pan', (c) => (c.pan + 1) / 2],
  ['filterCutoff', 'Filter cutoff', (c) => Math.log(c.filterCutoff / 20) / Math.log(1000)],
  ['filterRes', 'Filter resonance', (c) => Math.log(c.filterRes / 0.1) / Math.log(200)],
  ['pitch', 'Pitch', (c) => (c.pitch + 24) / 48]
];

export function describeTarget(project, t) {
  if (!t) return '';
  if (t.type === 'channel') return `${project.channels.find((c) => c.id === t.id)?.name || '?'} · ${t.param}`;
  if (t.type === 'mixer') return `Mixer ${t.index} ${project.mixer[t.index]?.name || ''} · ${t.param}`;
  if (t.type === 'master') return `Master · ${t.param}`;
  if (t.type === 'effect') {
    const fx = project.mixer[t.index]?.effects.find((e) => e.id === t.effectId);
    return `${project.mixer[t.index]?.name || ''} ${fx ? EFFECTS[fx.type].label : 'effect'} · ${t.param}`;
  }
  return '';
}

export function createAutomationFor(target, initial, name) {
  const st = useStore.getState();
  const p = st.project;
  const bar = ticksPerBar(p);
  const id = uid('auto');
  const length = bar * 4;
  const used = new Set(p.playlist.clips.map((c) => c.track));
  let track = p.playlist.tracks.length - 1;
  for (let i = p.playlist.tracks.length - 1; i >= 0; i--) if (!used.has(i)) { track = i; break; }
  for (let i = 0; i < p.playlist.tracks.length; i++) if (!used.has(i)) { track = i; break; }
  const v = Math.max(0, Math.min(1, initial ?? 0.5));
  st.dispatch([
    { type: 'automation/add', automation: { id, name, target, length, points: [{ t: 0, v }, { t: length, v }] } },
    { type: 'clip/add', clips: [{ kind: 'automation', refId: id, track, start: Math.floor(st.songStart / bar) * bar, length }] }
  ]);
  useStore.setState({ selectedAutomationId: id });
  st.openWindow('automation');
}

export function AutomationCreateMenu() {
  const st = useStore.getState();
  const open = (e) => {
    const p = useStore.getState().project;
    const items = [
      { header: 'Create automation clip' },
      { label: 'Channels', submenu: p.channels.map((c) => ({ label: c.name, submenu: CH_PARAMS.map(([param, label, get]) => ({ label, onClick: () => createAutomationFor({ type: 'channel', id: c.id, param }, get(c), `${c.name} ${label}`) })) })) },
      { label: 'Mixer', submenu: p.mixer.map((m, i) => ({ label: `${i === 0 ? 'Master' : `${i}. ${m.name}`}`, submenu: [
        { label: 'Volume', onClick: () => createAutomationFor(i === 0 ? { type: 'master', param: 'volume' } : { type: 'mixer', index: i, param: 'volume' }, m.volume / 1.25, `${m.name} Volume`) },
        { label: 'Pan', onClick: () => createAutomationFor(i === 0 ? { type: 'master', param: 'pan' } : { type: 'mixer', index: i, param: 'pan' }, (m.pan + 1) / 2, `${m.name} Pan`) }
      ] })).filter((x, i) => i === 0 || !/^Insert \d+$/.test(p.mixer[i].name)) },
      { label: 'Effects', disabled: !p.mixer.some((m) => m.effects.length), submenu: p.mixer.flatMap((m, i) => m.effects.map((fx) => ({
        label: `${i === 0 ? 'Master' : m.name}: ${EFFECTS[fx.type].label}`,
        submenu: EFFECTS[fx.type].params.filter((d) => d.automatable).map((d) => ({
          label: d.label,
          onClick: () => createAutomationFor({ type: 'effect', index: i, effectId: fx.id, param: d.key }, normalize(fx.params[d.key], d), `${EFFECTS[fx.type].label} ${d.label}`)
        }))
      }))) }
    ];
    st.showContextMenu(e, items);
  };
  return <button className="tbtn small text" title="Create an automation clip" onClick={open}>Auto +</button>;
}

const SHAPES = {
  'Ramp up': () => [{ t: 0, v: 0 }, { t: 1, v: 1 }],
  'Ramp down': () => [{ t: 0, v: 1 }, { t: 1, v: 0 }],
  Swell: () => [{ t: 0, v: 0.1 }, { t: 0.5, v: 1 }, { t: 1, v: 0.1 }],
  'Sine LFO': () => Array.from({ length: 33 }, (_, i) => ({ t: i / 32, v: 0.5 + 0.5 * Math.sin((i / 32) * Math.PI * 8) })),
  Steps: () => [0, 0.25, 0.5, 0.75].flatMap((x, i) => [{ t: x, v: [0.2, 0.8, 0.5, 1][i] }, { t: x + 0.249, v: [0.2, 0.8, 0.5, 1][i] }]),
  Flat: () => [{ t: 0, v: 0.5 }, { t: 1, v: 0.5 }]
};

export function AutomationEditor() {
  const project = useStore((s) => s.project);
  const id = useStore((s) => s.selectedAutomationId);
  const st = useStore.getState();
  const wrap = useRef(null);
  const size = useElementSize(wrap);
  const drag = useRef(null);
  const [hover, setHover] = useState(null);
  const a = project.automations.find((x) => x.id === id) || project.automations[0];

  if (!a) {
    return (
      <Window name="automation" title="Automation" icon="wave" toolbar={<AutomationCreateMenu />}>
        <p className="empty-hint">No automation clips yet. Use “Auto +” to automate a volume, filter or effect parameter over time (song mode).</p>
      </Window>
    );
  }
  const W = Math.max(100, size.width);
  const H = Math.max(60, size.height);
  const bar = ticksPerBar(project);
  const toXY = (p) => [(p.t / a.length) * W, (1 - p.v) * H];
  const fromEvent = (e) => {
    const r = wrap.current.getBoundingClientRect();
    const t = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / W)) * a.length / (STEP / 2)) * (STEP / 2);
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / H));
    return { t, v };
  };
  const setPoints = (points, coalesce = `auto:${a.id}`) => st.dispatch([{ type: 'automation/update', id: a.id, patch: { points } }], { coalesce });

  const onDown = (e) => {
    capturePointer(e);
    const p = fromEvent(e);
    const idx = a.points.findIndex((pt) => {
      const [x, y] = toXY(pt);
      const r = wrap.current.getBoundingClientRect();
      return Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top)) < 8;
    });
    if (e.button === 2) {
      if (idx >= 0 && a.points.length > 1) setPoints(a.points.filter((_, i) => i !== idx));
      return;
    }
    if (idx >= 0) {
      drag.current = { idx };
    } else {
      const points = [...a.points, p].sort((x, y) => x.t - y.t);
      setPoints(points);
      drag.current = { idx: points.indexOf(p) };
    }
  };
  const onMove = (e) => {
    const p = fromEvent(e);
    setHover(p);
    if (!drag.current) return;
    const points = a.points.map((pt, i) => (i === drag.current.idx ? p : pt));
    const moved = points[drag.current.idx];
    points.sort((x, y) => x.t - y.t);
    drag.current.idx = points.indexOf(moved);
    setPoints(points);
  };

  const toolbar = (
    <>
      <select className="ui-select" value={a.id} onChange={(e) => useStore.setState({ selectedAutomationId: e.target.value })} onKeyDown={(e) => e.stopPropagation()}>
        {project.automations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
      <span className="label">{describeTarget(project, a.target)}</span>
      <span className="label">Bars</span>
      <DragNumber value={Math.round((a.length / bar) * 100) / 100} min={0.25} max={64} step={0.25} sensitivity={0.05}
        onChange={(v) => st.dispatch([{ type: 'automation/update', id: a.id, patch: { length: Math.round(v * bar), points: a.points.map((p) => ({ t: p.t * (Math.round(v * bar) / a.length), v: p.v })) } }], { coalesce: `autolen:${a.id}` })} />
      <select className="ui-select" value="" onChange={(e) => { const f = SHAPES[e.target.value]; if (f) setPoints(f().map((p) => ({ t: Math.round(p.t * a.length), v: p.v })), null); }} onKeyDown={(e) => e.stopPropagation()}>
        <option value="">Shape…</option>
        {Object.keys(SHAPES).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <AutomationCreateMenu />
      <button className="tbtn small text danger" title="Delete this automation" onClick={async () => {
        if (await st.confirm({ title: `Delete automation "${a.name}"?`, danger: true, okLabel: 'Delete' })) st.dispatch([{ type: 'automation/remove', id: a.id }]);
      }}>Delete</button>
    </>
  );

  const pts = a.points.map(toXY);
  const beats = [];
  for (let t = 0; t <= a.length; t += 96) beats.push(t);
  return (
    <Window name="automation" title={`Automation — ${a.name}`} icon="wave" toolbar={toolbar} minW={360} minH={160}>
      <div className="auto-editor" ref={wrap} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}
        onPointerLeave={() => setHover(null)} onContextMenu={(e) => e.preventDefault()}>
        <svg width={W} height={H}>
          {beats.map((t) => <line key={t} x1={(t / a.length) * W} x2={(t / a.length) * W} y1={0} y2={H} className={t % bar === 0 ? 'bar' : 'beat'} />)}
          <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="mid" />
          <polygon className="area" points={`0,${H} ${pts.map((p) => p.join(',')).join(' ')} ${W},${pts.length ? pts[pts.length - 1][1] : H} ${W},${H}`} />
          <polyline className="curve" points={`0,${pts[0]?.[1] ?? H / 2} ${pts.map((p) => p.join(',')).join(' ')} ${W},${pts[pts.length - 1]?.[1] ?? H / 2}`} />
          {pts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={5} className="pt" />)}
        </svg>
        {hover && <div className="auto-readout">{Math.round(hover.v * 100)}% @ bar {Math.floor(hover.t / bar) + 1}.{Math.floor((hover.t % bar) / 96) + 1}</div>}
        <div className="auto-help">Click: add point · drag: move · right-click: delete</div>
      </div>
    </Window>
  );
}
