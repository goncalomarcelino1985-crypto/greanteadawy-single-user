import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Window } from './ui/Window.jsx';
import { Icon } from './ui/Icon.jsx';
import { SNAP_OPTIONS, pickFile } from '../lib/actions.js';
import { PLUGIN_PERMISSIONS } from '@greanteadawy/core';

const fmtDate = (d) => (d ? new Date(d).toLocaleString() : 'never');
const toastError = (e) => useStore.getState().toast(e.message, 'error');

function copy(text, toast) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard', 'success', 1200), () => toast('Copy failed — select the text and copy it manually', 'warn'));
}

function CopyBlock({ text, secret = false }) {
  const toast = useStore((s) => s.toast);
  return (
    <div className={`copy-block ${secret ? 'secret' : ''}`}>
      <pre>{text}</pre>
      <button type="button" className="btn tiny" onClick={() => copy(text, toast)}><Icon name="copy" size={12} /> Copy</button>
    </div>
  );
}

// ------------------------------------------------------------------ Account
function AccountTab() {
  const user = useStore((s) => s.auth.user);
  const st = useStore.getState();
  const [name, setName] = useState(user.displayName);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg] = useState(null);

  const saveName = async () => {
    try {
      const r = await api.updateMe({ displayName: name });
      st.setUser(r.user);
      st.toast('Display name saved', 'success');
    } catch (e) { st.toast(e.message, 'error'); }
  };
  const changePw = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (pw.next !== pw.confirm) { setMsg({ error: 'New passwords do not match' }); return; }
    try {
      await api.changePassword(pw.current, pw.next);
      setPw({ current: '', next: '', confirm: '' });
      setMsg({ ok: 'Password changed. Other devices were signed out.' });
    } catch (err) { setMsg({ error: err.message }); }
  };

  return (
    <div className="settings-section">
      <div className="settings-grid">
        <span className="k">Username</span><span>{user.username}</span>
        <span className="k">Role</span><span className={`role ${user.role}`}>{user.role}</span>
        <span className="k">Member since</span><span>{fmtDate(user.createdAt)}</span>
      </div>
      <h4>Display name</h4>
      <div className="row">
        <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <button className="btn" onClick={saveName} disabled={!name.trim() || name === user.displayName}>Save</button>
      </div>
      <h4>Change password</h4>
      <form className="stack" onSubmit={changePw} onKeyDown={(e) => e.stopPropagation()}>
        <input className="input" type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
        <input className="input" type="password" placeholder="New password (8+ characters)" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        <input className="input" type="password" placeholder="Confirm new password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
        {msg?.error && <p className="form-error">{msg.error}</p>}
        {msg?.ok && <p className="form-ok">{msg.ok}</p>}
        <button className="btn" type="submit" disabled={!pw.current || !pw.next}>Change password</button>
      </form>
      <h4>Session</h4>
      <button className="btn danger" onClick={() => st.signOut()}>Sign out</button>
    </div>
  );
}

