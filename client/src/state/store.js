import { create } from 'zustand';
import { applyOps, prepareOps, uid, STEP, patternLength } from '@greanteadawy/core';
import { api, setUnauthorizedHandler } from './api.js';
import { sync } from './sync.js';
import { ensureEngine, getEngine, onEngineReady } from '../audio/index.js';
import { noteSampleRevs } from '../audio/engine.js';
import { setPluginRegistry, preparePlugins, pluginsUsed } from '../audio/plugins.js';
import { APP_NAME } from '../lib/version.js';

let playSeq = 0; // the latest play()/stop(): a play waiting for plugins only starts if nothing came after it

const HISTORY_LIMIT = 150;
const COALESCE_MS = 900;
const REMOTE_BURST_MS = 1500;
export const COMPACT_WIDTH = 760; // below this the studio uses full-screen tabs (see App.jsx)
const LS_KEY = 'greanteadawy.ui.v1';

function loadUiPrefs() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveUiPrefs(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      windows: state.windows, snap: state.snap, followClaude: state.followClaude, metronome: state.metronome,
      browserOpen: state.browserOpen, kbOctave: state.kbOctave, recordQuantize: state.recordQuantize
    }));
  } catch { /* storage unavailable */ }
}

export function defaultWindows(w = window.innerWidth, h = window.innerHeight) {
  const W = Math.max(600, w - 260);
  const H = Math.max(400, h - 60);
  return {
    playlist: { open: true, x: 8, y: 8, w: Math.min(W - 16, 1100), h: Math.min(H - 16, 520), z: 1, max: false },
    channelRack: { open: true, x: 40, y: 60, w: Math.min(760, W - 60), h: 340, z: 3, max: false },
    pianoRoll: { open: false, x: 70, y: 40, w: Math.min(W - 90, 1000), h: Math.min(H - 60, 520), z: 2, max: false },
    mixer: { open: false, x: 30, y: Math.max(20, H - 420), w: Math.min(W - 40, 1100), h: 400, z: 2, max: false },
    channelSettings: { open: false, x: Math.max(20, W - 480), y: 30, w: 460, h: 520, z: 4, max: false },
    automation: { open: false, x: 120, y: 120, w: 640, h: 300, z: 4, max: false },
    help: { open: false, x: 60, y: 30, w: Math.min(W - 80, 680), h: Math.min(H - 50, 560), z: 5, max: false },
    settings: { open: false, x: Math.max(10, (W - 720) / 2), y: 24, w: Math.min(W - 20, 720), h: Math.min(H - 40, 600), z: 6, max: false },
    versions: { open: false, x: Math.max(10, W - 560), y: 40, w: Math.min(W - 20, 520), h: 380, z: 6, max: false },
    spatial: { open: false, x: Math.max(10, W - 700), y: 50, w: Math.min(W - 20, 660), h: Math.min(H - 60, 470), z: 5, max: false },
    generate: { open: false, x: Math.max(10, W - 520), y: 80, w: Math.min(W - 20, 460), h: Math.min(H - 80, 420), z: 5, max: false },
    waveEditor: { open: false, x: 40, y: 40, w: Math.min(W - 60, 980), h: Math.min(H - 60, 540), z: 6, max: false },
    recorder: { open: false, x: Math.max(10, W - 480), y: 60, w: Math.min(W - 20, 440), h: Math.min(H - 70, 470), z: 6, max: false }
  };
}

/** Saved layout on top of the defaults, pulled back on screen (it may come from a bigger display). */
function mergeWindows(defs, saved) {
  const out = { ...defs };
  const vw = Math.max(320, (globalThis.innerWidth || 1280) - 40);
  const vh = Math.max(240, (globalThis.innerHeight || 800) - 80);
  for (const [k, v] of Object.entries(saved || {})) {
    if (!defs[k] || !v || !Number.isFinite(v.x)) continue;
    const w = Math.min(Math.max(200, v.w || defs[k].w), vw);
    const h = Math.min(Math.max(120, v.h || defs[k].h), vh);
    out[k] = { ...defs[k], ...v, w, h, x: Math.max(0, Math.min(v.x, vw - Math.min(w, 160))), y: Math.max(0, Math.min(v.y, vh - 40)) };
  }
  return out;
}

