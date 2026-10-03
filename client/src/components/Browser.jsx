import { useState, useEffect, useCallback } from 'react';
import { INSTRUMENTS, INSTRUMENT_KINDS, INSTRUMENT_CATEGORIES, TEMPLATES } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Icon } from './ui/Icon.jsx';
import { addChannel, addPluginChannel } from '../lib/actions.js';
import { DND_INSTRUMENT } from '../lib/dnd.js';
import { SampleLibrary } from './SampleLibrary.jsx';

// plugin instruments have their own section (installed plugins, above)
const CATS = INSTRUMENT_CATEGORIES.filter(([cat]) => cat !== 'plugins');

function Instruments() {
  const [open, setOpen] = useState({});
  const plugins = useStore((s) => s.plugins.plugins).filter((p) => p.enabled && p.type === 'instrument');
  return (
    <div className="br-list">
      {plugins.length > 0 && (
        <div className="br-section" data-testid="browser-plugins">
          <div className="br-cat">Plugins</div>
          {plugins.map((p) => (
            <div key={p.id}>
              <div className="br-item" title={`${p.manifest.description || p.name} — plugin by ${p.manifest.author || 'unknown'}; click to add`}>
                <button className="br-expand" onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))} aria-label="Show presets">
                  <Icon name={open[p.id] ? 'chevronDown' : 'chevronRight'} size={12} />
                </button>
                <span className="br-dot" style={{ background: p.manifest.color }} />
                <button className="br-name" onClick={() => addPluginChannel(p)}>{p.name}</button>
                <button className="br-add" title="Add to channel rack" onClick={() => addPluginChannel(p)}><Icon name="plus" size={12} /></button>
              </div>
              {open[p.id] && Object.keys(p.manifest.presets).map((pr) => (
                <div key={pr} className="br-item preset">
                  <button className="br-name" onClick={() => addPluginChannel(p, pr)}>{pr}</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {CATS.map(([cat, label]) => (
        <div key={cat} className="br-section">
          <div className="br-cat">{label}</div>
          {INSTRUMENT_KINDS.filter((k) => INSTRUMENTS[k].category === cat).map((kind) => {
            const def = INSTRUMENTS[kind];
            const presets = Object.keys(def.presets);
            return (
              <div key={kind}>
                <div className="br-item" draggable
                  onDragStart={(e) => e.dataTransfer.setData(DND_INSTRUMENT, JSON.stringify({ kind }))}
                  title={`${def.description || def.label} — click to add to the Channel Rack`}>
                  <button className="br-expand" onClick={() => setOpen((o) => ({ ...o, [kind]: !o[kind] }))} aria-label="Show presets">
                    <Icon name={open[kind] ? 'chevronDown' : 'chevronRight'} size={12} />
                  </button>
                  <span className="br-dot" style={{ background: def.color }} />
                  <button className="br-name" onClick={() => addChannel(kind)}>{def.label}</button>
                  <button className="br-add" title="Add to channel rack" onClick={() => addChannel(kind)}><Icon name="plus" size={12} /></button>
                </div>
                {open[kind] && presets.map((pr) => (
                  <div key={pr} className="br-item preset" draggable
                    onDragStart={(e) => e.dataTransfer.setData(DND_INSTRUMENT, JSON.stringify({ kind, preset: pr }))}>
                    <button className="br-name" onClick={() => addChannel(kind, { preset: pr, name: pr })}>{pr}</button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Run an async UI action; failures become an error toast instead of an uncaught rejection. */
const guard = (fn) => Promise.resolve().then(fn).catch((e) => useStore.getState().toast(e.message || String(e), 'error'));

function Exports() {
  const [list, setList] = useState(null);
  const exportsRev = useStore((s) => s.exportsRev); // bumped when a render is saved
  const load = useCallback(() => api.listExports().then(setList).catch(() => setList([])), []);
  useEffect(() => { load(); }, [load, exportsRev]);
  if (!list?.length) return null;
  return (
    <>
      <div className="br-cat">Exports (renders & MIDI)</div>
      {list.slice(0, 20).map((x) => (
        <div key={x.name} className="br-item">
          <Icon name="download" size={13} />
          <a className="br-name" href={x.url} download title={new Date(x.createdAt).toLocaleString()}>{x.name}</a>
          <span className="br-meta">{x.bytes > 1e6 ? `${(x.bytes / 1e6).toFixed(1)}MB` : `${Math.round(x.bytes / 1024)}KB`}</span>
          <button className="br-add" title="Delete" onClick={() => guard(async () => { await api.deleteExport(x.name); load(); })}><Icon name="trash" size={12} /></button>
        </div>
      ))}
    </>
  );
}

function Projects() {
  const projects = useStore((s) => s.projects);
  const current = useStore((s) => s.project?.id);
  const st = useStore.getState();
  const [template, setTemplate] = useState('default');
  return (
    <div className="br-list">
      <div className="br-new">
        <select className="ui-select" value={template} onChange={(e) => setTemplate(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
          {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
        </select>
        <button className="btn primary" onClick={async () => {
          const name = await st.prompt({ title: 'New project', value: template === 'default' || template === 'empty' ? 'Untitled' : TEMPLATES[template].label.split(' (')[0] });
          if (name !== null) st.createProject({ name: name || 'Untitled', template });
        }}>New</button>
      </div>
      {projects.map((p) => (
        <div key={p.id} className={`br-item project ${p.id === current ? 'active' : ''}`}
          onContextMenu={(e) => st.showContextMenu(e, [
            { label: 'Open', onClick: () => st.openProject(p.id) },
            { label: 'Duplicate', onClick: () => guard(async () => { await api.duplicateProject(p.id); st.refreshProjects(); }) },
            { label: 'Delete', danger: true, disabled: projects.length <= 1, onClick: () => guard(async () => {
              if (await st.confirm({ title: `Delete "${p.name}"?`, message: 'This cannot be undone.', danger: true, okLabel: 'Delete' })) {
                // leave the project first, so live sync doesn't treat our own delete as "deleted elsewhere"
                if (p.id === current) st.openProject(projects.find((x) => x.id !== p.id).id);
                await api.deleteProject(p.id);
                await st.refreshProjects();
              }
            }) }
          ])}>
          <Icon name="music" size={13} />
          <button className="br-name" onClick={() => st.openProject(p.id)} title={`Updated ${new Date(p.updatedAt).toLocaleString()}`}>{p.name}</button>
          <span className="br-meta">{Math.round(p.bpm)}</span>
        </div>
      ))}
      <Exports />
    </div>
  );
}

function ClaudePanel() {
  const activity = useStore((s) => s.activity);
  const st = useStore.getState();
  const mcpUrl = `${location.origin}/mcp`;
  const openApi = () => { useStore.setState({ settingsTab: 'api' }); st.openWindow('settings'); };
  const copy = (text) => { navigator.clipboard?.writeText(text); st.toast('Copied', 'success', 1200); };
  return (
    <div className="br-list claude">
      <div className="claude-setup">
        <p><b>Make beats with Claude.</b> Connect the MCP server, then ask e.g. <i>“make a dark trap beat at 145 BPM”</i>. Edits appear here live.</p>
        <div className="copy-row"><code>{mcpUrl}</code><button className="btn tiny" onClick={() => copy(mcpUrl)}>Copy</button></div>
        <button className="btn tiny" onClick={openApi}>API token & setup</button>
      </div>
      <div className="br-cat">Activity</div>
      {activity.length === 0 && <p className="br-empty">No Claude activity yet.</p>}
      {activity.map((a, i) => (
        <div key={i} className="activity-item">
          <span className="activity-time">{new Date(a.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span>{a.text}</span>
        </div>
      ))}
    </div>
  );
}

const TABS = [['instruments', 'Sounds'], ['samples', 'Samples'], ['projects', 'Projects'], ['claude', 'Claude']];

export function Browser() {
  const [tab, setTab] = useState('instruments');
  return (
    <aside className="browser" aria-label="Browser">
      <div className="br-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k === 'claude' && <Icon name="claude" size={11} />}{label}
          </button>
        ))}
      </div>
      {tab === 'instruments' && <Instruments />}
      {tab === 'samples' && <SampleLibrary />}
      {tab === 'projects' && <Projects />}
      {tab === 'claude' && <ClaudePanel />}
    </aside>
  );
}