// ------------------------------------------------------------------ API token & MCP
function ApiTab() {
  const st = useStore.getState();
  const mcpWithoutToken = useStore((s) => s.auth.mcpWithoutToken);
  const [info, setInfo] = useState(undefined);
  const [fresh, setFresh] = useState(null);
  const [busy, setBusy] = useState(false);
  const origin = location.origin;

  const load = useCallback(() => api.getToken().then((r) => setInfo(r.token)).catch(toastError), []);
  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    if (info && !(await st.confirm({ title: 'Regenerate API token?', message: 'The current token stops working immediately. Update it wherever you use it (Claude Desktop, Claude Code, scripts).', okLabel: 'Regenerate', danger: true }))) return;
    setBusy(true);
    try {
      const r = await api.generateToken();
      setFresh(r.token);
      setInfo(r.info);
    } catch (e) { st.toast(e.message, 'error'); }
    setBusy(false);
  };
  const remove = async () => {
    if (!(await st.confirm({ title: 'Delete API token?', message: 'Anything using this token (MCP clients, scripts) loses access.', okLabel: 'Delete token', danger: true }))) return;
    try {
      await api.deleteToken();
      setInfo(null);
      setFresh(null);
      st.toast('Token deleted', 'success');
    } catch (e) { st.toast(e.message, 'error'); }
  };

  const tok = fresh || '<YOUR_TOKEN>';
  const desktop = JSON.stringify({
    mcpServers: { greanteadawy: { command: 'node', args: ['/path/to/greanteadawy/server/src/mcp/stdio.js'], env: { GREANTEADAWY_URL: origin, ...(info || fresh ? { GREANTEADAWY_TOKEN: tok } : {}) } } }
  }, null, 2);
  const codeCmd = info || fresh
    ? `claude mcp add --transport http greanteadawy ${origin}/mcp --header "Authorization: Bearer ${tok}"`
    : `claude mcp add --transport http greanteadawy ${origin}/mcp`;

  return (
    <div className="settings-section">
      <p className="muted">
        Your personal API token lets Claude (via MCP) and scripts work in <b>your</b> studio. It is optional while the server allows
        MCP without a token, but using one adds a layer of security: only clients holding the token can reach your projects.
      </p>
      <div className={`notice ${mcpWithoutToken ? 'warn' : 'ok'}`}>
        <Icon name={mcpWithoutToken ? 'link' : 'claude'} size={14} />
        {mcpWithoutToken
          ? 'This server accepts MCP connections without a token from this computer (they act as the default account). Connections over the network always need a token. Admins can require tokens everywhere in Settings → Server.'
          : 'This server requires an API token for MCP.'}
      </div>
      <h4>API token</h4>
      {info === undefined ? <div className="spinner" /> : info ? (
        <div className="token-card">
          <div><code>{info.prefix}••••••••••••</code></div>
          <div className="muted">Created {fmtDate(info.createdAt)} · last used {fmtDate(info.lastUsedAt)}</div>
          <div className="row">
            <button className="btn" onClick={generate} disabled={busy}><Icon name="loop" size={13} /> Regenerate</button>
            <button className="btn danger" onClick={remove}><Icon name="trash" size={13} /> Delete</button>
          </div>
        </div>
      ) : (
        <div className="token-card">
          <div className="muted">No token yet.</div>
          <button className="btn primary" onClick={generate} disabled={busy}><Icon name="plus" size={13} /> Generate token</button>
        </div>
      )}
      {fresh && (
        <div className="fresh-token">
          <b>Copy your new token now — it won't be shown again.</b>
          <CopyBlock text={fresh} secret />
        </div>
      )}
      <h4>Connect Claude</h4>
      <p className="muted">Claude Code (HTTP):</p>
      <CopyBlock text={codeCmd} />
      <p className="muted">Claude Desktop (stdio) — add to <code>claude_desktop_config.json</code>, with the path to this project:</p>
      <CopyBlock text={desktop} />
      <p className="muted">Clients that can't send headers (e.g. some remote connectors) can put the token in the URL — keep that URL secret:</p>
      <CopyBlock text={`${origin}/mcp${info || fresh ? `?token=${tok}` : ''}`} />
    </div>
  );
}

