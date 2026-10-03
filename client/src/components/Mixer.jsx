import { useRef, useState } from 'react';
import { EFFECTS, EFFECT_TYPES, uid, isSpatialObject, normalizeInsertSpatial, pluginParamValues } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { Knob } from './ui/Knob.jsx';
import { Fader, Led, Select, useAnimationFrame } from './ui/Controls.jsx';
import { Icon } from './ui/Icon.jsx';
import { ParamControls } from './ParamControls.jsx';
import { getEngine } from '../audio/index.js';

function Strip({ insert, index, selected, meterRef, mixerLen, object }) {
  const st = useStore.getState();
  const open3d = () => { useStore.setState({ selectedObject: index }); st.openWindow('spatial'); };
  const upd = (patch, key) => st.dispatch([{ type: 'mixer/update', index, patch }], { coalesce: key ? `mx${key}:${index}` : null });
  return (
    <div className={`strip ${selected ? 'selected' : ''} ${index === 0 ? 'master' : ''} ${insert.mute ? 'muted' : ''}`}
      onPointerDown={() => useStore.setState({ selectedInsert: index })}
      onContextMenu={(e) => st.showContextMenu(e, [
        { header: insert.name },
        { label: 'Rename…', onClick: async () => { const name = await st.prompt({ title: 'Rename insert', value: insert.name }); if (name) upd({ name }); } },
        index > 0 && { label: insert.solo ? 'Unsolo' : 'Solo', onClick: () => upd({ solo: !insert.solo }) },
        { label: 'Reset fader', onClick: () => upd({ volume: index === 0 ? 1 : 0.8, pan: 0 }) },
        index > 0 && { label: insert.spatial?.enabled ? 'Back to the stereo bed (not 3D)' : 'Make 3D object…', onClick: () => {
          const spatial = { ...normalizeInsertSpatial(insert.spatial, insert.pan), enabled: !insert.spatial?.enabled };
          const sp = st.project.spatial;
          st.dispatch([...(spatial.enabled && !sp?.enabled ? [{ type: 'project/update', patch: { spatial: { ...sp, enabled: true } } }] : []), { type: 'mixer/update', index, patch: { spatial } }]);
          if (spatial.enabled) open3d();
        } },
        { label: 'Remove all effects', danger: true, disabled: !insert.effects.length, onClick: () => st.dispatch(insert.effects.map((fx) => ({ type: 'effect/remove', index, effectId: fx.id }))) }
      ].filter(Boolean))}>
      <div className="strip-num">{index === 0 ? 'M' : index}</div>
      <div className="strip-name" title={insert.name} onDoubleClick={async () => { const name = await st.prompt({ title: 'Rename insert', value: insert.name }); if (name) upd({ name }); }}>{insert.name}</div>
      <div className="strip-fx-dots" title={`${insert.effects.length} effect(s)`}>
        {insert.effects.map((fx) => <span key={fx.id} className={fx.enabled ? 'on' : ''} />)}
      </div>
      {object
        ? <button className="strip-3d" title={`3D object at x ${insert.spatial.x}, y ${insert.spatial.y}, height ${insert.spatial.z} — open the spatial mixer`} onClick={open3d}>3D</button>
        : <Knob value={insert.pan} min={-1} max={1} def={0} bipolar size={24} title={`Pan ${Math.round(insert.pan * 100)}`} onChange={(v) => upd({ pan: v }, 'pan')} />}
      <div className="strip-fader-row">
        <div className="meter" ref={meterRef}><div className="meter-fill" /><div className="meter-peak" /></div>
        <Fader value={insert.volume} def={index === 0 ? 1 : 0.8} onChange={(v) => upd({ volume: v }, 'vol')} height={130} />
      </div>
      <div className="strip-db">{insert.volume <= 0.0001 ? '-∞' : (20 * Math.log10(insert.volume)).toFixed(1)}</div>
      <div className="strip-buttons">
        <Led on={!insert.mute} label={`${insert.name} on`} onClick={() => upd({ mute: !insert.mute })} title={insert.mute ? 'Unmute' : 'Mute'} />
        {index > 0 && <button className={`solo-btn ${insert.solo ? 'on' : ''}`} title="Solo" onClick={(e) => { e.stopPropagation(); upd({ solo: !insert.solo }); }}>S</button>}
      </div>
      {index > 0 && (
        <select className="ui-select strip-route" value={insert.output} title="Output routing" onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => upd({ output: Number(e.target.value) })} onPointerDown={(e) => e.stopPropagation()}>
          {Array.from({ length: mixerLen }, (_, i) => i).filter((i) => i !== index).map((i) => <option key={i} value={i}>→ {i === 0 ? 'M' : i}</option>)}
        </select>
      )}
    </div>
  );
}

