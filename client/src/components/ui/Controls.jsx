import { useRef, useState, useEffect } from 'react';
import { useRafCallback } from './Knob.jsx';

/** Vertical fader (mixer). value 0..max */
export function Fader({ value, max = 1.25, def = 0.8, onChange, height = 120, title }) {
  const drag = useRef(null);
  const emit = useRafCallback((v) => onChange?.(v));
  const toPos = (v) => Math.pow(v / max, 0.5); // perceptual curve
  const fromPos = (p) => max * p * p;
  const pos = Math.max(0, Math.min(1, toPos(value)));
  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    drag.current = { rect, y: e.clientY, pos };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const { rect, y, pos: p0 } = drag.current;
    const dp = (y - e.clientY) / (rect.height * (e.shiftKey ? 5 : 1));
    emit(Math.max(0, Math.min(max, fromPos(Math.max(0, Math.min(1, p0 + dp))))));
  };
  const db = value <= 0.0001 ? '-∞' : (20 * Math.log10(value)).toFixed(1);
  const onKeyDown = (e) => {
    const fine = e.shiftKey ? 0.005 : 0.02;
    const moves = { ArrowUp: fine, ArrowRight: fine, ArrowDown: -fine, ArrowLeft: -fine, PageUp: 0.1, PageDown: -0.1 };
    if (e.key in moves) emit(Math.max(0, Math.min(max, fromPos(Math.max(0, Math.min(1, pos + moves[e.key]))))));
    else if (e.key === 'Home') emit(0);
    else if (e.key === 'End') emit(max);
    else if (e.key === 'Delete' || e.key === 'Backspace') onChange?.(def);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="fader" style={{ height }} title={title || `${db} dB`} role="slider" tabIndex={0}
      aria-label={title || 'Volume'} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${db} dB`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => onChange?.(def)}
      onWheel={(e) => { e.stopPropagation(); emit(Math.max(0, Math.min(max, fromPos(Math.max(0, Math.min(1, pos + (e.deltaY < 0 ? 0.02 : -0.02))))))); }}>
      <div className="fader-track" />
      <div className="fader-unity" style={{ bottom: `${toPos(1) * 100}%` }} />
      <div className="fader-cap" style={{ bottom: `calc(${pos * 100}% - 7px)` }} />
    </div>
  );
}

/** Number that you can drag vertically or double-click to type (e.g. tempo). */
export function DragNumber({ value, min, max, step = 1, onChange, format = (v) => v, className = '', title, sensitivity = 0.25 }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const drag = useRef(null);
  const emit = useRafCallback((v) => onChange?.(v));
  const onPointerDown = (e) => {
    if (editing || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, v: value, moved: false };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dy = drag.current.y - e.clientY;
    if (Math.abs(dy) > 2) drag.current.moved = true;
    const v = drag.current.v + Math.round((dy * sensitivity * (e.shiftKey ? 0.1 : 1)) / step) * step;
    emit(Math.max(min, Math.min(max, Math.round(v / step) * step)));
  };
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v)) onChange?.(Math.max(min, Math.min(max, v)));
    setEditing(false);
  };
  if (editing) {
    return (
      <input className={`dragnum-input ${className}`} autoFocus value={text} onChange={(e) => setText(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); e.stopPropagation(); }} />
    );
  }
  return (
    <div className={`dragnum ${className}`} title={title || 'Drag up/down or double-click to type'} data-nodrag
      role="spinbutton" tabIndex={0} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
      onKeyDown={(e) => {
        const d = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step }[e.key];
        if (d === undefined) return;
        e.preventDefault();
        e.stopPropagation(); // arrows here change the value, not the studio's shortcuts
        onChange?.(Math.max(min, Math.min(max, value + d * (e.shiftKey ? 10 : 1))));
      }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => { setText(String(value)); setEditing(true); }}
      onWheel={(e) => { e.stopPropagation(); onChange?.(Math.max(min, Math.min(max, value + (e.deltaY < 0 ? step : -step)))); }}>
      {format(value)}
    </div>
  );
}

/** LED-style toggle button */
/** On/off light. label names what "on" means for screen readers (e.g. "Channel on"); title is the hover hint. */
export function Led({ on, onClick, color = 'var(--led)', title, label, size = 10 }) {
  return (
    <button className={`led ${on ? 'on' : ''}`} style={{ '--led-color': color, width: size + 6, height: size + 6 }} title={title}
      role="switch" aria-checked={!!on} aria-label={label || title || 'On'}
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }} />
  );
}

/** A dropdown. options: strings/numbers or { value, label, disabled, group } (options with a group become <optgroup>s). */
export function Select({ value, options, onChange, className = '', title, style, disabled = false }) {
  const item = (o) => (typeof o === 'string' || typeof o === 'number'
    ? <option key={o} value={o}>{o}</option>
    : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>);
  const groups = [];
  for (const o of options) {
    const g = typeof o === 'object' ? o.group : undefined;
    const last = groups.at(-1);
    if (last && last.group === g) last.items.push(o);
    else groups.push({ group: g, items: [o] });
  }
  return (
    <select className={`ui-select ${className}`} value={value ?? ''} title={title} style={style} disabled={disabled}
      onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.stopPropagation()}>
      {groups.map((g, i) => (g.group ? <optgroup key={`${g.group}-${i}`} label={g.group}>{g.items.map(item)}</optgroup> : g.items.map(item)))}
    </select>
  );
}

/** Peak meter driven by a getter, updated via rAF while mounted. */
export function useAnimationFrame(fn, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    let id;
    const loop = (t) => { ref.current(t); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}