const prefs = loadUiPrefs();
const initialWindows = mergeWindows(defaultWindows(), prefs.windows);
// the editor and the recorder hold audio of this session only: they always start closed
for (const k of ['waveEditor', 'recorder']) initialWindows[k] = { ...initialWindows[k], open: false };

export const useStore = create((set, get) => ({
  // ---- auth
  auth: { phase: 'loading', user: null, allowRegistration: false, mcpWithoutToken: false, error: null },

  // ---- server data
  connected: false,
  projects: [],
  samples: [],
  sampleFolders: [], // [{ id, name, count }] A–Z; samples without a folder are "Unfiled"
  editSampleId: null, // the sample open in the wave editor
  editTab: 'wave', // wave editor view: 'wave' | 'pitch'
  editorDirty: false, // the wave editor has unsaved changes
  editorSaving: false, // … and is uploading them (another sample can't be opened meanwhile)
  recorderBusy: false, // the recorder holds audio that isn't saved (a take running or saving, or a failed one)
  project: null,
  loading: true,

  // ---- selection
  selectedChannelId: null,
  selectedPatternId: null,
  selectedInsert: 1,
  exportsRev: 0, // bumped when a render/MIDI export is saved (Exports list reloads)
  exportFormats: null, // { ffmpeg: { available, version, reason }, formats: [...] } from the server
  plugins: { allowed: false, plugins: [] }, // the user's installed plugins (Settings → Plugins)
  pluginErrors: {}, // plugin id → last error message (shown in Settings and channel settings)
  selectedObject: null, // mixer insert selected in the Spatial window
  sampleBuffersRev: 0, // bumped when the audio engine finishes decoding a sample (waveforms redraw)
  versionsRev: 0, // bumped when versions change on the server (Claude saved one, …)
  selectedAutomationId: null,
  pianoRollChannelId: null,

  // ---- transport
  mode: 'pattern',
  playing: false,
  starting: false, // play() is waiting for plugin modules (a stop or toggle cancels it)
  recording: false,
  metronome: !!prefs.metronome,
  songStart: 0,
  loopRegion: null,
  audioReady: false,
  pendingPlay: null,

  // ---- ui
  windows: initialWindows,
  zTop: Math.max(10, ...Object.values(initialWindows).map((w) => w.z || 0)),
  browserOpen: prefs.browserOpen ?? true,
  snap: prefs.snap || 'step',
  followClaude: prefs.followClaude ?? true,
  kbOctave: prefs.kbOctave ?? 4,
  recordQuantize: prefs.recordQuantize ?? true,
  toasts: [],
  activity: [],
  contextMenu: null,
  modal: null,
  busy: null,
  claudeActive: 0,
  midiStatus: null,
  settingsTab: 'account',

  // ---- history
  past: [],
  future: [],
  lastCoalesce: null,
  lastRemote: null,

  // ================================================================ auth

  async initAuth() {
    try {
      const st = await api.authStatus();
      if (st.user) get().startSession(st.user, st);
      else set({ auth: { phase: st.setupRequired ? 'setup' : 'login', user: null, allowRegistration: st.allowRegistration, mcpWithoutToken: st.mcpWithoutToken, setupCodeRequired: !!st.setupCodeRequired, error: null } });
    } catch (e) {
      set({ auth: { ...get().auth, phase: 'offline', error: e.message } });
      setTimeout(() => get().initAuth(), 3000);
    }
  },

  startSession(user, status = {}) {
    set({ auth: { phase: 'ready', user, singleUser: !!status.singleUser, ephemeralStorage: !!status.ephemeralStorage, allowRegistration: !!status.allowRegistration, mcpWithoutToken: !!status.mcpWithoutToken, error: null } });
    sync.start(useStore);
    get().loadExportFormats();
    get().loadPlugins();
  },

  /** The user's plugins; the audio engine gets the enabled ones. */
  async loadPlugins() {
    try {
      const plugins = await api.listPlugins();
      // errors belong to one installed version: forget them when the plugin is updated, switched off or removed
      const live = new Map(plugins.plugins.filter((p) => p.enabled).map((p) => [p.id, p.sha256]));
      const prev = get().plugins.plugins;
      const stale = Object.keys(get().pluginErrors).filter((id) => !live.has(id) || prev.find((p) => p.id === id)?.sha256 !== live.get(id));
      if (stale.length) set((s) => ({ pluginErrors: Object.fromEntries(Object.entries(s.pluginErrors).filter(([id]) => !stale.includes(id))) }));
      setPluginRegistry(plugins.allowed ? plugins.plugins : [], {
        onPluginError: (id, message) => {
          const prev = get().pluginErrors[id];
          set((s) => ({ pluginErrors: { ...s.pluginErrors, [id]: message } }));
          if (prev !== message) get().toast(`Plugin ${id}: ${message}`, 'error');
        }
      });
      set({ plugins });
      // re-sync the engine so channels/effects that were waiting for a plugin pick it up
      const eng = getEngine();
      eng?.refreshPlugins();
    } catch { /* not signed in yet */ }
  },

  /** Which export formats the server can make (ffmpeg); refresh = re-detect ffmpeg (admins). */
  async loadExportFormats(refresh = false) {
    try {
      set({ exportFormats: refresh ? await api.refreshFfmpeg() : await api.exportFormats() });
    } catch (e) {
      if (refresh) get().toast(e.message, 'error');
    }
  },

  async signIn({ username, password }) {
    const r = await api.login({ username, password });
    const st = await api.authStatus();
    get().startSession(r.user, st);
  },

  async signUp({ username, password, displayName }) {
    const r = await api.register({ username, password, displayName });
    const st = await api.authStatus();
    get().startSession(r.user, st);
  },

  async setupAdmin({ username, password, displayName, setupCode }) {
    const r = await api.setup({ username, password, displayName, ...(setupCode ? { setupCode: setupCode.trim() } : {}) });
    get().startSession(r.user, r);
  },

  /** Clear everything that belongs to the signed-in user. */
  resetSessionState() {
    getEngine()?.transport.stop();
    // the editor and the recorder held the signed-out session's audio: they start closed, like on a fresh load
    const windows = { ...get().windows };
    for (const k of ['waveEditor', 'recorder']) if (windows[k]) windows[k] = { ...windows[k], open: false };
    set({
      project: null, projects: [], samples: [], sampleFolders: [], editSampleId: null, past: [], future: [], activity: [], playing: false, recording: false,
      selectedChannelId: null, selectedPatternId: null, pianoRollChannelId: null, selectedAutomationId: null, loading: true, connected: false,
      windows, editorDirty: false, editorSaving: false, recorderBusy: false
    });
  },

  async signOut() {
    // audio that only this page holds: unsaved or saving editor work, a take being recorded or one that couldn't be saved
    const s0 = get();
    const name = s0.samples.find((x) => x.id === s0.editSampleId)?.name || 'the open sample';
    const lose = [
      s0.editorSaving ? `The wave editor is still saving "${name}": signing out now can lose it.` : '',
      s0.editorDirty && s0.windows.waveEditor?.open && !s0.editorSaving ? `Your changes to "${name}" in the wave editor have not been saved.` : '',
      s0.recorderBusy ? 'The recorder has a take that is being recorded, saved, or could not be saved yet.' : ''
    ].filter(Boolean);
    if (lose.length && !(await s0.confirm({ title: 'Sign out?', message: lose.join('\n\n'), danger: true, okLabel: 'Sign out' }))) return;
    // stop live sync first: the server closes our socket on logout, which must not look like a lost session
    sync.stop();
    try { await api.logout(); } catch { /* already gone */ }
    get().resetSessionState();
    const st = await api.authStatus().catch(() => ({}));
    set({ auth: { phase: 'login', user: null, allowRegistration: !!st.allowRegistration, mcpWithoutToken: !!st.mcpWithoutToken, error: null } });
  },

  /** Session expired / revoked (401 or socket closed by the server). */
  authLost() {
    if (get().auth.phase !== 'ready') return;
    sync.stop();
    get().resetSessionState();
    set({ auth: { ...get().auth, phase: 'login', user: null, error: 'You were signed out. Please sign in again.' } });
  },

  setUser(user) {
    set({ auth: { ...get().auth, user } });
  },

  // ================================================================ actions

  toast(text, kind = 'info', ms = 3500) {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, kind }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },

  /** Apply ops locally (optimistic), record undo history and send to the server. */
  dispatch(rawOps, { history = true, coalesce = null } = {}) {
    const s = get();
    if (!s.project || !rawOps?.length) return false;
    const ops = prepareOps(rawOps); // fix generated ids so the server and other tabs build the same thing
    let next;
    try {
      next = applyOps(s.project, ops);
    } catch (e) {
      s.toast(e.message, 'error');
      return false;
    }
    const now = Date.now();
    let past = s.past;
    let lastCoalesce = null;
    if (history) {
      const same = coalesce && s.lastCoalesce && s.lastCoalesce.key === coalesce && now - s.lastCoalesce.time < COALESCE_MS;
      if (!same) past = [...past.slice(-HISTORY_LIMIT + 1), s.project];
      lastCoalesce = coalesce ? { key: coalesce, time: now } : null;
    }
    set({ project: next, past, future: history ? [] : s.future, lastCoalesce, lastRemote: null });
    sync.sendOps(next.id, ops, history ? coalesce : null);
    return true;
  },

  undo() {
    const s = get();
    if (!s.past.length) return;
    const prev = s.past[s.past.length - 1];
    set({ past: s.past.slice(0, -1), future: [s.project, ...s.future].slice(0, HISTORY_LIMIT), project: prev, lastCoalesce: null, lastRemote: null });
    sync.sendOps(prev.id, [{ type: 'project/replace', project: prev }]);
    get().fixSelection();
  },

  redo() {
    const s = get();
    if (!s.future.length) return;
    const next = s.future[0];
    set({ future: s.future.slice(1), past: [...s.past, s.project], project: next, lastCoalesce: null, lastRemote: null });
    sync.sendOps(next.id, [{ type: 'project/replace', project: next }]);
    get().fixSelection();
  },

  /**
   * Ops from the server (Claude via MCP or another tab). Recorded in history so they can be undone. Each Claude tool
   * call is its own undo step; consecutive ops of one gesture in another tab (same coalesce key) become one step.
   */
  applyRemote(ops, source, coalesce = null) {
    const s = get();
    if (!s.project) return;
    try {
      const next = applyOps(s.project, ops);
      const now = Date.now();
      const burst = !!coalesce && s.lastRemote?.coalesce === coalesce && now - s.lastRemote.time < REMOTE_BURST_MS && s.past.length;
      // lastCoalesce reset: a following local edit must not merge into the undo step before Claude's change
      set({
        project: next,
        past: burst ? s.past : [...s.past.slice(-HISTORY_LIMIT + 1), s.project],
        future: [],
        lastCoalesce: null,
        lastRemote: { source, coalesce, time: now }
      });
      get().fixSelection();
      if (source === 'mcp') {
        set((st) => ({ claudeActive: st.claudeActive + 1 }));
        setTimeout(() => set((st) => ({ claudeActive: Math.max(0, st.claudeActive - 1) })), 1500);
      }
    } catch (e) {
      console.warn('remote ops failed, resyncing', e);
      sync.resync();
    }
  },

  setProjectFromServer(project, { resetHistory = false } = {}) {
    const s = get();
    const switching = !s.project || s.project.id !== project.id;
    set({
      project,
      loading: false,
      ...(switching || resetHistory ? { past: [], future: [] } : {}),
      ...(switching ? { songStart: 0, loopRegion: null } : {})
    });
    get().fixSelection(switching);
  },

  fixSelection(reset = false) {
    const { project, selectedChannelId, selectedPatternId, pianoRollChannelId, selectedInsert } = get();
    if (!project) return;
    const patch = {};
    if (reset || !project.channels.some((c) => c.id === selectedChannelId)) patch.selectedChannelId = project.channels[0]?.id || null;
    if (reset || !project.patterns.some((p) => p.id === selectedPatternId)) patch.selectedPatternId = project.patterns[0]?.id || null;
    if (reset || !project.channels.some((c) => c.id === pianoRollChannelId)) patch.pianoRollChannelId = patch.selectedChannelId ?? selectedChannelId ?? null;
    if (selectedInsert >= project.mixer.length) patch.selectedInsert = 0;
    if (Object.keys(patch).length) set(patch);
    const eng = getEngine();
    if (eng && patch.selectedPatternId && eng.transport.mode === 'pattern') eng.transport.patternId = patch.selectedPatternId;
  },

  async refreshProjects() {
    try { set({ projects: await api.listProjects() }); } catch { /* offline */ }
  },

  async refreshSamples() {
    try {
      const [samples, sampleFolders] = await Promise.all([api.listSamples(), api.listSampleFolders()]);
      set({ samples, sampleFolders });
    } catch { /* offline */ }
  },

  openProject(id) {
    const s = get();
    if (s.playing) s.stop();
    sync.subscribe(id);
  },

  async createProject(opts) {
    try {
      const p = await api.createProject(opts);
      await get().refreshProjects();
      get().openProject(p.id);
      return p;
    } catch (e) {
      get().toast(e.message, 'error');
      return null;
    }
  },

  // ---------------------------------------------------------------- selection
  selectChannel(id) {
    set({ selectedChannelId: id });
    getEngine()?.prewarmChannel(id); // a modelled piano/guitar/bass is ready to play from the keyboard
  },
  selectPattern(id) {
    set({ selectedPatternId: id });
    const eng = getEngine();
    if (eng?.transport.playing && eng.transport.mode === 'pattern') eng.transport.patternId = id;
  },

  // ---------------------------------------------------------------- windows
  openWindow(name, patch = {}) {
    set((s) => {
      const z = s.zTop + 1;
      const windows = { ...s.windows, [name]: { ...s.windows[name], ...patch, open: true, z } };
      // on narrow screens the browser is a full-screen overlay: close it so the window is actually visible
      const compact = (globalThis.innerWidth || 1280) < COMPACT_WIDTH;
      return { windows, zTop: z, ...(compact && s.browserOpen ? { browserOpen: false } : {}) };
    });
    saveUiPrefs(get());
  },
  closeWindow(name) {
    set((s) => ({ windows: { ...s.windows, [name]: { ...s.windows[name], open: false } } }));
    saveUiPrefs(get());
  },
  toggleWindow(name) {
    const w = get().windows[name];
    const topmost = Object.values(get().windows).every((x) => !x.open || x.z <= w.z);
    if (w.open && topmost) get().closeWindow(name);
    else get().openWindow(name);
  },
  focusWindow(name) {
    const s = get();
    if (s.windows[name].z === s.zTop) return;
    const z = s.zTop + 1;
    set({ windows: { ...s.windows, [name]: { ...s.windows[name], z } }, zTop: z });
  },
  moveWindow(name, patch) {
    set((s) => ({ windows: { ...s.windows, [name]: { ...s.windows[name], ...patch } } }));
  },
  persistUi() {
    saveUiPrefs(get());
  },
  resetLayout() {
    // the wave editor and the recorder hold this session's audio (unsaved edits, a take): they stay open
    const prev = get().windows;
    const windows = defaultWindows();
    for (const k of ['waveEditor', 'recorder']) if (prev[k]?.open) windows[k] = { ...windows[k], open: true };
    set({ windows });
    saveUiPrefs(get());
  },
  setPref(key, value) {
    set({ [key]: value });
    saveUiPrefs(get());
  },

  openPianoRoll(channelId) {
    set({ pianoRollChannelId: channelId, selectedChannelId: channelId });
    get().openWindow('pianoRoll');
  },
  openChannelSettings(channelId) {
    set({ selectedChannelId: channelId });
    get().openWindow('channelSettings');
  },

  showContextMenu(e, items) {
    e.preventDefault();
    e.stopPropagation();
    set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
  },
  hideContextMenu() {
    if (get().contextMenu) set({ contextMenu: null });
  },

  /**
   * Show a dialog (prompt / confirm / about); resolves with its answer. One dialog at a time: a dialog that replaces an
   * open one answers that one with its cancel value first, so nothing awaiting it is left hanging.
   */
  openModal(spec) {
    const open = get().modal;
    open?.resolve(open.kind === 'prompt' ? null : false);
    return new Promise((resolve) => {
      const id = uid('m');
      set({ modal: { ...spec, id, resolve: (v) => { if (get().modal?.id === id) set({ modal: null }); resolve(v); } } });
    });
  },
  /** Promise-based prompt dialog. */
  prompt({ title, value = '', label = '', placeholder = '' }) {
    return get().openModal({ kind: 'prompt', title, value, label, placeholder });
  },
  confirm({ title, message, danger = false, okLabel = 'OK' }) {
    return get().openModal({ kind: 'confirm', title, message, danger, okLabel });
  },
  /** The About dialog: app name, version and the server's version. Resolves when it closes. */
  showAbout() {
    return get().openModal({ kind: 'about', title: `About ${APP_NAME}` });
  },

  // ---------------------------------------------------------------- transport
  async unlockAudio() {
    const eng = await ensureEngine();
    const running = eng.ctx.state === 'running';
    if (running !== get().audioReady) set({ audioReady: running });
    if (running && get().pendingPlay) {
      const pp = get().pendingPlay;
      set({ pendingPlay: null });
      get().play(pp);
    }
    return eng;
  },

  async play(opts = {}) {
    const s = get();
    const eng = await ensureEngine();
    if (eng.ctx.state !== 'running') {
      set({ pendingPlay: opts, audioReady: false });
      s.toast('Click anywhere to enable audio', 'warn');
      return;
    }
    if (opts.mode && opts.mode !== s.mode) set({ mode: opts.mode });
    if (opts.patternId) set({ selectedPatternId: opts.patternId });
    eng.setProject(get().project);
    // plugin modules/samples load once per audio context: wait for them (briefly) so the first notes aren't dropped.
    // A stop (or another play) during the wait cancels this one.
    const seq = ++playSeq;
    if (pluginsUsed(get().project).length) {
      set({ starting: true });
      await Promise.race([preparePlugins(eng.ctx, get().project), new Promise((r) => setTimeout(r, 3000))]);
      if (seq !== playSeq) return;
      set({ starting: false });
      eng.setProject(get().project);
    }
    // read the state now (the user may have switched mode/pattern during the wait)
    const now = get();
    const mode = opts.mode || now.mode;
    const patternId = opts.patternId || now.selectedPatternId;
    eng.metronome = opts.metronome ?? now.metronome;
    eng.transport.loopRegion = opts.loopRegion !== undefined ? opts.loopRegion : now.loopRegion;
    eng.transport.play({ mode, patternId, position: opts.position ?? (mode === 'song' ? now.songStart : 0), at: opts.at });
    set({ playing: true, audioReady: true });
  },

  stop() {
    playSeq++; // cancels a play that is still waiting for plugins
    const eng = getEngine();
    eng?.transport.stop();
    eng?.stopPreview();
    set({ playing: false, starting: false });
    get().finishRecordingNotes();
  },

  togglePlay() {
    if (get().playing || get().starting) get().stop();
    else get().play();
  },

  setMode(mode) {
    const s = get();
    if (s.mode === mode) return;
    set({ mode });
    if (s.playing) get().play({ mode });
  },

  setSongStart(tick) {
    set({ songStart: Math.max(0, tick) });
    const s = get();
    if (s.playing && s.mode === 'song') get().play({ position: tick });
  },

  setLoopRegion(region) {
    set({ loopRegion: region });
    const eng = getEngine();
    if (eng) eng.transport.loopRegion = region;
  },

  toggleMetronome() {
    const v = !get().metronome;
    set({ metronome: v });
    const eng = getEngine();
    if (eng) eng.metronome = v;
    saveUiPrefs(get());
  },

  /** Play one note (Claude's preview_sound). */
  audition(channelId, key, velocity = 0.8, duration = 0.5) {
    const eng = getEngine();
    if (!eng || eng.ctx.state !== 'running' || !get().project) return;
    eng.setProject(get().project);
    eng.preview(channelId, key, velocity, Math.min(8, duration || 0.5));
  },

  // ---------------------------------------------------------------- live notes & recording
  heldNotes: new Map(),

  liveNoteOn(key, velocity = 0.8, channelId = null) {
    const s = get();
    const cid = channelId || s.selectedChannelId;
    if (!cid || !s.project) return;
    const id = `${cid}:${key}`;
    if (s.heldNotes.has(id)) return;
    // register synchronously so a quick key-up before audio is unlocked can't leave a stuck note
    const h = { voice: null, recTick: null, key, velocity, channelId: cid, t0: 0, released: false };
    s.heldNotes.set(id, h);
    const start = () => {
      const eng = getEngine();
      if (!eng || h.released || get().heldNotes.get(id) !== h) return;
      h.voice = eng.noteOn(cid, key, velocity);
      h.t0 = eng.ctx.currentTime;
      if (get().recording && get().playing) h.recTick = get().currentPatternTick();
    };
    if (getEngine()?.ctx.state === 'running') start();
    else get().unlockAudio().then(start);
  },

  liveNoteOff(key, channelId = null) {
    const s = get();
    const cid = channelId || s.selectedChannelId;
    const id = `${cid}:${key}`;
    const h = s.heldNotes.get(id);
    if (!h) return;
    h.released = true;
    s.heldNotes.delete(id);
    const eng = getEngine();
    if (h.voice) eng?.noteOff(h.voice);
    if (h.recTick !== null && eng) get().recordNote(h, eng.ctx.currentTime);
  },

  finishRecordingNotes() {
    const s = get();
    const eng = getEngine();
    for (const [id, h] of s.heldNotes) {
      h.released = true;
      if (h.recTick !== null && eng) get().recordNote(h, eng.ctx.currentTime);
      if (h.voice) eng?.noteOff(h.voice);
      s.heldNotes.delete(id);
    }
  },

  /** Position inside the selected pattern (ticks) while playing. */
  currentPatternTick() {
    const s = get();
    const eng = getEngine();
    const pos = eng?.transport.positionAt();
    if (pos == null) return 0;
    const pat = s.project.patterns.find((p) => p.id === s.selectedPatternId);
    const len = patternLength(s.project, pat);
    return ((pos % len) + len) % len;
  },

  recordNote(h, endTime) {
    const s = get();
    const eng = getEngine();
    const rate = (eng.bpm / 60) * 96;
    let start = h.recTick;
    let length = Math.max(6, Math.round((endTime - h.t0) * rate));
    if (s.recordQuantize) {
      start = Math.round(start / STEP) * STEP;
      length = Math.max(STEP, Math.round(length / STEP) * STEP);
    }
    const pat = s.project.patterns.find((p) => p.id === s.selectedPatternId);
    if (!pat) return;
    const len = patternLength(s.project, pat);
    if (start >= len) start -= len;
    s.dispatch([{ type: 'notes/add', patternId: pat.id, channelId: h.channelId, notes: [{ id: uid('n'), key: h.key, start, length, velocity: h.velocity }] }], { coalesce: 'record' });
  }
}));

// Keep the audio engine in sync with the project
onEngineReady((eng) => {
  eng.syncSampleLibrary(useStore.getState().samples); // before the project loads its samples: revisions are in the URLs
  const p = useStore.getState().project;
  if (p) eng.setProject(p);
  eng.metronome = useStore.getState().metronome;
  eng.onSampleLoaded = () => useStore.setState((s) => ({ sampleBuffersRev: s.sampleBuffersRev + 1 }));
  eng.ctx.addEventListener?.('statechange', () => useStore.setState({ audioReady: eng.ctx.state === 'running' }));
});
setUnauthorizedHandler(() => useStore.getState().authLost());

useStore.subscribe((state, prev) => {
  if (state.project && state.project !== prev.project) {
    try {
      getEngine()?.setProject(state.project);
    } catch (e) {
      console.error('audio engine sync failed', e);
    }
  }
  if (state.samples !== prev.samples) {
    noteSampleRevs(state.samples); // even before the audio engine exists (browser jobs fetch sample files too)
    getEngine()?.syncSampleLibrary(state.samples);
  }
});

export const getState = () => useStore.getState();