function EffectSlot({ fx, index, insertIndex, count, color }) {
  const [open, setOpen] = useState(true);
  const channels = useStore((s) => (EFFECTS[fx.type]?.params.some((d) => d.type === 'channel') ? s.project.channels : null));
  const plugin = useStore((s) => (fx.type === 'plugin' ? s.plugins.plugins.find((p) => p.id === fx.plugin) || null : null));
  const pluginError = useStore((s) => (fx.type === 'plugin' ? s.pluginErrors[fx.plugin] || null : null));
  const st = useStore.getState();
  // plugin effects take their name and knobs from the plugin's manifest
  const def = fx.type === 'plugin'
    ? { label: plugin ? plugin.name : `Missing plugin ${fx.plugin || ''}`, description: plugin?.manifest.description || 'This plugin is not installed (or is disabled) for your account: the slot passes audio through.', params: plugin?.enabled ? plugin.manifest.params : [] }
    : EFFECTS[fx.type];
  const op = (o, coalesce) => st.dispatch([{ ...o, index: insertIndex, effectId: fx.id }], { coalesce });
  return (
    <div className={`fx-slot ${fx.enabled ? '' : 'bypassed'}`}>
      <div className="fx-head">
        <Led on={fx.enabled} label={`${EFFECTS[fx.type]?.label || fx.type} enabled`} onClick={() => op({ type: 'effect/update', patch: { enabled: !fx.enabled } })} title={fx.enabled ? 'Bypass' : 'Enable'} />
        <button className="fx-name" onClick={() => setOpen(!open)} title={pluginError ? `Plugin error (bypassed): ${pluginError}` : def.description}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} /> {def.label}{pluginError && <Icon name="warn" size={11} />}
        </button>
        <button className="tbtn small" disabled={index === 0} title="Move up" onClick={() => op({ type: 'effect/move', position: index - 1 })}>▲</button>
        <button className="tbtn small" disabled={index === count - 1} title="Move down" onClick={() => op({ type: 'effect/move', position: index + 1 })}>▼</button>
        <button className="tbtn small" title="Remove" onClick={() => op({ type: 'effect/remove' })}><Icon name="close" size={11} /></button>
      </div>
      {open && plugin?.enabled && Object.keys(plugin.manifest.presets).length > 1 && (
        <label className="param-select fx-preset">
          <Select value="" onChange={(pr) => pr && op({ type: 'effect/update', patch: { params: pluginParamValues(plugin.manifest, pr) } })}
            options={[{ value: '', label: 'Load preset…' }, ...Object.keys(plugin.manifest.presets).map((pr) => ({ value: pr, label: pr }))]} />
        </label>
      )}
      {open && (
        <ParamControls defs={def.params} values={fx.params} color={color} compact channels={channels}
          onChange={(key, v) => op({ type: 'effect/update', patch: { params: { [key]: v } } }, `fx:${fx.id}:${key}`)} />
      )}
    </div>
  );
}

