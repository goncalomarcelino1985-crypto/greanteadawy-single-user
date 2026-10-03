import { useState } from 'react';
import { pluginParamValues } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { Window } from './ui/Window.jsx';
import { Select } from './ui/Controls.jsx';
import { Icon } from './ui/Icon.jsx';
import { ParamControls } from './ParamControls.jsx';
import { generateNotes } from '../lib/actions.js';

/** Generator plugins: fill the selected pattern/channel with notes from a plugin (run in the sandbox). */
export function Generate() {
  const project = useStore((s) => s.project);
  const plugins = useStore((s) => s.plugins.plugins);
  const patternId = useStore((s) => s.selectedPatternId);
  const channelId = useStore((s) => s.pianoRollChannelId || s.selectedChannelId);
  const gens = plugins.filter((p) => p.enabled && p.type === 'generator');
  const [pluginId, setPluginId] = useState(null);
  const [preset, setPreset] = useState(null);
  const [values, setValues] = useState({});
  const [bars, setBars] = useState(0);
  const [busy, setBusy] = useState(false);
  if (!project) return null;
  const entry = gens.find((p) => p.id === pluginId) || gens[0] || null;
  const m = entry?.manifest;
  const pr = preset && m && Object.hasOwn(m.presets, preset) ? preset : m ? Object.keys(m.presets)[0] : null;
  const params = m ? { ...pluginParamValues(m, pr), ...values } : {};
  const pattern = project.patterns.find((p) => p.id === patternId) || project.patterns[0];
  const channel = project.channels.find((c) => c.id === channelId) || project.channels[0];
  const run = async (seed) => {
    setBusy(true);
    try {
      const n = await generateNotes({ entry, patternId: pattern.id, channelId: channel.id, params, bars: bars || null, seed });
      useStore.getState().toast(`${entry.name}: ${n} notes on ${channel.name}`, 'success', 1600);
    } catch (e) {
      useStore.getState().toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Window name="generate" title="Generate notes" icon="plugin" minW={340} minH={260} className="generate">
      <div className="generate-body">
        {!gens.length ? (
          <p className="empty-hint">No generator plugins installed. Install one in Settings → Plugins (e.g. the Euclidean Rhythms example: <code>npm run plugin:pack -- --examples</code> puts it in <code>plugins/dist</code>).</p>
        ) : (
          <>
            <div className="row">
              <label className="param-select">
                <Select value={entry.id} onChange={(v) => { setPluginId(v); setPreset(null); setValues({}); }} options={gens.map((p) => ({ value: p.id, label: p.name }))} />
                <span>Generator</span>
              </label>
              <label className="param-select">
                <Select value={pr} onChange={(v) => { setPreset(v); setValues({}); }} options={Object.keys(m.presets)} />
                <span>Preset</span>
              </label>
              <label className="param-select">
                <Select value={bars} onChange={(v) => setBars(Number(v))} options={[{ value: 0, label: 'Pattern' }, ...[1, 2, 4, 8, 16].map((b) => ({ value: b, label: `${b} bar${b > 1 ? 's' : ''}` }))]} />
                <span>Length</span>
              </label>
            </div>
            <p className="muted small">Into <b>{channel?.name}</b> · <b>{pattern?.name}</b> (replaces that range). {m.description}</p>
            <ParamControls defs={m.params} values={params} color="var(--accent-3)" onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))} />
            <div className="row">
              <button className="btn primary" disabled={busy || !channel || !pattern} onClick={() => run()} data-testid="generate-run"><Icon name="plugin" size={13} /> {busy ? 'Generating…' : 'Generate'}</button>
              <span className="muted small">Runs sandboxed in this browser: no network, 2 s limit.</span>
            </div>
          </>
        )}
      </div>
    </Window>
  );
}
