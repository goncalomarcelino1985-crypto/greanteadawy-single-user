// Runs generator plugins in the sandbox page (/sandbox/generator.html): an iframe with an opaque origin, no network
// and its own CSP, where each run gets a fresh Worker that is killed after the time limit. Nothing a generator does can
// reach this page, its cookies or the API; its output is only data, checked again before it becomes notes.
let frame = null;
let ready = null;
const pending = new Map();

function ensureFrame() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.title = 'Generator sandbox';
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    frame.src = '/sandbox/generator.html';
    const t = setTimeout(() => { ready = null; reject(new Error('The generator sandbox did not start')); }, 10000);
    window.addEventListener('message', (e) => {
      if (!frame || e.source !== frame.contentWindow) return; // only our sandbox
      const m = e.data;
      if (m?.type === 'gtd-sandbox-ready') { clearTimeout(t); resolve(); return; }
      if (m?.type === 'gtd-generated' && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        p(m);
      }
    });
    document.body.appendChild(frame);
  });
  return ready;
}

/** Run a generator's code on `input` in the sandbox. Resolves { ok, notes, error }. */
export async function runInSandbox(code, input, { timeoutMs = 2000 } = {}) {
  await ensureFrame();
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const guard = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'No answer from the sandbox' }); }, timeoutMs + 3000);
    pending.set(id, (m) => { clearTimeout(guard); resolve({ ok: !!m.ok, notes: m.notes, error: m.error }); });
    // the sandbox has an opaque origin, so '*' is the only target; nothing here is secret (code + pattern notes)
    frame.contentWindow.postMessage({ type: 'gtd-generate', id, code, input: JSON.parse(JSON.stringify(input)), timeoutMs }, '*');
  });
}
