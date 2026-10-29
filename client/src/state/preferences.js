// The server is authoritative in cloud mode. Browser storage is only an optional cache.
export const RECORDER_DEFAULTS = Object.freeze({ deviceId: '', channels: 1, along: 'song', countIn: 1, metronome: true, place: true, monitor: false, echo: false, noise: false, agc: false, offsetMs: 0 });
export const UI_DEFAULTS = Object.freeze({ snap: 'step', followClaude: true, metronome: false, browserOpen: true, kbOctave: 4, recordQuantize: true });
const KEYS = [...Object.keys(UI_DEFAULTS), 'windows', 'recorderPreferences', 'collapsedSampleFolders'];
const clone = (value) => JSON.parse(JSON.stringify(value));

export function pickPreferences(state) {
  return Object.fromEntries(KEYS.filter((key) => state[key] !== undefined).map((key) => [key, clone(state[key])]));
}

export async function preferencesRequest(method, body, signal) {
  const response = await fetch('/api/preferences', {
    method, credentials: 'same-origin', signal,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error || `Preferences request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || !data.preferences || typeof data.preferences !== 'object' || Array.isArray(data.preferences)) throw new Error('Invalid preferences response');
  return data;
}

/** Serial saves, revision conflicts, cancellation on owner switch, and no writes before a successful GET. */
export function createPreferencesSync({ request = preferencesRequest, apply, status, debounceMs = 650 }) {
  let epoch = 0;
  let owner = null;
  let revision = 0;
  let ready = false;
  let timer;
  let saving = false;
  let pending = null;
  let blockedEdits = false;
  let lastError = null;
  let controller = null;
  const notify = (phase, error = null) => {
    lastError = error;
    status({ phase, error: error?.message || null, conflict: error?.status === 409, unsaved: !!pending || blockedEdits });
  };

  function stop() {
    epoch++;
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    owner = null;
    ready = false;
    saving = false;
    pending = null;
    blockedEdits = false;
    lastError = null;
  }
  async function start(userId) {
    const keepWarning = owner === userId && blockedEdits;
    stop();
    owner = userId;
    blockedEdits = keepWarning;
    const ticket = epoch;
    controller = new AbortController();
    notify('loading');
    try {
      const data = await request('GET', undefined, controller.signal);
      if (ticket !== epoch) return false;
      revision = data.revision;
      apply(data.preferences);
      // The retry loaded authoritative cloud values. Blocked/default snapshots
      // are deliberately never replayed over them.
      blockedEdits = false;
      ready = true;
      notify('saved');
      return true;
    } catch (error) {
      if (ticket === epoch) notify('error', error);
      return false;
    }
  }
  async function flush() {
    clearTimeout(timer);
    if (!ready || !owner || saving || !pending) return;
    const ticket = epoch;
    const preferences = pending;
    saving = true;
    notify('saving');
    try {
      const data = await request('PUT', { revision, preferences }, controller.signal);
      if (ticket !== epoch) return;
      revision = data.revision;
      if (pending === preferences) pending = null;
      saving = false;
      notify(pending ? 'pending' : 'saved');
      if (pending) await flush();
    } catch (error) {
      if (ticket !== epoch) return;
      saving = false;
      notify('error', error);
    }
  }
  function changed(state) {
    // In particular, failed GETs must never replace cloud preferences with defaults or another owner's cache.
    if (!owner) return false;
    if (!ready) {
      blockedEdits = true;
      notify('error', lastError || new Error('As preferências da cloud ainda não foram carregadas. Estas alterações não estão guardadas.'));
      return false;
    }
    pending = pickPreferences(state);
    clearTimeout(timer);
    notify('pending');
    timer = setTimeout(flush, debounceMs);
    return true;
  }
  return { start, stop, changed, flush, retry: () => ready ? flush() : owner ? start(owner) : Promise.resolve(false) };
}
