import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Window } from './ui/Window.jsx';
import { Icon } from './ui/Icon.jsx';

/** Named snapshots of the current project (also created by Claude via save_version). */
export function Versions() {
  const project = useStore((s) => s.project);
  const open = useStore((s) => s.windows.versions?.open);
  const versionsRev = useStore((s) => s.versionsRev);
  const st = useStore.getState();
  const [list, setList] = useState(null);
  const pid = project?.id;

  const load = useCallback(() => {
    if (!pid) return;
    api.listVersions(pid).then(setList).catch((e) => useStore.getState().toast(e.message, 'error'));
  }, [pid]);
  useEffect(() => { if (open) load(); }, [open, load, versionsRev]);

  if (!project) return null;
  const save = async () => {
    const name = await st.prompt({ title: 'Save version', value: `${project.name} — ${new Date().toLocaleString()}` });
    if (name === null) return;
    try {
      await api.saveVersion(pid, name);
      st.toast('Version saved', 'success');
      load();
    } catch (e) { st.toast(e.message, 'error'); }
  };
  const restore = async (v) => {
    if (!(await st.confirm({ title: `Restore "${v.name}"?`, message: 'The current state will be replaced (save a version first if you want to keep it). You can undo with Ctrl+Z.', okLabel: 'Restore' }))) return;
    try {
      const r = await api.restoreVersion(pid, v.id);
      st.setProjectFromServer(r.project);
      st.toast('Version restored', 'success');
    } catch (e) { st.toast(e.message, 'error'); }
  };
  const remove = async (v) => {
    if (!(await st.confirm({ title: `Delete version "${v.name}"?`, danger: true, okLabel: 'Delete' }))) return;
    await api.deleteVersion(pid, v.id).catch((e) => st.toast(e.message, 'error'));
    load();
  };

  return (
    <Window name="versions" title={`Versions — ${project.name}`} icon="history" minW={360} minH={220}
      toolbar={<button className="btn tiny primary" onClick={save}><Icon name="plus" size={12} /> Save version</button>}>
      <div className="versions">
        {list === null && <div className="spinner" />}
        {list?.length === 0 && <p className="empty-hint">No versions yet. Save one before big changes — Claude can also save versions (save_version) before experimenting.</p>}
        {list?.map((v) => (
          <div key={v.id} className="version-row">
            <div className="version-info">
              <b>{v.name}</b>
              <span className="muted">{new Date(v.createdAt).toLocaleString()} · {v.bpm} BPM · {v.channels} channels · {v.patterns} patterns</span>
            </div>
            <button className="btn tiny" onClick={() => restore(v)}>Restore</button>
            <button className="tbtn small" title="Delete" onClick={() => remove(v)}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
    </Window>
  );
}
