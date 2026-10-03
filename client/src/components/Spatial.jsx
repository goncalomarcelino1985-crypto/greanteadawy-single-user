import { useRef, useState } from 'react';
import { SPEAKER_LAYOUTS, SPATIAL_EXPORTS, SPATIAL_EXPORT_IDS, POSITION_PRESETS, normalizeInsertSpatial, isSpatialObject } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { Knob } from './ui/Knob.jsx';
import { Icon } from './ui/Icon.jsx';
import { exportSpatialFromUi } from '../lib/actions.js';

const ROOM = 260; // px, the room seen from above (front wall at the top)
const PRESETS = [['front-left', 'FL'], ['center', 'C'], ['front-right', 'FR'], ['left', 'L'], ['overhead', 'Top'], ['right', 'R'], ['rear-left', 'RL'], ['rear', 'Rear'], ['rear-right', 'RR']];
const toPx = (x, y) => [((x + 1) / 2) * ROOM, ((1 - y) / 2) * ROOM];

/** Speakers of the 7.1.4 layout drawn on the room plan (ear level as circles, height speakers as squares). */
function Speakers() {
  return SPEAKER_LAYOUTS['7.1.4'].speakers.filter(([, d]) => d).map(([id, d]) => {
    // directions → the room walls (scale the direction until it hits the square)
    const m = Math.max(Math.abs(d[0]), Math.abs(d[1])) || 1;
    const [px, py] = toPx((d[0] / m) * (d[2] ? 0.55 : 0.97), (d[1] / m) * (d[2] ? 0.55 : 0.97));
    return d[2]
      ? <rect key={id} x={px - 5} y={py - 5} width="10" height="10" rx="2" className="spk top"><title>{id} (height)</title></rect>
      : <circle key={id} cx={px} cy={py} r="5" className="spk"><title>{id}</title></circle>;
  });
}

