import { memo, useEffect, useRef } from 'react';
import { useStore, COMPACT_WIDTH } from './state/store.js';
import { Toolbar } from './components/Toolbar.jsx';
import { Browser } from './components/Browser.jsx';
import { ChannelRack } from './components/ChannelRack.jsx';
import { PianoRoll } from './components/PianoRoll.jsx';
import { Playlist } from './components/Playlist.jsx';
import { Mixer } from './components/Mixer.jsx';
import { ChannelSettings } from './components/ChannelSettings.jsx';
import { AutomationEditor } from './components/AutomationEditor.jsx';
import { Help } from './components/Help.jsx';
import { Settings } from './components/Settings.jsx';
import { Versions } from './components/Versions.jsx';
import { Spatial } from './components/Spatial.jsx';
import { Generate } from './components/Generate.jsx';
import { WaveEditor } from './components/WaveEditor.jsx';
import { Recorder } from './components/Recorder.jsx';
import { AuthScreen } from './components/AuthScreen.jsx';
import { ContextMenu, Modal, Toasts } from './components/ui/Overlays.jsx';
import { WorkspaceContext } from './components/ui/Window.jsx';
import { ErrorBoundary } from './components/ui/ErrorBoundary.jsx';
import { Icon } from './components/ui/Icon.jsx';
import { useElementSize, useWindowWidth } from './lib/hooks.js';
import { installKeyboard } from './lib/keyboard.js';

// Panels take no props and subscribe to exactly the state they need, so memo() keeps window moves,
// focus changes and unrelated edits from re-rendering every panel.
const Panels = {
  Playlist: memo(Playlist), ChannelRack: memo(ChannelRack), PianoRoll: memo(PianoRoll), Mixer: memo(Mixer),
  ChannelSettings: memo(ChannelSettings), AutomationEditor: memo(AutomationEditor), Help: memo(Help),
  Settings: memo(Settings), Versions: memo(Versions), Browser: memo(Browser), Toolbar: memo(Toolbar), Spatial: memo(Spatial), Generate: memo(Generate),
  WaveEditor: memo(WaveEditor), Recorder: memo(Recorder)
};

/** Open windows, topmost first, as a string so the selector only changes when the set or order changes. */
const openWindowsKey = (s) => Object.entries(s.windows).filter(([, w]) => w.open).sort((a, b) => b[1].z - a[1].z).map(([k]) => k).join(',');

const WINDOW_TABS = [
  ['playlist', 'Playlist', 'playlist'],
  ['channelRack', 'Rack', 'rack'],
  ['pianoRoll', 'Piano', 'piano'],
  ['mixer', 'Mixer', 'mixer'],
  ['channelSettings', 'Channel', 'sliders']
];

export default function App() {
  const phase = useStore((s) => s.auth.phase);
  if (phase !== 'ready') {
    return (
      <>
        <AuthScreen />
        <Toasts />
      </>
    );
  }
  return <Studio />;
}

