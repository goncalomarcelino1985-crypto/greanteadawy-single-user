import { useRef, createContext, useContext } from 'react';
import { useStore } from '../../state/store.js';
import { Icon } from './Icon.jsx';

export const WorkspaceContext = createContext({ compact: false, width: 1000, height: 700, topWindow: null });

// controls inside a title bar keep their own pointer handling; everything else in the bar (its empty space, labels)
// moves the window
const INTERACTIVE = 'button, input, select, textarea, a, label, [role="slider"], [role="switch"], [role="tab"], [role="button"], [contenteditable], [data-nodrag]';
const onControl = (e) => !!e.target.closest?.(INTERACTIVE);

/** Floating, draggable, resizable window. In compact (narrow) layouts it fills the workspace. */
/** onClose: called instead of closing right away (e.g. to ask about unsaved changes); it closes the window itself. */
export function Window({ name, title, icon, toolbar, children, minW = 320, minH = 160, className = '', onClose }) {
  const w = useStore((s) => s.windows[name]);
  const zTop = useStore((s) => s.zTop);
  const { compact, width, height, topWindow } = useContext(WorkspaceContext);
  const drag = useRef(null);
  if (!w?.open) return null;
  const { focusWindow, moveWindow, closeWindow, persistUi } = useStore.getState();
  const maximized = compact || w.max;
  // compact layout shows one window at a time; the others stay mounted (hidden) so they keep scroll position & state
  const hidden = compact && name !== topWindow;

  const startDrag = (e, kind) => {
    if (e.button !== 0 || maximized) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, w: { ...w } };
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    d.cx = e.clientX;
    d.cy = e.clientY;
    if (d.raf) return; // at most one layout update per frame
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      if (drag.current !== d) return;
      const dx = d.cx - d.x;
      const dy = d.cy - d.y;
      if (d.kind === 'move') {
        moveWindow(name, {
          x: Math.max(-d.w.w + 80, Math.min(width - 60, d.w.x + dx)),
          y: Math.max(0, Math.min(height - 30, d.w.y + dy))
        });
      } else {
        moveWindow(name, { w: Math.max(minW, d.w.w + dx), h: Math.max(minH, d.w.h + dy) });
      }
    });
  };
  const endDrag = (e) => {
    const d = drag.current;
    if (d) {
      if (d.raf) cancelAnimationFrame(d.raf);
      d.raf = 0;
      if (e) { d.cx = e.clientX; d.cy = e.clientY; }
      drag.current = null;
      // apply the final position, then save the layout
      const dx = (d.cx ?? d.x) - d.x;
      const dy = (d.cy ?? d.y) - d.y;
      if (d.kind === 'move') moveWindow(name, { x: Math.max(-d.w.w + 80, Math.min(width - 60, d.w.x + dx)), y: Math.max(0, Math.min(height - 30, d.w.y + dy)) });
      else moveWindow(name, { w: Math.max(minW, d.w.w + dx), h: Math.max(minH, d.w.h + dy) });
      persistUi();
    }
  };

  const style = maximized
    ? { left: 0, top: 0, width: '100%', height: '100%', zIndex: w.z }
    : { left: w.x, top: w.y, width: w.w, height: w.h, zIndex: w.z };
  if (hidden) style.display = 'none';

  return (
    <section className={`window ${className} ${w.z === zTop ? 'focused' : ''}`} style={style} data-window={name}
      onPointerDownCapture={(e) => {
        focusWindow(name);
        // a click into another window takes the keyboard along: a focused control left behind in the previous window
        // (e.g. the wave editor) would otherwise keep getting Space and Ctrl+Z
        const active = document.activeElement;
        const inside = active && e.currentTarget.contains(active);
        if (active && active !== document.body && !inside && active.closest?.('.window')) active.blur();
        // a window with its own keys (the wave editor, the recorder) gets them back from a click on its title bar
        // (dragging there never moves the focus by itself)
        if (e.target.closest?.('.window-title') && !onControl(e)) {
          const home = e.currentTarget.querySelector('[data-keyboard-home]');
          if (home) {
            if (!inside) home.focus({ preventScroll: true });
            // keep it there: a maximized window's title bar doesn't start a drag, and the click would move the focus to
            // the page — also when the window already had it
            e.preventDefault();
          }
        }
      }} aria-label={title}>
      <header className="window-title" onPointerDown={(e) => startDrag(e, 'move')} onPointerMove={onMove} onPointerUp={endDrag}
        onDoubleClick={() => !compact && moveWindow(name, { max: !w.max })}>
        {icon && <Icon name={icon} size={14} />}
        <span className="window-name">{title}</span>
        <div className="window-toolbar" onPointerDown={(e) => { if (onControl(e)) e.stopPropagation(); }} onDoubleClick={(e) => { if (onControl(e)) e.stopPropagation(); }}>{toolbar}</div>
        {!compact && (
          <button className="wbtn" title={w.max ? 'Restore' : 'Maximize'} onPointerDown={(e) => e.stopPropagation()} onClick={() => moveWindow(name, { max: !w.max })}>
            <Icon name={w.max ? 'restore' : 'max'} size={12} />
          </button>
        )}
        <button className="wbtn close" title="Close" onPointerDown={(e) => e.stopPropagation()} onClick={() => (onClose ? onClose() : closeWindow(name))}>
          <Icon name="close" size={12} />
        </button>
      </header>
      <div className="window-body">{children}</div>
      {!maximized && <div className="window-resize" onPointerDown={(e) => startDrag(e, 'resize')} onPointerMove={onMove} onPointerUp={endDrag} />}
    </section>
  );
}
