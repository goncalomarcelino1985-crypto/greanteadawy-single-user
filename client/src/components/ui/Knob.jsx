import { useRef, useCallback } from 'react';

function toNorm(v, min, max, curve) {
  if (curve === 'log' && min > 0) return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}
function fromNorm(n, min, max, curve) {
  if (curve === 'log' && min > 0) return min * Math.pow(max / min, n);
  return min + (max - min) * n;
}

export function formatValue(v, { unit, step } = {}) {
  if (typeof v !== 'number') return String(v);
  let s;
  if (unit === 'Hz' && v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz`;
  if (unit === 's' && v < 1) return `${Math.round(v * 1000)} ms`;
  if (step && step >= 1) s = String(Math.round(v));
  else if (Math.abs(v) >= 100) s = v.toFixed(0);
  else if (Math.abs(v) >= 10) s = v.toFixed(1);
  else s = v.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

/** Hook: throttle a callback to one call per animation frame (last value wins). */
export function useRafCallback(fn) {
  const pending = useRef(null);
  const frame = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return useCallback((...args) => {
    pending.current = args;
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const a = pending.current;
        pending.current = null;
        if (a) fnRef.current(...a);
      });
    }
  }, []);
}

/**
 * Rotary knob. Drag up/down (Shift = fine), wheel to nudge, double-click to reset.
 */
export function Knob({
  value, min = 0, max = 1, curve, def, step, onChange, size = 30, label, unit, color = 'var(--accent)',
  bipolar = false, title, disabled = false, showValue = false
}) {
  const ref = useRef(null);
  const drag = useRef(null);
  const emit = useRafCallback((v) => onChange?.(v));
  const n = Math.max(0, Math.min(1, toNorm(value ?? 0, min, max, curve)));

  const setNorm = (nn) => {
    let v = fromNorm(Math.max(0, Math.min(1, nn)), min, max, curve);
    if (step) v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    emit(v);
  };

  const onPointerDown = (e) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, n };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const dy = drag.current.y - e.clientY;
    setNorm(drag.current.n + dy / (e.shiftKey ? 800 : 160));
  };
  const onPointerUp = () => { drag.current = null; };
  const onWheel = (e) => {
    if (disabled) return;
    e.stopPropagation();
    setNorm(n + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.005 : 0.03));
  };
  const onDoubleClick = () => {
    if (!disabled && def !== undefined) onChange?.(def);
  };
  const onKeyDown = (e) => {
    if (disabled) return;
    const fine = e.shiftKey ? 0.005 : 0.02;
    const moves = { ArrowUp: fine, ArrowRight: fine, ArrowDown: -fine, ArrowLeft: -fine, PageUp: 0.1, PageDown: -0.1 };
    if (e.key in moves) setNorm(n + moves[e.key]);
    else if (e.key === 'Home') setNorm(0);
    else if (e.key === 'End') setNorm(1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && def !== undefined) onChange?.(def);
    else return;
    e.preventDefault();
    e.stopPropagation(); // don't trigger studio shortcuts while adjusting a control
  };

  const r = size / 2 - 3;
  const c = size / 2;
  const a0 = 135;
  const sweep = 270;
  const angle = a0 + sweep * n;
  const pt = (deg, rad = r) => [c + rad * Math.cos((deg * Math.PI) / 180), c + rad * Math.sin((deg * Math.PI) / 180)];
  const arc = (from, to) => {
    if (Math.abs(to - from) < 0.01) return '';
    const [x1, y1] = pt(from);
    const [x2, y2] = pt(to);
    const large = Math.abs(to - from) > 180 ? 1 : 0;
    const sweepFlag = to > from ? 1 : 0;
    return `M${x1} ${y1} A${r} ${r} 0 ${large} ${sweepFlag} ${x2} ${y2}`;
  };
  const centerA = a0 + sweep / 2;
  const valueArc = bipolar ? (angle >= centerA ? arc(centerA, angle) : arc(angle, centerA)) : arc(a0, angle);
  const [px, py] = pt(angle, r - 3);
  const tip = title || `${label ? `${label}: ` : ''}${formatValue(value, { unit, step })}`;

  return (
    <div className={`knob ${disabled ? 'disabled' : ''}`} title={tip} role="slider" tabIndex={disabled ? -1 : 0}
      aria-label={label || title || 'Knob'} aria-valuemin={min} aria-valuemax={max} aria-valuenow={typeof value === 'number' ? value : undefined}
      aria-valuetext={formatValue(value, { unit, step })} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
      <svg ref={ref} width={size} height={size} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel} onDoubleClick={onDoubleClick}>
        <path d={arc(a0, a0 + sweep)} stroke="var(--knob-track)" strokeWidth="3" fill="none" strokeLinecap="round" />
        {valueArc && <path d={valueArc} stroke={color} strokeWidth="3" fill="none" strokeLinecap="round" />}
        <circle cx={c} cy={c} r={r - 4} fill="var(--knob-face)" />
        <line x1={c} y1={c} x2={px} y2={py} stroke="var(--knob-pointer)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {label && <div className="knob-label">{label}</div>}
      {showValue && <div className="knob-value">{formatValue(value, { unit, step })}</div>}
    </div>
  );
}