export function Mixer() {
  const project = useStore((s) => s.project);
  const selectedInsert = useStore((s) => s.selectedInsert);
  const open = useStore((s) => s.windows.mixer.open);
  const st = useStore.getState();
  const meters = useRef([]);
  const peaks = useRef([]);
  const mixer = project.mixer;
  const effectPlugins = useStore((s) => s.plugins.plugins).filter((p) => p.enabled && p.type === 'effect');
  const sel = Math.min(selectedInsert, mixer.length - 1);
  const ins = mixer[sel];

  useAnimationFrame(() => {
    const eng = getEngine();
    const levels = eng ? eng.getLevels() : [];
    meters.current.forEach((el, i) => {
      if (!el) return;
      const lv = levels[i] || 0;
      const db = lv > 0 ? 20 * Math.log10(lv) : -100;
      const h = Math.max(0, Math.min(1, (db + 48) / 54));
      const prev = peaks.current[i] || 0;
      const peak = Math.max(h, prev - 0.008);
      peaks.current[i] = peak;
      el.firstChild.style.transform = `scaleY(${h})`;
      el.firstChild.classList.toggle('hot', lv > 0.98);
      el.lastChild.style.bottom = `${peak * 100}%`;
    });
  }, open);

  const routed = project.channels.filter((c) => c.mixerTrack === sel);
  const toolbar = (
    <>
      <span className="label">Selected: {sel === 0 ? 'Master' : `${sel}. ${ins.name}`}</span>
      <button className="tbtn small text" title="Add 4 inserts" onClick={() => st.dispatch([{ type: 'mixer/add', count: 4 }])}>+ Inserts</button>
    </>
  );

  return (
    <Window name="mixer" title="Mixer" icon="mixer" toolbar={toolbar} minW={480} minH={260} className="mixer">
      <div className="mixer-layout">
        <div className="strips">
          {mixer.map((m, i) => (
            <Strip key={m.id} insert={m} index={i} selected={i === sel} mixerLen={mixer.length} object={isSpatialObject(project, i)} meterRef={(el) => { meters.current[i] = el; }} />
          ))}
        </div>
        <div className="insert-panel">
          <div className="insert-title">
            <span className="strip-num">{sel === 0 ? 'M' : sel}</span>
            <b>{ins.name}</b>
          </div>
          {routed.length > 0 && <div className="insert-routed">Channels: {routed.map((c) => c.name).join(', ')}</div>}
          <div className="fx-list">
            {ins.effects.map((fx, i) => <EffectSlot key={fx.id} fx={fx} index={i} insertIndex={sel} count={ins.effects.length} color="var(--accent)" />)}
            {ins.effects.length < 10 && (
              <Select value="" className="add-fx" options={[
                { value: '', label: '+ Add effect…' },
                ...EFFECT_TYPES.filter((t) => t !== 'plugin').map((t) => ({ value: t, label: EFFECTS[t].label })),
                ...effectPlugins.map((p) => ({ value: `plugin:${p.id}`, label: `Plugin: ${p.name}` }))
              ]}
                onChange={(type) => {
                  if (!type) return;
                  const lim = ins.effects.findIndex((e) => e.type === 'limiter');
                  const position = sel === 0 && lim >= 0 && type !== 'limiter' ? lim : undefined;
                  const plugin = type.startsWith('plugin:') ? effectPlugins.find((p) => p.id === type.slice(7)) : null;
                  const effect = plugin
                    ? { id: uid('fx'), type: 'plugin', plugin: plugin.id, params: pluginParamValues(plugin.manifest, Object.keys(plugin.manifest.presets)[0]) }
                    : { id: uid('fx'), type };
                  st.dispatch([{ type: 'effect/add', index: sel, position, effect }]);
                }} />
            )}
          </div>
          {sel > 0 && (
            <div className="sends">
              <div className="sends-title">Sends</div>
              {(ins.sends || []).map((s, i) => (
                <div key={i} className="send-row">
                  <span>→ {s.to === 0 ? 'Master' : `${s.to}. ${mixer[s.to]?.name}`}</span>
                  <Knob value={s.amount} min={0} max={1} def={0.5} size={22} title={`Send ${Math.round(s.amount * 100)}%`}
                    onChange={(v) => st.dispatch([{ type: 'mixer/update', index: sel, patch: { sends: ins.sends.map((x, j) => (j === i ? { ...x, amount: v } : x)) } }], { coalesce: `send:${sel}:${i}` })} />
                  <button className="tbtn small" onClick={() => st.dispatch([{ type: 'mixer/update', index: sel, patch: { sends: ins.sends.filter((_, j) => j !== i) } }])}><Icon name="close" size={11} /></button>
                </div>
              ))}
              <Select value="" options={[{ value: '', label: '+ Send to…' }, ...mixer.map((m, i) => ({ value: String(i), label: i === 0 ? 'Master' : `${i}. ${m.name}`, disabled: i === sel || i === 0 || ins.sends?.some((s) => s.to === i) }))]}
                onChange={(v) => { if (v !== '') st.dispatch([{ type: 'mixer/update', index: sel, patch: { sends: [...(ins.sends || []), { to: Number(v), amount: 0.5 }] } }]); }} />
            </div>
          )}
        </div>
      </div>
    </Window>
  );
}
