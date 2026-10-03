import { useRef } from 'react';
import { TEMPLATES, PPQ, STEP, ticksPerBar, SPATIAL_EXPORTS, SPATIAL_EXPORT_IDS } from '@greanteadawy/core';
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';
import { Icon } from './ui/Icon.jsx';
import { Knob } from './ui/Knob.jsx';
import { DragNumber } from './ui/Controls.jsx';
import { Visualizer } from './Visualizer.jsx';
import { usePlayheadTick } from '../lib/hooks.js';
import {
  newPattern, clonePattern, renamePattern, deletePattern, exportWav, exportAs, exportStemsFromUi, exportSpatialFromUi, exportMidi, exportProjectJson,
  importProjectJson, importMidi
} from '../lib/actions.js';
import { connectMidi } from '../lib/midiInput.js';
import { APP_NAME, APP_VERSION } from '../lib/version.js';

/** File → Export song as…: the formats the server's ffmpeg can make (the rest shown disabled, with the reason). */
function exportFormatItems(info) {
  if (!info) return [{ label: 'Checking the server for ffmpeg…', disabled: true }];
  const items = info.formats.filter((f) => f.id !== 'wav').map((f) => ({
    label: `${f.label}${f.bitrates ? ` (${f.defaultBitrate} kbps)` : f.lossless ? ' (24-bit)' : ''}${f.available ? '' : ' — needs ffmpeg'}`,
    disabled: !f.available,
    onClick: () => exportAs(f.id)
  }));
  const lossy = info.formats.filter((f) => f.available && f.bitrates);
  const more = lossy.map((f) => ({ label: `${f.label} at…`, submenu: f.bitrates.map((b) => ({ label: `${b} kbps`, checked: b === f.defaultBitrate, onClick: () => exportAs(f.id, { bitrate: b }) })) }));
  return [
    { header: info.ffmpeg.available ? `via ffmpeg ${info.ffmpeg.version}` : 'ffmpeg not available on the server' },
    ...items,
    ...(more.length ? ['-', ...more] : []),
    '-',
    { label: 'Audio export settings…', onClick: () => { useStore.setState({ settingsTab: 'export' }); useStore.getState().openWindow('settings'); } }
  ];
}

function TimeDisplay() {
  const project = useStore((s) => s.project);
  const tick = usePlayheadTick(30);
  const t = tick ?? 0;
  const bar = ticksPerBar(project);
  const b = Math.floor(t / bar);
  const beat = Math.floor((t - b * bar) / PPQ);
  const step = Math.floor((t - b * bar - beat * PPQ) / STEP);
  const secs = (t / PPQ) * (60 / project.bpm);
  return (
    <div className="time-display" title="Song position (bar : beat : step)">
      <span className="time-main">{String(b + 1).padStart(3, ' ')}:{beat + 1}:{String(step + 1).padStart(2, '0')}</span>
      <span className="time-sub">{Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, '0')}</span>
    </div>
  );
}

function TapTempo() {
  const taps = useRef([]);
  const dispatch = useStore((s) => s.dispatch);
  return (
    <button className="tbtn small tap" title="Tap tempo" onClick={() => {
      const now = performance.now();
      taps.current = taps.current.filter((t) => now - t < 2500);
      taps.current.push(now);
      if (taps.current.length >= 3) {
        const d = taps.current.slice(1).map((t, i) => t - taps.current[i]);
        const bpm = Math.round(60000 / (d.reduce((a, b) => a + b, 0) / d.length));
        dispatch([{ type: 'project/update', patch: { bpm: Math.max(40, Math.min(300, bpm)) } }], { coalesce: 'tap' });
      }
    }}>TAP</button>
  );
}