/** The spatial (Atmos-style) mixer: which inserts are 3D objects and where they sit in the room. */
export function Spatial() {
  const project = useStore((s) => s.project);
  const sel = useStore((s) => s.selectedObject);
  const st = useStore.getState();
  const svg = useRef(null);
  const [drag, setDrag] = useState(null);
  if (!project) return null;
  const sp = project.spatial || { enabled: false, monitor: 'stereo' };
  const candidates = project.mixer.map((m, i) => ({ m, i })).filter(({ i }) => i > 0);
  const objects = candidates.filter(({ m }) => m.spatial?.enabled);
  const selected = sel && project.mixer[sel] ? sel : objects[0]?.i ?? null;
  const cur = selected ? normalizeInsertSpatial(project.mixer[selected].spatial, project.mixer[selected].pan) : null;

  const setProject = (patch) => st.dispatch([{ type: 'project/update', patch: { spatial: { ...sp, ...patch } } }]);
  const place = (i, patch, coalesce) => {
    const m = project.mixer[i];
    st.dispatch([{ type: 'mixer/update', index: i, patch: { spatial: { ...normalizeInsertSpatial(m.spatial, m.pan), ...patch } } }], { coalesce: coalesce ? `sp${coalesce}:${i}` : null });
  };
  const toggleObject = (i, on) => {
    const ops = [{ type: 'mixer/update', index: i, patch: { spatial: { ...normalizeInsertSpatial(project.mixer[i].spatial, project.mixer[i].pan), enabled: on } } }];
    if (on && !sp.enabled) ops.unshift({ type: 'project/update', patch: { spatial: { ...sp, enabled: true } } });
    st.dispatch(ops);
    if (on) useStore.setState({ selectedObject: i });
  };
  const pointer = (e) => {
    const r = svg.current.getBoundingClientRect();
    const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    const y = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2));
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  };
  const onDown = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    useStore.setState({ selectedObject: i });
    setDrag(i);
  };
  const onMove = (e) => { if (drag !== null) place(drag, pointer(e), 'xy'); };

  const toolbar = (
    <>
      <button className={`toggle ${sp.enabled ? 'on' : ''}`} aria-pressed={sp.enabled} title="Render 3D objects (otherwise everything is the stereo mix)" onClick={() => setProject({ enabled: !sp.enabled })}>3D {sp.enabled ? 'ON' : 'OFF'}</button>
      <span className="label">Monitor</span>
      <select className="ui-select" value={sp.monitor} onChange={(e) => setProject({ monitor: e.target.value })} onKeyDown={(e) => e.stopPropagation()} title="What you hear in the studio">
        <option value="stereo">Stereo fold-down</option>
        <option value="binaural">Binaural (headphones)</option>
      </select>
      <button className="tbtn small text" title="Render a spatial deliverable into Projects → Exports" onClick={(e) => st.showContextMenu(e, [
        { header: 'Export spatial mix (48 kHz / 24-bit)' },
        ...SPATIAL_EXPORT_IDS.map((k) => ({ label: SPATIAL_EXPORTS[k].label, disabled: !objects.length, onClick: () => exportSpatialFromUi(k) }))
      ])}><Icon name="download" size={13} /> Export</button>
    </>
  );

  return (
    <Window name="spatial" title="Spatial mixer (3D)" icon="spatial" toolbar={toolbar} minW={460} minH={340} className="spatial">
      <div className="spatial-layout">
        <div className="room-wrap">
          <svg ref={svg} className={`room ${sp.enabled ? '' : 'off'}`} viewBox={`-14 -14 ${ROOM + 28} ${ROOM + 28}`} onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}
            role="img" aria-label="Room seen from above; front at the top">
            <rect x="0" y="0" width={ROOM} height={ROOM} rx="6" className="room-floor" />
            <line x1={ROOM / 2} y1="0" x2={ROOM / 2} y2={ROOM} className="room-axis" />
            <line x1="0" y1={ROOM / 2} x2={ROOM} y2={ROOM / 2} className="room-axis" />
            <text x={ROOM / 2} y="-4" className="room-label" textAnchor="middle">FRONT</text>
            <text x={ROOM / 2} y={ROOM + 12} className="room-label" textAnchor="middle">BACK</text>
            <Speakers />
            <g className="listener"><circle cx={ROOM / 2} cy={ROOM / 2} r="7" /><path d={`M${ROOM / 2 - 4} ${ROOM / 2 - 5} L${ROOM / 2} ${ROOM / 2 - 12} L${ROOM / 2 + 4} ${ROOM / 2 - 5}`} /></g>
            {objects.map(({ m, i }) => {
              const s = normalizeInsertSpatial(m.spatial, m.pan);
              const [px, py] = toPx(s.x, s.y);
              const active = isSpatialObject(project, i);
              return (
                <g key={m.id} className={`obj ${i === selected ? 'sel' : ''} ${active ? '' : 'inactive'}`} transform={`translate(${px} ${py})`}
                  onPointerDown={(e) => onDown(e, i)} data-testid={`obj-${i}`}>
                  <circle r={9 + s.z * 7} className="obj-height" />
                  <circle r="9" style={{ fill: m.color || 'var(--accent-3)' }} />
                  <text y="3.5" textAnchor="middle">{i}</text>
                  <title>{`${m.name}: x ${s.x}, y ${s.y}, height ${s.z}${active ? '' : ' (inactive: routed to a bus or 3D is off)'}`}</title>
                </g>
              );
            })}
          </svg>
          <p className="muted small">Drag objects; the ring shows height. Squares are height speakers (7.1.4).</p>
        </div>
        <div className="spatial-side">
          {selected && cur ? (
            <div className="obj-panel">
              <h4>{selected}. {project.mixer[selected].name}</h4>
              <div className="knob-row">
                <Knob label="Left/right" value={cur.x} min={-1} max={1} def={0} bipolar showValue onChange={(v) => place(selected, { x: v }, 'x')} />
                <Knob label="Back/front" value={cur.y} min={-1} max={1} def={1} bipolar showValue onChange={(v) => place(selected, { y: v }, 'y')} />
                <Knob label="Height" value={cur.z} min={0} max={1} def={0} showValue onChange={(v) => place(selected, { z: v }, 'z')} />
                <Knob label="LFE" value={cur.lfe} min={0} max={1} def={0} showValue onChange={(v) => place(selected, { lfe: v }, 'lfe')} />
              </div>
              <div className="preset-grid">
                {PRESETS.map(([k, label]) => (
                  <button key={k} className="btn tiny" onClick={() => { const [x, y, z] = POSITION_PRESETS[k]; place(selected, { x, y, z }); }}>{label}</button>
                ))}
              </div>
              {project.mixer[selected].output !== 0 && <p className="notice warn">Routed to insert {project.mixer[selected].output}: only inserts that go straight to the master can be 3D objects.</p>}
            </div>
          ) : <p className="empty-hint">Tick inserts below to make them 3D objects.</p>}
          <h4>Inserts</h4>
          <div className="obj-list">
            {candidates.map(({ m, i }) => (
              <label key={m.id} className={`obj-row ${i === selected ? 'sel' : ''}`} onClick={() => m.spatial?.enabled && useStore.setState({ selectedObject: i })}>
                <input type="checkbox" checked={!!m.spatial?.enabled} disabled={m.output !== 0 && !m.spatial?.enabled} onChange={(e) => toggleObject(i, e.target.checked)} />
                <span className="obj-num">{i}</span>
                <span className="obj-name">{m.name}</span>
                <span className="muted">{m.spatial?.enabled ? '3D' : m.output ? `→ ${m.output}` : 'bed'}</span>
              </label>
            ))}
          </div>
          <p className="muted small">Objects leave the stereo bed: binaural monitoring and 5.1/7.1/7.1.4/ADM exports place them in 3D. Claude can place and move them too (place_object, move_object).</p>
        </div>
      </div>
    </Window>
  );
}
