import { useEffect, useState } from 'react';
import { INSTRUMENTS, INSTRUMENT_KINDS, INSTRUMENT_CATEGORIES, EFFECTS, EFFECT_TYPES } from '@greanteadawy/core';
import { api } from '../state/api.js';
import { APP_NAME, APP_VERSION } from '../lib/version.js';

// what ships with the studio (plugin instruments and effects are the user's own, so they don't count)
const BUILT_IN = INSTRUMENT_KINDS.filter((k) => !INSTRUMENTS[k].dynamic);
const BUILT_IN_EFFECTS = EFFECT_TYPES.filter((t) => !EFFECTS[t].dynamic).length;
const PRESETS = BUILT_IN.reduce((n, k) => n + Object.keys(INSTRUMENTS[k].presets).length, 0);
const COLLECTIONS = INSTRUMENT_CATEGORIES.filter(([cat]) => BUILT_IN.some((k) => INSTRUMENTS[k].category === cat)).length;

/**
 * The About dialog's content (shown by the modal of kind "about"): the app's name and version, the server's version
 * (a different one means this tab still runs an older build) and what's built in.
 */
export function AboutBody() {
  const [server, setServer] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    api.status().then(
      (s) => { if (live) setServer({ state: 'ok', version: s.version }); },
      () => { if (live) setServer({ state: 'error' }); }
    );
    return () => { live = false; };
  }, []);
  const outdated = server.state === 'ok' && server.version && APP_VERSION !== 'dev' && server.version !== APP_VERSION;
  return (
    <div className="about">
      <div className="about-head">
        <span className="about-mark" aria-hidden="true">◆</span>
        <div>
          <h3 id="modal-title" className="about-name">{APP_NAME}</h3>
          <div className="about-version" data-testid="about-version">Version {APP_VERSION}</div>
        </div>
      </div>
      <p className="about-tagline">A pattern-based browser DAW — with Claude as your co-producer.</p>
      <dl className="about-facts">
        <dt>App</dt>
        <dd>{APP_NAME} {APP_VERSION}</dd>
        <dt>Server</dt>
        <dd data-testid="about-server">{server.state === 'loading' ? 'checking…' : server.state === 'error' ? 'not reachable' : `${APP_NAME} ${server.version}`}</dd>
        <dt>Sounds</dt>
        <dd>{BUILT_IN.length} instruments in {COLLECTIONS} collections, {PRESETS} presets, {BUILT_IN_EFFECTS} effects</dd>
        <dt>Licence</dt>
        <dd>MIT (open source)</dd>
      </dl>
      {outdated && <p className="about-warn" role="status">The server runs version {server.version}: reload the page to load the matching studio.</p>}
      <p className="about-note">GreanTeaDawy is an independent experimental project. It is not affiliated with or endorsed by Music Software company.</p>
      <p className="about-repo">Source code: <a href="https://github.com/vidux/GreanTeaDawy" target="_blank" rel="noopener noreferrer">github.com/vidux/GreanTeaDawy</a> — if you like it, please give it a star!</p>
    </div>
  );
}