export function Toolbar() {
  const project = useStore((s) => s.project);
  const mode = useStore((s) => s.mode);
  const playing = useStore((s) => s.playing);
  const recording = useStore((s) => s.recording);
  const metronome = useStore((s) => s.metronome);
  const selectedPatternId = useStore((s) => s.selectedPatternId);
  const windows = useStore((s) => s.windows);
  const browserOpen = useStore((s) => s.browserOpen);
  const connected = useStore((s) => s.connected);
  const claudeActive = useStore((s) => s.claudeActive);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const midiStatus = useStore((s) => s.midiStatus);
  const st = useStore.getState();

  const fileMenu = (e) => st.showContextMenu(e, [
    { header: 'Project' },
    { label: 'New from template', submenu: Object.entries(TEMPLATES).map(([key, t]) => ({ label: t.label, onClick: async () => {
      const name = await st.prompt({ title: 'New project', value: key === 'empty' || key === 'default' ? 'Untitled' : t.label.split(' (')[0] });
      if (name !== null) st.createProject({ name: name || 'Untitled', template: key });
    } })) },
    { label: 'Rename project…', onClick: async () => {
      const name = await st.prompt({ title: 'Rename project', value: project.name });
      if (name) st.dispatch([{ type: 'project/update', patch: { name } }]);
    } },
    { label: 'Time signature…', onClick: async () => {
      const v = await st.prompt({ title: 'Time signature', value: project.timeSig.join('/'), label: 'Beats per bar / beat unit (e.g. 4/4, 3/4, 6/8)' });
      const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v || '');
      if (m) st.dispatch([{ type: 'project/update', patch: { timeSig: [Number(m[1]), Number(m[2])] } }]);
    } },
    { label: 'Versions…', onClick: () => st.openWindow('versions') },
    { label: 'Save a copy', onClick: async () => {
      const p = await api.duplicateProject(project.id, `${project.name} (copy)`);
      st.refreshProjects();
      st.toast(`Saved copy "${p.name}"`, 'success');
    } },
    '-',
    { header: 'Export' },
    { label: 'Export song as WAV', submenu: [
      { label: '16-bit (dithered, for sharing)', onClick: () => exportWav('song', { bitDepth: 16 }) },
      { label: '24-bit (for mastering)', onClick: () => exportWav('song', { bitDepth: 24 }) }
    ] },
    { label: 'Export song as…', submenu: exportFormatItems(st.exportFormats) },
    { label: 'Export pattern loop as WAV', onClick: () => exportWav('pattern') },
    { label: 'Export stems (each channel, to Exports)', onClick: exportStemsFromUi },
    { label: 'Export spatial mix (3D)…', submenu: SPATIAL_EXPORT_IDS.map((k) => ({ label: SPATIAL_EXPORTS[k].label, onClick: () => exportSpatialFromUi(k) })) },
    { label: 'Export MIDI (song)', onClick: () => exportMidi('song') },
    { label: 'Export project file (.json)', onClick: exportProjectJson },
    '-',
    { header: 'Import' },
    { label: 'Import MIDI into current pattern…', onClick: importMidi },
    { label: 'Import project file…', onClick: importProjectJson },
    '-',
    { label: 'Settings…', onClick: () => st.openWindow('settings') },
    { label: 'Connect Claude (API token & MCP)…', onClick: () => { useStore.setState({ settingsTab: 'api' }); st.openWindow('settings'); } },
    { label: 'Follow Claude (auto-open its projects)', checked: st.followClaude, onClick: () => st.setPref('followClaude', !st.followClaude) },
    { label: 'Reset window layout', onClick: st.resetLayout },
    { label: 'Keyboard shortcuts & help', onClick: () => st.openWindow('help') },
    { label: `About ${APP_NAME}…`, onClick: () => st.showAbout() }
  ]);

  const user = useStore.getState().auth.user;
  const initials = (user?.displayName || user?.username || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const userMenu = (e) => st.showContextMenu(e, [
    { header: `${user.displayName} (@${user.username})` },
    { label: 'Account settings', onClick: () => { useStore.setState({ settingsTab: 'account' }); st.openWindow('settings'); } },
    { label: 'API token & MCP', onClick: () => { useStore.setState({ settingsTab: 'api' }); st.openWindow('settings'); } },
    user.role === 'admin' && { label: 'Manage users', onClick: () => { useStore.setState({ settingsTab: 'users' }); st.openWindow('settings'); } },
    '-',
    { label: 'Sign out', onClick: () => st.signOut() }
  ].filter(Boolean));

  const patternMenu = (e) => st.showContextMenu(e, [
    { label: 'New pattern', shortcut: 'F4', onClick: () => newPattern() },
    { label: 'Clone pattern', onClick: () => clonePattern(selectedPatternId) },
    { label: 'Rename…', onClick: () => renamePattern(selectedPatternId) },
    { label: 'Delete', danger: true, onClick: () => deletePattern(selectedPatternId) }
  ]);

  const master = project.mixer[0];
  const winBtn = (name, icon, label, key) => (
    <button className={`tbtn win ${windows[name]?.open ? 'active' : ''}`} title={`${label} (${key})`} onClick={() => st.toggleWindow(name)}>
      <Icon name={icon} size={16} />
    </button>
  );

  return (
    <div className="toolbar" role="toolbar">
      <div className="tb-group">
        <button className="tbtn logo" onClick={fileMenu} title="Menu">
          <span className="logo-mark">◆</span><span className="logo-text">GreanTeaDawy</span><Icon name="chevronDown" size={12} />
        </button>
        <button className="tbtn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={st.undo}><Icon name="undo" /></button>
        <button className="tbtn" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={st.redo}><Icon name="redo" /></button>
      </div>

      <div className="tb-group transport">
        <div className="mode-switch" role="radiogroup" aria-label="Playback mode">
          <button role="radio" aria-checked={mode === 'pattern'} className={mode === 'pattern' ? 'on pat' : ''} onClick={() => st.setMode('pattern')} title="Pattern mode: loop the selected pattern (Shift+L toggles)">PAT</button>
          <button role="radio" aria-checked={mode === 'song'} className={mode === 'song' ? 'on song' : ''} onClick={() => st.setMode('song')} title="Song mode: play the playlist (Shift+L toggles)">SONG</button>
        </div>
        <button className={`tbtn play ${playing ? 'active' : ''}`} title="Play / Stop (Space)" onClick={st.togglePlay}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button className="tbtn" title="Stop" onClick={st.stop}><Icon name="stop" size={16} /></button>
        <button className={`tbtn rec ${recording ? 'active' : ''}`} title="Record: notes you play on the computer keyboard / MIDI while playing are written into the pattern" onClick={() => useStore.setState({ recording: !recording })}>
          <Icon name="record" size={16} />
        </button>
        <button className="tbtn mic" title="Record audio (microphone): opens the recorder" aria-label="Record audio" onClick={() => st.toggleWindow('recorder')}>
          <Icon name="mic" size={16} />
        </button>
        <div className="tempo" title="Tempo (BPM)">
          <DragNumber value={project.bpm} min={20} max={400} step={1} sensitivity={0.3}
            format={(v) => v.toFixed(v % 1 ? 2 : 0)} className="tempo-num"
            onChange={(v) => st.dispatch([{ type: 'project/update', patch: { bpm: v } }], { coalesce: 'bpm' })} />
          <span className="tempo-label">BPM</span>
        </div>
        <TapTempo />
        <button className={`tbtn metro ${metronome ? 'active' : ''}`} title="Metronome" onClick={st.toggleMetronome}><Icon name="metronome" /></button>
        <TimeDisplay />
      </div>

      <div className="tb-group pattern-pick">
        <button className="tbtn small" title="Previous pattern" onClick={() => {
          const i = project.patterns.findIndex((p) => p.id === selectedPatternId);
          if (i > 0) st.selectPattern(project.patterns[i - 1].id);
        }}>‹</button>
        <select className="ui-select pattern-select" value={selectedPatternId || ''} onChange={(e) => st.selectPattern(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()} title="Current pattern">
          {project.patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="tbtn small" title="Next pattern" onClick={() => {
          const i = project.patterns.findIndex((p) => p.id === selectedPatternId);
          if (i < project.patterns.length - 1) st.selectPattern(project.patterns[i + 1].id);
        }}>›</button>
        <button className="tbtn small" title="Pattern options" onClick={patternMenu}><Icon name="plus" size={14} /></button>
      </div>

      <div className="tb-group">
        <Knob value={master.volume} min={0} max={1.25} def={1} size={28} title={`Master volume ${Math.round(master.volume * 100)}%`}
          onChange={(v) => st.dispatch([{ type: 'mixer/update', index: 0, patch: { volume: v } }], { coalesce: 'mastervol' })} />
        <Visualizer />
      </div>

      <div className="tb-group windows">
        <button className={`tbtn win ${browserOpen ? 'active' : ''}`} title="Browser (Alt+F8)" onClick={() => st.setPref('browserOpen', !browserOpen)}><Icon name="folder" /></button>
        {winBtn('playlist', 'playlist', 'Playlist', 'F5')}
        {winBtn('channelRack', 'rack', 'Channel rack', 'F6')}
        {winBtn('pianoRoll', 'piano', 'Piano roll', 'F7')}
        {winBtn('mixer', 'mixer', 'Mixer', 'F9')}
        {winBtn('channelSettings', 'sliders', 'Channel settings', 'F8')}
        <button className={`tbtn win ${windows.spatial?.open ? 'active' : ''}`} title="Spatial mixer (3D / Atmos-style)" onClick={() => st.toggleWindow('spatial')}><Icon name="spatial" size={16} /></button>
        <button className={`tbtn win ${windows.settings?.open ? 'active' : ''}`} title="Settings" onClick={() => st.toggleWindow('settings')}><Icon name="gear" /></button>
      </div>

      <div className="tb-group status">
        <button className={`tbtn small ${midiStatus ? 'active' : ''}`} title={midiStatus || 'Connect MIDI keyboard'} onClick={connectMidi}><Icon name="midi" /></button>
        <span className={`claude-indicator ${claudeActive ? 'active' : ''}`} title={claudeActive ? 'Claude is editing…' : 'Claude (MCP) edits show up here live'}>
          <Icon name="claude" size={14} />{claudeActive ? 'Claude is editing…' : ''}
        </span>
        <span className={`conn ${connected ? 'ok' : 'down'}`} title={connected ? 'Connected to server (live sync)' : 'Disconnected — reconnecting…'} />
        <button className="tbtn small about-btn" title={`About ${APP_NAME} (version ${APP_VERSION})`} aria-label={`About ${APP_NAME}`} data-testid="about-button" onClick={() => st.showAbout()}>
          <Icon name="info" size={16} />
        </button>
        <button className="avatar" title={`${user?.displayName} — account menu`} onClick={userMenu} aria-label="Account menu">{initials}</button>
      </div>
    </div>
  );
}