function Studio() {
  const hasProject = useStore((s) => !!s.project);
  const projectName = useStore((s) => s.project?.name);
  const loading = useStore((s) => s.loading);
  const connected = useStore((s) => s.connected);
  const browserOpen = useStore((s) => s.browserOpen);
  const audioReady = useStore((s) => s.audioReady);
  const pendingPlay = useStore((s) => s.pendingPlay);
  const busy = useStore((s) => s.busy);
  const openKey = useStore(openWindowsKey);
  const wsRef = useRef(null);
  const size = useElementSize(wsRef);
  // decided by the window (not the workspace, whose width itself depends on compact mode → flicker)
  const compact = useWindowWidth() < COMPACT_WIDTH;

  useEffect(() => installKeyboard(), []);
  useEffect(() => {
    const unlock = () => useStore.getState().unlockAudio();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);
  useEffect(() => {
    if (projectName) document.title = `${projectName} — GreanTeaDawy`;
  }, [projectName]);

  if (!hasProject) {
    return (
      <div className="splash">
        <div className="logo-big">◆ GreanTeaDawy</div>
        <p>{loading && connected ? 'Loading project…' : connected ? 'Preparing…' : 'Connecting to the GreanTeaDawy server…'}</p>
        {!connected && <p className="muted">Make sure the server is running: <code>npm run dev</code> or <code>npm start</code></p>}
      </div>
    );
  }

  const openWins = openKey ? openKey.split(',') : [];
  const topWindow = openWins[0] || null;
  const { Playlist: PlaylistP, ChannelRack: RackP, PianoRoll: PianoP, Mixer: MixerP, ChannelSettings: ChanP, AutomationEditor: AutoP, Help: HelpP, Settings: SettingsP, Versions: VersionsP, Browser: BrowserP, Toolbar: ToolbarP, Spatial: SpatialP, Generate: GenerateP, WaveEditor: WaveEditorP, Recorder: RecorderP } = Panels;

  return (
    <div className={`app ${compact ? 'compact' : ''}`}>
      <ErrorBoundary name="Toolbar"><ToolbarP /></ErrorBoundary>
      <div className="main">
        {browserOpen && !compact && <ErrorBoundary name="Browser"><BrowserP /></ErrorBoundary>}
        {/* a click on the empty workspace gives the keyboard back to the studio (Space plays, Ctrl+Z undoes the project) */}
        <div className="workspace" ref={wsRef} onPointerDown={(e) => { if (e.target === e.currentTarget && document.activeElement?.closest?.('.window')) document.activeElement.blur(); }}>
          <WorkspaceContext.Provider value={{ compact, width: size.width, height: size.height, topWindow }}>
            <ErrorBoundary name="Playlist"><PlaylistP /></ErrorBoundary>
            <ErrorBoundary name="Channel rack"><RackP /></ErrorBoundary>
            <ErrorBoundary name="Piano roll"><PianoP /></ErrorBoundary>
            <ErrorBoundary name="Mixer"><MixerP /></ErrorBoundary>
            <ErrorBoundary name="Channel settings"><ChanP /></ErrorBoundary>
            <ErrorBoundary name="Automation"><AutoP /></ErrorBoundary>
            <HelpP />
            <ErrorBoundary name="Settings"><SettingsP /></ErrorBoundary>
            <ErrorBoundary name="Versions"><VersionsP /></ErrorBoundary>
            <ErrorBoundary name="Spatial"><SpatialP /></ErrorBoundary>
            <ErrorBoundary name="Generate"><GenerateP /></ErrorBoundary>
            <ErrorBoundary name="Wave editor"><WaveEditorP /></ErrorBoundary>
            <ErrorBoundary name="Recorder"><RecorderP /></ErrorBoundary>
          </WorkspaceContext.Provider>
          {compact && browserOpen && <div className="browser-overlay"><BrowserP /></div>}
          {!openWins.length && !compact && (
            <div className="workspace-empty">
              <p>All windows are closed.</p>
              <p>Open the <b>Playlist</b> (F5), <b>Channel rack</b> (F6), <b>Piano roll</b> (F7) or <b>Mixer</b> (F9).</p>
            </div>
          )}
        </div>
      </div>
      {compact && (
        <nav className="tabbar">
          <button className={browserOpen ? 'on' : ''} onClick={() => useStore.getState().setPref('browserOpen', !browserOpen)}>
            <Icon name="folder" size={16} /><span>Browse</span>
          </button>
          {WINDOW_TABS.map(([name, label, icon]) => (
            <button key={name} className={topWindow === name && !browserOpen ? 'on' : ''} onClick={() => { useStore.getState().setPref('browserOpen', false); useStore.getState().openWindow(name); }}>
              <Icon name={icon} size={16} /><span>{label}</span>
            </button>
          ))}
        </nav>
      )}
      {!audioReady && (
        <button className={`audio-banner ${pendingPlay ? 'urgent' : ''}`} onClick={() => useStore.getState().unlockAudio()}>
          <Icon name="speaker" size={14} /> {pendingPlay ? 'Claude wants to play your beat — click to enable audio' : 'Click anywhere to enable audio'}
        </button>
      )}
      {busy && <div className="busy"><div className="spinner" />{busy}</div>}
      <ContextMenu />
      <Modal />
      <Toasts />
    </div>
  );
}