// ------------------------------------------------------------------ Studio prefs
/** ON/OFF switch row (defined at module level so re-renders never remount it and steal focus). */
function Toggle({ on, onChange, label, hint }) {
  return (
    <label className="pref">
      <button type="button" className={`toggle ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange(!on)}>{on ? 'ON' : 'OFF'}</button>
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
    </label>
  );
}

function StudioTab() {
  const followClaude = useStore((s) => s.followClaude);
  const recordQuantize = useStore((s) => s.recordQuantize);
  const metronome = useStore((s) => s.metronome);
  const kbOctave = useStore((s) => s.kbOctave);
  const snap = useStore((s) => s.snap);
  const st = useStore.getState();
  return (
    <div className="settings-section">
      <Toggle on={followClaude} onChange={(v) => st.setPref('followClaude', v)} label="Follow Claude" hint="Open projects automatically when Claude creates or opens one" />
      <Toggle on={recordQuantize} onChange={(v) => st.setPref('recordQuantize', v)} label="Quantize recorded notes" hint="Snap notes played on the keyboard / MIDI to 16th steps" />
      <Toggle on={metronome} onChange={() => st.toggleMetronome()} label="Metronome" hint="Click on every beat while playing" />
      <label className="pref">
        <select className="ui-select" value={kbOctave} onChange={(e) => st.setPref('kbOctave', Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()}>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((o) => <option key={o} value={o}>C{o}</option>)}
        </select>
        <span><b>Computer keyboard octave</b><small>Lowest note of the Z-row piano keys</small></span>
      </label>
      <label className="pref">
        <select className="ui-select" value={snap} onChange={(e) => st.setPref('snap', e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
          {SNAP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span><b>Default snap</b><small>Grid for the piano roll and playlist</small></span>
      </label>
      <button className="btn" onClick={st.resetLayout}>Reset window layout</button>
    </div>
  );
}

// ------------------------------------------------------------------ Admin: users
function UsersTab() {
  const st = useStore.getState();
  const me = useStore((s) => s.auth.user);
  const [users, setUsers] = useState(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'user' });
  const [err, setErr] = useState(null);
  const load = useCallback(() => api.adminUsers().then(setUsers).catch(toastError), []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, okMsg) => {
    try { await fn(); if (okMsg) st.toast(okMsg, 'success'); await load(); } catch (e) { st.toast(e.message, 'error'); }
  };
  const create = async (e) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.adminCreateUser(form);
      setForm({ username: '', displayName: '', password: '', role: 'user' });
      st.toast('User created', 'success');
      load();
    } catch (x) { setErr(x.message); }
  };

  return (
    <div className="settings-section">
      {!users ? <div className="spinner" /> : (
        <table className="users-table">
          <thead><tr><th>User</th><th>Role</th><th>Projects</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? 'disabled' : ''}>
                <td><b>{u.displayName}</b><br /><span className="muted">@{u.username}{u.id === me.id ? ' (you)' : ''}{u.disabled ? ' · disabled' : ''}{u.apiToken ? ' · has token' : ''}</span></td>
                <td><span className={`role ${u.role}`}>{u.role}</span></td>
                <td>{u.projects}</td>
                <td className="muted">{fmtDate(u.lastLoginAt)}</td>
                <td className="actions">
                  {u.id !== me.id && (
                    <button className="btn tiny" onClick={(e) => st.showContextMenu(e, [
                      { label: u.role === 'admin' ? 'Make regular user' : 'Make admin', onClick: () => act(() => api.adminUpdateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Role updated') },
                      { label: u.disabled ? 'Enable account' : 'Disable account', onClick: () => act(() => api.adminUpdateUser(u.id, { disabled: !u.disabled }), u.disabled ? 'Enabled' : 'Disabled (signed out everywhere)') },
                      { label: 'Reset password…', onClick: async () => {
                        const pw = await st.prompt({ title: `New password for @${u.username}`, label: 'At least 8 characters' });
                        if (pw) act(() => api.adminUpdateUser(u.id, { password: pw }), 'Password reset — share it with the user securely');
                      } },
                      '-',
                      { label: 'Delete user and their data…', danger: true, onClick: async () => {
                        if (await st.confirm({ title: `Delete @${u.username}?`, message: `This permanently deletes the account, its ${u.projects} project(s) and ${u.samples} sample(s).`, danger: true, okLabel: 'Delete' })) {
                          act(() => api.adminDeleteUser(u.id), 'User deleted');
                        }
                      } }
                    ])}>Manage ▾</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Add user</h4>
      <form className="stack" onSubmit={create} onKeyDown={(e) => e.stopPropagation()}>
        <div className="row">
          <input className="input" placeholder="Username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
          <input className="input" placeholder="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </div>
        <div className="row">
          <input className="input" type="password" placeholder="Initial password (8+)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          <select className="ui-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        {err && <p className="form-error">{err}</p>}
        <button className="btn primary" type="submit" disabled={!form.username || !form.password}>Create user</button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ Admin: server
function ServerTab() {
  const st = useStore.getState();
  const [s, setS] = useState(null);
  const [users, setUsers] = useState([]);
  useEffect(() => {
    api.adminSettings().then(setS).catch(toastError);
    api.adminUsers().then(setUsers).catch(() => {});
  }, []);
  const update = async (patch) => {
    try {
      const next = await api.adminUpdateSettings(patch);
      setS(next);
      useStore.setState((x) => ({ auth: { ...x.auth, allowRegistration: next.allowRegistration, mcpWithoutToken: next.mcpWithoutToken } }));
      st.toast('Saved', 'success', 1200);
    } catch (e) { st.toast(e.message, 'error'); }
  };
  if (!s) return <div className="settings-section"><div className="spinner" /></div>;
  return (
    <div className="settings-section">
      <Toggle on={s.allowRegistration} onChange={(v) => update({ allowRegistration: v })} label="Open registration" hint="Let anyone who can reach this server create an account" />
      <Toggle on={s.allowPlugins !== false} onChange={(v) => update({ allowPlugins: v }).then(() => useStore.getState().loadPlugins())} label="Allow plugins" hint="Users may install their own instrument, effect and generator plugins (sandboxed, for their account only). PLUGINS_ENABLED=false turns them off regardless." />
      <label className="pref">
        <button type="button" className={`toggle ${s.mcpWithoutToken ? 'on' : ''}`} aria-pressed={s.mcpWithoutToken} onClick={() => update({ mcpWithoutToken: !s.mcpWithoutToken })}>{s.mcpWithoutToken ? 'ON' : 'OFF'}</button>
        <span><b>Allow MCP without a token from this computer</b><small>Convenient for Claude Desktop / Claude Code on the machine running the server. Only requests from this computer (to localhost) qualify — anything coming over the network always needs a personal API token. Turn OFF to require tokens everywhere.</small></span>
      </label>
      <label className="pref">
        <select className="ui-select" value={s.mcpDefaultUserId || ''} disabled={!s.mcpWithoutToken} onChange={(e) => update({ mcpDefaultUserId: e.target.value || null })}>
          <option value="">First admin</option>
          {users.map((u) => <option key={u.id} value={u.id}>@{u.username}</option>)}
        </select>
        <span><b>Token-less MCP acts as</b><small>Whose studio Claude edits when it connects without a token</small></span>
      </label>
    </div>
  );
}

// ------------------------------------------------------------------ Plugins
const TYPE_LABEL = { instrument: 'Instrument', effect: 'Effect', generator: 'Generator' };
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** What an uploaded plugin asks for, and the trust warning the user must confirm before it's installed. */
function InstallReview({ info, onDone, onCancel }) {
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const m = info.manifest;
  const install = async () => {
    setBusy(true);
    try {
      await api.installPlugin(info.token);
      useStore.getState().toast(`Installed ${m.name} ${m.version}`, 'success');
      onDone();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <div className="plugin-review" role="dialog" aria-label={`Install ${m.name}`} data-testid="plugin-review">
      <div className="plugin-warning">
        <Icon name="warn" size={18} />
        <div>
          <b>Only install plugins from people you trust.</b>
          <small>
            A plugin is someone else's code. GreanTeaDawy runs it in a sandbox — no network, no access to your account,
            projects, files or other plugins' data — and checks everything it produces, but a malicious or buggy plugin can
            still make very loud or harmful sound, use a lot of CPU or behave differently from its description.
          </small>
        </div>
      </div>
      <h4>{m.name} <span className="muted">{m.version}{info.update ? ` (update from ${info.update.from})` : ''}</span></h4>
      <div className="settings-grid">
        <span className="k">Type</span><span>{TYPE_LABEL[m.type]}{m.samples.length ? ` (${m.samples.length} samples)` : ''}</span>
        <span className="k">Author</span><span>{m.author || 'unknown'}</span>
        <span className="k">Id</span><span><code>{m.id}</code></span>
        {m.license && <><span className="k">License</span><span>{m.license}</span></>}
        {m.homepage && <><span className="k">Homepage</span><span className="break">{m.homepage}</span></>}
        <span className="k">Size</span><span>{info.files.length} files, {kb(info.totalBytes)}</span>
        <span className="k">SHA-256</span><span className="break mono small">{info.sha256}</span>
      </div>
      {m.description && <p>{m.description}</p>}
      <h4>It asks to</h4>
      <ul className="perm-list">
        {m.permissions.length ? m.permissions.map((p) => <li key={p}><b>{p}</b> — {PLUGIN_PERMISSIONS[p]}</li>) : <li>nothing beyond playing its samples</li>}
        <li className="muted">Never granted to any plugin: network, storage, your account, files, other projects.</li>
      </ul>
      <label className="trust-check">
        <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} data-testid="plugin-trust" />
        I trust {m.author ? `"${m.author}"` : 'the author of this plugin'} and want to install it.
      </label>
      <div className="row">
        <button className="btn primary" disabled={!trusted || busy} onClick={install}>{busy ? 'Installing…' : info.update ? 'Update plugin' : 'Install plugin'}</button>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </div>
  );
}

function PluginsTab() {
  const plugins = useStore((s) => s.plugins);
  const errors = useStore((s) => s.pluginErrors);
  const isAdmin = useStore((s) => s.auth.user?.role === 'admin');
  const [review, setReview] = useState(null);
  const st = useStore.getState();
  useEffect(() => { useStore.getState().loadPlugins(); }, []);
  const choose = async () => {
    const f = await pickFile('.zip,application/zip');
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f, f.name);
    try { setReview(await api.inspectPlugin(fd)); } catch (e) { toastError(e); }
  };
  const done = () => { setReview(null); st.loadPlugins(); };
  if (!plugins.allowed) {
    return (
      <div className="settings-section">
        <p className="notice warn"><Icon name="warn" size={14} /> Plugins are turned off on this server.{isAdmin ? ' Turn them on in Settings → Server (unless PLUGINS_ENABLED=false is set).' : ' Ask an admin to allow them.'}</p>
      </div>
    );
  }
  return (
    <div className="settings-section plugins-settings">
      <p className="muted">Add your own instruments, effects and note generators (.zip packages with a <code>plugin.json</code>). Each plugin is installed for your account only. How to make one: <code>docs/plugins.md</code>.</p>
      {review
        ? <InstallReview info={review} onDone={done} onCancel={() => setReview(null)} />
        : <button className="btn primary" onClick={choose} data-testid="plugin-install"><Icon name="upload" size={13} /> Install plugin…</button>}
      <h4>Installed ({plugins.plugins.length})</h4>
      {!plugins.plugins.length && <p className="empty-hint">No plugins yet.</p>}
      <div className="plugin-list">
        {plugins.plugins.map((p) => (
          <div key={p.id} className={`plugin-row ${p.enabled ? '' : 'off'}`} data-testid={`plugin-${p.id}`}>
            <span className="plugin-dot" style={{ background: p.manifest.color }} />
            <div className="plugin-info">
              <b>{p.name}</b> <span className="muted">{p.version} · {TYPE_LABEL[p.type]}{p.manifest.author ? ` · ${p.manifest.author}` : ''}</span>
              <small>{p.manifest.description}</small>
              <small className="perm-chips">{p.manifest.permissions.map((x) => <span key={x} className="chip">{x}</span>)}</small>
              {errors[p.id] && <small className="form-error">{errors[p.id]}</small>}
            </div>
            <button type="button" className={`toggle ${p.enabled ? 'on' : ''}`} aria-pressed={p.enabled} title={p.enabled ? 'Disable' : 'Enable'}
              onClick={async () => { try { await api.setPluginEnabled(p.id, !p.enabled); st.loadPlugins(); } catch (e) { toastError(e); } }}>{p.enabled ? 'ON' : 'OFF'}</button>
            <button className="tbtn small" title="Remove" onClick={async () => {
              if (!(await st.confirm({ title: `Remove ${p.name}?`, message: 'Channels that use it go silent and its effect slots pass audio through. They keep their settings, so reinstalling brings them back.', danger: true, okLabel: 'Remove' }))) return;
              try { await api.removePlugin(p.id); st.loadPlugins(); } catch (e) { toastError(e); }
            }}><Icon name="trash" size={13} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Audio export (ffmpeg)
function ExportTab() {
  const info = useStore((s) => s.exportFormats);
  const isAdmin = useStore((s) => s.auth.user?.role === 'admin');
  const [busy, setBusy] = useState(false);
  useEffect(() => { useStore.getState().loadExportFormats(); }, []);
  const recheck = async () => {
    setBusy(true);
    await useStore.getState().loadExportFormats(true);
    setBusy(false);
  };
  if (!info) return <div className="settings-section"><div className="spinner" /></div>;
  const { ffmpeg, formats } = info;
  return (
    <div className="settings-section export-settings">
      <div className={`ffmpeg-status ${ffmpeg.available ? 'ok' : 'missing'}`} data-testid="ffmpeg-status">
        <Icon name={ffmpeg.available ? 'check' : 'warn'} size={16} />
        <div>
          <b>{ffmpeg.available ? `ffmpeg ${ffmpeg.version} is available` : 'ffmpeg is not available'}</b>
          <small>
            {ffmpeg.available
              ? 'The server converts your renders to MP3, AAC, Ogg, Opus, FLAC, Apple Lossless and AIFF (File → Export song as…). Claude can ask for them too (list_export_formats, export_audio).'
              : `${ffmpeg.reason || 'Not found'}. WAV export works without it. To enable other formats, install ffmpeg on the server (apt install ffmpeg · brew install ffmpeg · winget install ffmpeg) or point FFMPEG_PATH at it, then check again. The Docker image includes it.`}
          </small>
        </div>
        {isAdmin && <button className="btn" onClick={recheck} disabled={busy}>{busy ? 'Checking…' : 'Check again'}</button>}
      </div>
      <table className="export-formats">
        <thead><tr><th>Format</th><th>Quality</th><th>Status</th></tr></thead>
        <tbody>
          {formats.map((f) => (
            <tr key={f.id} className={f.available ? '' : 'off'}>
              <td><b>{f.label}</b><small>{f.description}</small></td>
              <td>{f.bitrates ? `${f.bitrates[0]}–${f.bitrates.at(-1)} kbps (default ${f.defaultBitrate})` : f.id === 'wav' ? '16 or 24-bit' : 'lossless, 16/24-bit'}</td>
              <td>{f.available ? <span className="ok-badge">{f.encoder ? f.encoder : 'built in'}</span> : <span className="off-badge" title={f.reason}>unavailable</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ffmpeg.checkedAt && <p className="muted">Checked {fmtDate(ffmpeg.checkedAt)}.</p>}
    </div>
  );
}

const TABS = [
  ['account', 'Account', 'user'],
  ['api', 'API & MCP', 'key'],
  ['studio', 'Studio', 'music'],
  ['export', 'Audio export', 'download'],
  ['plugins', 'Plugins', 'plugin'],
  ['users', 'Users', 'rack', true],
  ['server', 'Server', 'gear', true]
];

export function Settings() {
  const user = useStore((s) => s.auth.user);
  const selectedTab = useStore((s) => s.settingsTab) || 'account';
  const singleUser = useStore((s) => s.auth.singleUser);
  const tab = singleUser && ['account', 'users', 'server'].includes(selectedTab) ? 'studio' : selectedTab;
  if (!user) return null;
  const tabs = TABS.filter(([key, , , admin]) => (!singleUser || !['account', 'users', 'server'].includes(key)) && (!admin || user.role === 'admin'));
  return (
    <Window name="settings" title="Settings" icon="gear" minW={420} minH={320} className="settings">
      <div className="settings-layout">
        <nav className="settings-tabs" role="tablist">
          {tabs.map(([k, label, icon]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => useStore.setState({ settingsTab: k })}>
              <Icon name={icon} size={14} /> {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === 'account' && <AccountTab />}
          {tab === 'api' && <ApiTab />}
          {tab === 'studio' && <StudioTab />}
          {tab === 'export' && <ExportTab />}
          {tab === 'plugins' && <PluginsTab />}
          {tab === 'users' && user.role === 'admin' && <UsersTab />}
          {tab === 'server' && user.role === 'admin' && <ServerTab />}
        </div>
      </div>
    </Window>
  );
}
