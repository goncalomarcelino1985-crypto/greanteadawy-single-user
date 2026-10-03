import { useState, useEffect, useMemo } from 'react';
import { INSTRUMENTS, INSTRUMENT_KINDS, INSTRUMENT_CATEGORIES, noteName, COLORS, MAX_NUDGE_MS, pluginParamValues } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { Knob } from './ui/Knob.jsx';
import { Select } from './ui/Controls.jsx';
import { ParamControls } from './ParamControls.jsx';
import { pickFile, uploadSamples, openSampleEditor } from '../lib/actions.js';

const BLACK = new Set([1, 3, 6, 8, 10]);

/** Text input that commits on blur / Enter (so typing doesn't spam edits). */
export function CommitInput({ value, onCommit, className, ...rest }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text.trim() && text !== value) onCommit(text.trim()); else setText(value); };
  return (
    <input className={className} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setText(value); }} {...rest} />
  );
}

function MiniKeyboard({ channelId, base }) {
  const st = useStore.getState();
  const keys = [];
  for (let k = base; k < base + 25 && k <= 127; k++) keys.push(k);
  const whites = keys.filter((k) => !BLACK.has(k % 12));
  return (
    <div className="mini-kb" onContextMenu={(e) => e.preventDefault()}>
      {whites.map((k) => (
        <div key={k} className="mk-white" onPointerDown={(e) => { e.preventDefault(); st.liveNoteOn(k, 0.8, channelId); }}
          onPointerUp={() => st.liveNoteOff(k, channelId)} onPointerLeave={() => st.liveNoteOff(k, channelId)}>
          {k % 12 === 0 && <span>{noteName(k)}</span>}
        </div>
      ))}
      <div className="mk-blacks">
        {whites.map((k) => (
          <div key={k} className="mk-slot">
            {BLACK.has((k + 1) % 12) && k + 1 < base + 25 && (
              <div className="mk-black" onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); st.liveNoteOn(k + 1, 0.8, channelId); }}
                onPointerUp={() => st.liveNoteOff(k + 1, channelId)} onPointerLeave={() => st.liveNoteOff(k + 1, channelId)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChannelSettings() {
  const project = useStore((s) => s.project);
  const channelId = useStore((s) => s.selectedChannelId);
  const library = useStore((s) => s.samples);
  const folders = useStore((s) => s.sampleFolders);
  // the sample picker lists samples by folder (A–Z), unfiled ones last
  const samples = useMemo(() => {
    if (!folders.length) return library;
    const name = new Map(folders.map((f) => [f.id, f.name]));
    const order = new Map(folders.map((f, i) => [f.id, i]));
    const rank = (s) => (order.has(s.folderId) ? order.get(s.folderId) : folders.length);
    return [...library].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((s) => ({ ...s, group: name.get(s.folderId) || 'Unfiled' }));
  }, [library, folders]);
  const plugins = useStore((s) => s.plugins.plugins);
  const pluginErrors = useStore((s) => s.pluginErrors);
  const st = useStore.getState();
  const ch = project.channels.find((c) => c.id === channelId) || project.channels[0];
  if (!ch) {
    return <Window name="channelSettings" title="Channel settings" icon="sliders"><p className="empty-hint">No channel selected.</p></Window>;
  }
  const plugin = ch.instrument.kind === 'plugin' ? plugins.find((p) => p.id === ch.instrument.plugin) || null : null;
  const pluginError = plugin ? pluginErrors[plugin.id] || null : null;
  const instrumentPlugins = plugins.filter((p) => p.enabled && p.type === 'instrument');
  // plugin instruments take their presets, knobs and description from the plugin's manifest
  const def = ch.instrument.kind === 'plugin'
    ? {
        ...INSTRUMENTS.plugin,
        presets: plugin?.manifest.presets || { [ch.instrument.preset]: {} },
        params: plugin?.enabled ? plugin.manifest.params : [],
        description: plugin ? (plugin.enabled ? plugin.manifest.description : `${plugin.name} is disabled (Settings → Plugins): this channel is silent.`) : `The plugin "${ch.instrument.plugin}" is not installed for your account: this channel is silent until it is.`
      }
    : INSTRUMENTS[ch.instrument.kind];
  const upd = (patch, key) => st.dispatch([{ type: 'channel/update', id: ch.id, patch }], { coalesce: key ? `cs:${ch.id}:${key}` : null });
  const kbBase = Math.max(0, Math.min(103, Math.floor((ch.rootKey - 12) / 12) * 12 + 12));

  const toolbar = (
    <Select value={ch.id} onChange={(id) => st.selectChannel(id)} options={project.channels.map((c) => ({ value: c.id, label: c.name }))} title="Channel" />
  );

  return (
    <Window name="channelSettings" title={`Channel — ${ch.name}`} icon="sliders" toolbar={toolbar} minW={360} minH={300} className="channel-settings">
      <div className="cs-body">
        <div className="cs-top">
          <CommitInput className="cs-name" value={ch.name} onCommit={(name) => upd({ name })} aria-label="Channel name" />
          <div className="swatches">
            {COLORS.map((c) => <button key={c} className={`swatch ${c === ch.color ? 'on' : ''}`} style={{ background: c }} onClick={() => upd({ color: c })} aria-label={`Color ${c}`} />)}
          </div>
        </div>
        <fieldset className="param-group">
          <legend>Channel</legend>
          <div className="param-row">
            <Knob value={ch.volume} min={0} max={1.25} def={0.78} label="Volume" showValue size={34} onChange={(v) => upd({ volume: v }, 'vol')} title={`${Math.round(ch.volume * 100)}%`} />
            <Knob value={ch.pan} min={-1} max={1} def={0} bipolar label="Pan" showValue size={34} onChange={(v) => upd({ pan: v }, 'pan')} />
            <Knob value={ch.pitch} min={-24} max={24} def={0} step={1} bipolar label="Pitch" unit="st" showValue size={34} onChange={(v) => upd({ pitch: v }, 'pitch')} />
            <Knob value={ch.filterCutoff} min={20} max={20000} def={20000} curve="log" label="Cutoff" unit="Hz" showValue size={34} onChange={(v) => upd({ filterCutoff: v }, 'fc')} />
            <Knob value={ch.filterRes} min={0.1} max={20} def={0.7} curve="log" label="Reso" showValue size={34} onChange={(v) => upd({ filterRes: v }, 'fr')} />
            <Knob value={ch.nudge ?? 0} min={-MAX_NUDGE_MS} max={MAX_NUDGE_MS} def={0} bipolar label="Nudge" unit="ms" showValue size={34}
              title="Play this channel early (-) or late (+): a lazy snare, pushed hats" onChange={(v) => upd({ nudge: Math.round(v * 10) / 10 }, 'nudge')} />
            <Knob value={ch.swingMix ?? 1} min={0} max={1} def={1} label="Swing" showValue size={34}
              title="How much of the project swing this channel gets" onChange={(v) => upd({ swingMix: Math.round(v * 100) / 100 }, 'swingMix')} />
            <label className="param-select">
              <Select value={ch.mixerTrack} onChange={(v) => upd({ mixerTrack: Number(v) })}
                options={project.mixer.map((m, i) => ({ value: i, label: i === 0 ? 'Master' : `${i}. ${m.name}` }))} />
              <span>Mixer</span>
            </label>
            <label className="param-select">
              <Select value={ch.chokeGroup} onChange={(v) => upd({ chokeGroup: Number(v) })}
                options={Array.from({ length: 9 }, (_, i) => ({ value: i, label: i ? `Group ${i}` : 'None' }))} />
              <span>Cut group</span>
            </label>
            <label className="param-select">
              <Select value={ch.rootKey} onChange={(v) => upd({ rootKey: Number(v) })}
                options={Array.from({ length: 128 }, (_, i) => ({ value: i, label: noteName(i) }))} />
              <span>Step note</span>
            </label>
          </div>
        </fieldset>
        <fieldset className="param-group">
          <legend>Instrument</legend>
          <div className="param-row">
            <label className="param-select">
              <Select value={ch.instrument.kind === 'plugin' ? `plugin:${ch.instrument.plugin}` : ch.instrument.kind}
                onChange={(v) => {
                  if (v.startsWith('plugin:')) {
                    const pl = instrumentPlugins.find((p) => p.id === v.slice(7));
                    const pr = Object.keys(pl.manifest.presets)[0];
                    upd({ instrument: { kind: 'plugin', plugin: pl.id, preset: pr, params: pluginParamValues(pl.manifest, pr) }, rootKey: pl.manifest.defaultKey, color: pl.manifest.color });
                  } else upd({ instrument: { kind: v } });
                }}
                options={[
                  ...INSTRUMENT_CATEGORIES.filter(([cat]) => cat !== 'plugins').flatMap(([cat, group]) =>
                    INSTRUMENT_KINDS.filter((k) => INSTRUMENTS[k].category === cat).map((k) => ({ value: k, label: INSTRUMENTS[k].label, group }))),
                  ...instrumentPlugins.map((p) => ({ value: `plugin:${p.id}`, label: `Plugin: ${p.name}`, group: 'Plugins' })),
                  ...(ch.instrument.kind === 'plugin' && !instrumentPlugins.some((p) => p.id === ch.instrument.plugin) ? [{ value: `plugin:${ch.instrument.plugin}`, label: `Plugin: ${plugin?.name || ch.instrument.plugin} (${plugin ? 'disabled' : 'missing'})`, group: 'Plugins' }] : [])
                ]} />
              <span>Type</span>
            </label>
            <label className="param-select">
              <Select value={ch.instrument.preset}
                onChange={(preset) => upd({ instrument: plugin ? { preset, params: pluginParamValues(plugin.manifest, preset) } : { preset } })}
                options={Object.keys(def.presets)} />
              <span>Preset</span>
            </label>
            {def.description && <p className="cs-desc">{def.description}</p>}
            {pluginError && <p className="form-error">Plugin error: {pluginError}</p>}
          </div>
        </fieldset>
        <ParamControls defs={def.params} values={ch.instrument.params} color={ch.color} samples={samples}
          onSamplePick={async () => {
            const f = await pickFile('audio/*');
            if (!f) return;
            const [item] = await uploadSamples([f]);
            if (item) upd({ instrument: { params: { sampleId: item.id } } });
          }}
          onSampleEdit={(id) => openSampleEditor(id)}
          onChange={(key, v) => upd({ instrument: { params: { [key]: v } } }, `p:${key}`)} />
        <MiniKeyboard channelId={ch.id} base={kbBase} />
      </div>
    </Window>
  );
}
