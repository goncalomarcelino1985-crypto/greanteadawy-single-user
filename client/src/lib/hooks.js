import { useEffect, useRef, useState } from 'react';
import { getEngine } from '../audio/index.js';
import { useStore } from '../state/store.js';

/** Current transport position in ticks (null when stopped). Polls each animation frame. */
export function getPlayheadTick() {
  const eng = getEngine();
  if (!eng || !eng.transport.playing) return null;
  return eng.transport.positionAt();
}

/**
 * Moves a playhead element directly (no React re-render) for the given transport mode.
 * mapTick(tick) -> x pixels, or null to hide.
 */
export function usePlayheadLine(ref, mapTick, deps = []) {
  const map = useRef(mapTick);
  map.current = mapTick;
  useEffect(() => {
    let id;
    const loop = () => {
      const el = ref.current;
      if (el) {
        const t = getPlayheadTick();
        const x = t == null ? null : map.current(t);
        if (x == null) el.style.display = 'none';
        else {
          el.style.display = 'block';
          el.style.transform = `translateX(${x}px)`;
        }
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Re-render at most `fps` times per second with the current playhead tick. */
export function usePlayheadTick(fps = 30) {
  const [tick, setTick] = useState(null);
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    if (!playing) { setTick(null); return undefined; }
    let id;
    let last = 0;
    const loop = (t) => {
      if (t - last > 1000 / fps) {
        last = t;
        setTick(getPlayheadTick());
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [playing, fps]);
  return tick;
}

export function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observed = useRef(null);
  const ro = useRef(null);
  // re-check every render: the element may mount later (e.g. after an early return)
  useEffect(() => {
    const el = ref.current;
    if (el === observed.current) return;
    ro.current?.disconnect();
    observed.current = el;
    if (!el) return;
    ro.current = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.current.observe(el);
  });
  useEffect(() => () => ro.current?.disconnect(), []);
  return size;
}

/** setPointerCapture that never throws (the pointer may already be gone, e.g. a cancelled touch). */
export function capturePointer(e) {
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
}

/** window.innerWidth, updated on resize. */
export function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}
