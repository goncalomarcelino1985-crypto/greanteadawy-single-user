// The generator sandbox: an iframe page with an opaque origin (CSP `sandbox allow-scripts`) and no network
// (`connect-src 'none'`). The studio posts a generator plugin's code and inputs to it; the page runs the code in a
// dedicated Worker built from a blob (so a runaway loop can be killed) and posts the notes back. Being cross-origin to
// the studio, the code can't touch the studio's page, cookies, storage or API. See docs/security.md.

export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'self' blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "font-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts'
].join('; ');

export const SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>GreanTeaDawy generator sandbox</title></head>
<body><script src="/sandbox/generator.js"></script></body></html>
`;

/** Prepended to the plugin code inside the worker: removes every way out, then runs generate() on request. */
const WORKER_HARNESS = String.raw`'use strict';
for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'WebTransport', 'navigator', 'location']) {
  try { Object.defineProperty(self, k, { value: undefined, configurable: false, writable: false }); } catch (e) { try { self[k] = undefined; } catch (e2) { /* ignore */ } }
}
const __gtdDef = { gen: null };
const __gtd = Object.freeze({
  registerGenerator(d) {
    if (__gtdDef.gen) throw new Error('registerGenerator called twice');
    if (!d || typeof d.generate !== 'function') throw new Error('registerGenerator needs { generate(input) }');
    __gtdDef.gen = d;
  }
});
function __gtdRandom(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
const __gtdPost = self.postMessage.bind(self);
self.onmessage = (e) => {
  try {
    if (!__gtdDef.gen) throw new Error('The plugin did not call gtd.registerGenerator');
    const input = Object.assign({}, e.data, { random: __gtdRandom(e.data.seed) });
    const notes = __gtdDef.gen.generate(input);
    __gtdPost({ ok: true, notes: JSON.parse(JSON.stringify(Array.isArray(notes) ? notes.slice(0, 8192) : notes)) });
  } catch (err) {
    __gtdPost({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
};
`;

/** The sandbox page's script: only acts inside the opaque-origin sandbox and only for its parent (the studio). */
export const SANDBOX_JS = `'use strict';
(() => {
  if (self.origin !== 'null' || window.parent === window) return; // never run outside the sandbox
  const HARNESS = ${JSON.stringify(WORKER_HARNESS)};
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.type !== 'gtd-generate' || typeof m.code !== 'string' || typeof m.id !== 'string') return;
    const reply = (data) => window.parent.postMessage(Object.assign({ type: 'gtd-generated', id: m.id }, data), '*');
    let worker;
    let url;
    const timeout = Math.min(10000, Math.max(100, Number(m.timeoutMs) || 2000));
    const timer = setTimeout(() => { try { worker && worker.terminate(); } catch (err) { /* ignore */ } reply({ ok: false, error: 'The generator took longer than ' + timeout + ' ms and was stopped' }); }, timeout);
    try {
      url = URL.createObjectURL(new Blob([HARNESS + '\\n;(function (gtd, self, globalThis, postMessage, onmessage, importScripts) {\\n\\'use strict\\';\\n' + m.code + '\\n})(__gtd);\\n'], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (ev) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); reply(ev.data && typeof ev.data === 'object' ? { ok: !!ev.data.ok, notes: ev.data.notes, error: ev.data.error } : { ok: false, error: 'bad reply' }); };
      worker.onerror = (ev) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); reply({ ok: false, error: (ev && ev.message) || 'The generator crashed' }); ev.preventDefault && ev.preventDefault(); };
      worker.postMessage(m.input || {});
    } catch (err) {
      clearTimeout(timer);
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
  window.parent.postMessage({ type: 'gtd-sandbox-ready' }, '*');
})();
`;

/** Express handlers for /sandbox/generator.html and /sandbox/generator.js with the sandbox headers. */
export function sandboxRoutes(app) {
  const send = (type, body, corp) => (req, res) => {
    res.set('Content-Security-Policy', SANDBOX_CSP);
    res.set('X-Frame-Options', 'SAMEORIGIN'); // the studio frames it; nobody else may
    // the sandboxed page has an opaque origin, so to the browser its own script is a cross-origin load (the script is
    // static and holds nothing secret; it does nothing outside the sandbox)
    res.set('Cross-Origin-Resource-Policy', corp);
    res.set('Cache-Control', 'no-cache');
    res.type(type).send(body);
  };
  app.get('/sandbox/generator.html', send('html', SANDBOX_HTML, 'same-origin'));
  app.get('/sandbox/generator.js', send('application/javascript', SANDBOX_JS, 'cross-origin'));
}
