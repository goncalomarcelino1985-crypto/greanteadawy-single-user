import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { useStore } from '../../state/store.js';
import { Icon } from './Icon.jsx';
import { AboutBody } from '../About.jsx';

/** Activate a menu item: async actions report failures as a toast instead of an uncaught rejection. */
function runItem(it, hide) {
  hide();
  Promise.resolve().then(() => it.onClick?.()).catch((e) => useStore.getState().toast(e?.message || String(e), 'error'));
}

const focusables = (el) => [...(el?.querySelectorAll(':scope > .cm-row > .cm-item:not(:disabled)') || [])];

export function ContextMenu() {
  const menu = useStore((s) => s.contextMenu);
  const hide = useStore((s) => s.hideContextMenu);
  const ref = useRef(null);
  const returnFocus = useRef(null); // element focused before the menu opened
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [path, setPath] = useState([]); // open submenu index per depth

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4))
    });
    setPath([]);
    const prev = document.activeElement;
    if (prev && prev !== document.body && !ref.current.contains(prev)) returnFocus.current = prev;
    focusables(ref.current)[0]?.focus({ preventScroll: true });
  }, [menu]);

  // give keyboard focus back to where it was (the menu's items disappear with it)
  useEffect(() => {
    if (menu) return;
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected && (!document.activeElement || document.activeElement === document.body)) el.focus({ preventScroll: true });
  }, [menu]);

  // Submenus are position:fixed next to their row (so a scrolling parent can't clip them): open to the right, flip
  // left when there's no room, and shift up to stay on screen; tall ones scroll (max-height in CSS).
  useLayoutEffect(() => {
    for (const sub of ref.current?.querySelectorAll('.cm-sub') || []) {
      const row = sub.parentElement.getBoundingClientRect();
      const { width, height } = sub.getBoundingClientRect();
      const right = row.right - 2;
      const x = right + width <= window.innerWidth - 4 ? right : Math.max(4, row.left - width + 2);
      const y = Math.max(4, Math.min(row.top - 5, window.innerHeight - height - 4));
      sub.style.left = `${Math.round(x)}px`;
      sub.style.top = `${Math.round(y)}px`;
    }
  }, [path, pos]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) hide(); };
    const key = (e) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
    };
  }, [menu, hide]);

  if (!menu) return null;

  const openAt = (depth, index) => setPath((p) => [...p.slice(0, depth), ...(index === null ? [] : [index])]);

  const onKeyDown = (e) => {
    const item = e.target.closest('.cm-item');
    if (!item) return;
    const list = item.closest('.context-menu, .cm-sub');
    const items = focusables(list);
    const i = items.indexOf(item);
    const depth = Number(item.dataset.depth);
    const index = Number(item.dataset.index);
    if (e.key === 'Enter' || e.key === ' ') {
      // let the button activate, but keep the key away from global shortcuts (Space = play/stop)
      e.stopPropagation();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'ArrowRight' && item.getAttribute('aria-haspopup')) {
      openAt(depth, index);
      requestAnimationFrame(() => focusables(item.parentElement.querySelector(':scope > .cm-sub'))[0]?.focus());
    } else if (e.key === 'ArrowLeft' && depth > 0) {
      openAt(depth - 1, null);
      list.parentElement.querySelector(':scope > .cm-item')?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const renderItems = (items, depth) => items.map((it, i) => {
    if (it === '-' || it.separator) return <div key={i} className="cm-sep" role="separator" />;
    if (it.header) return <div key={i} className="cm-header" role="presentation">{it.header}</div>;
    const open = !!it.submenu && path[depth] === i;
    return (
      <div key={i} className="cm-row" role="none" onPointerEnter={() => openAt(depth, it.submenu ? i : null)}>
        <button className={`cm-item ${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''} ${open ? 'open' : ''}`} disabled={it.disabled}
          role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.checked !== undefined ? !!it.checked : undefined}
          aria-haspopup={it.submenu ? 'menu' : undefined} aria-expanded={it.submenu ? open : undefined}
          data-depth={depth} data-index={i}
          onClick={() => (it.submenu ? openAt(depth, i) : runItem(it, hide))}>
          <span className="cm-check">{it.checked ? '✓' : ''}</span>
          <span className="cm-label">{it.label}</span>
          {it.shortcut && <span className="cm-shortcut">{it.shortcut}</span>}
          {it.submenu && <Icon name="chevronRight" size={12} />}
        </button>
        {open && <div className="cm-sub" role="menu">{renderItems(it.submenu, depth + 1)}</div>}
      </div>
    );
  });
  return (
    <div ref={ref} className="context-menu" role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown} onScroll={() => setPath([])}>
      {renderItems(menu.items, 0)}
    </div>
  );
}

export function Modal() {
  const modal = useStore((s) => s.modal);
  // remount per dialog so the prompt starts with its value (and autofocus selects it)
  return modal ? <ModalDialog key={modal.id ?? modal.title} modal={modal} /> : null;
}

function ModalDialog({ modal }) {
  const [value, setValue] = useState(modal.kind === 'prompt' ? modal.value ?? '' : '');
  const ref = useRef(null);
  const about = modal.kind === 'about';
  const cancel = () => modal.resolve(modal.kind === 'prompt' ? null : false);

  // give focus back to whatever opened the dialog (e.g. the ⓘ button) when it closes. Captured on the first render,
  // before autoFocus moves focus into the dialog; restored after the dialog's own focus guard is gone.
  const opener = useRef(document.activeElement);
  useEffect(() => () => {
    const el = opener.current;
    setTimeout(() => { if (el?.isConnected && el !== document.body && !useStore.getState().modal) el.focus?.({ preventScroll: true }); }, 0);
  }, []);
  const ok = () => modal.resolve(modal.kind === 'prompt' ? value : true);

  useEffect(() => {
    // Escape works wherever focus is; keep focus inside the dialog while it is open
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    const onFocus = (e) => { if (ref.current && !ref.current.contains(e.target)) ref.current.querySelector('input, button')?.focus(); };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
    };
  });

  const trapTab = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll('input, button:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div ref={ref} className={`modal ${about ? 'about-dialog' : ''}`} role="dialog" aria-modal="true"
        {...(about ? { 'aria-label': modal.title } : { 'aria-labelledby': 'modal-title' })} onKeyDown={(e) => {
        e.stopPropagation();
        trapTab(e);
        // Enter confirms from the text field; on a focused button it activates that button (e.g. Cancel)
        if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); ok(); }
      }}>
        {about ? <AboutBody /> : <h3 id="modal-title">{modal.title}</h3>}
        {modal.message && <p>{modal.message}</p>}
        {modal.kind === 'prompt' && (
          <label className="modal-field">
            {modal.label && <span>{modal.label}</span>}
            <input autoFocus value={value} placeholder={modal.placeholder} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
          </label>
        )}
        {about ? (
          <div className="modal-actions">
            <button className="btn" onClick={() => { modal.resolve('help'); useStore.getState().openWindow('help'); }}>Shortcuts &amp; help</button>
            <button className="btn primary" autoFocus onClick={ok}>Close</button>
          </div>
        ) : (
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>Cancel</button>
            <button className={`btn ${modal.danger ? 'danger' : 'primary'}`} autoFocus={modal.kind !== 'prompt'} onClick={ok}>{modal.okLabel || 'OK'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'claude' && <Icon name="claude" size={14} />}
          {t.text}
        </div>
      ))}
    </div>
  );
}
