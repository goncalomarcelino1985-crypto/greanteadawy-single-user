import { useRef, useState } from 'react';
import { getEngine } from '../audio/index.js';
import { useAnimationFrame } from './ui/Controls.jsx';

/** Small oscilloscope / spectrum display of the master output (click to switch). */
export function Visualizer({ width = 88, height = 30 }) {
  const ref = useRef(null);
  const [mode, setMode] = useState('scope');
  const buf = useRef(null);
  useAnimationFrame(() => {
    const c = ref.current;
    const eng = getEngine();
    if (!c) return;
    const g = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== width * dpr) { c.width = width * dpr; c.height = height * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const styles = getComputedStyle(c);
    g.strokeStyle = styles.getPropertyValue('--viz-color') || '#9ad94f';
    g.fillStyle = g.strokeStyle;
    if (!eng) {
      g.globalAlpha = 0.4;
      g.beginPath(); g.moveTo(0, height / 2); g.lineTo(width, height / 2); g.stroke();
      g.globalAlpha = 1;
      return;
    }
    const an = eng.analyser;
    if (mode === 'scope') {
      if (!buf.current || buf.current.length !== an.fftSize) buf.current = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf.current);
      const d = buf.current;
      // trigger on a rising zero crossing for a stable display
      let start = 0;
      for (let i = 1; i < d.length / 2; i++) if (d[i - 1] < 0 && d[i] >= 0) { start = i; break; }
      const n = Math.min(512, d.length - start);
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * width;
        const y = height / 2 - d[start + i] * (height / 2) * 0.9;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
    } else {
      const bins = an.frequencyBinCount;
      if (!buf.current || buf.current.length !== bins) buf.current = new Float32Array(bins);
      an.getFloatFrequencyData(buf.current);
      const bars = 32;
      const bw = width / bars;
      for (let b = 0; b < bars; b++) {
        const f0 = Math.floor(Math.pow(bins, b / bars));
        const f1 = Math.max(f0 + 1, Math.floor(Math.pow(bins, (b + 1) / bars)));
        let m = -140;
        for (let i = f0; i < f1 && i < bins; i++) m = Math.max(m, buf.current[i]);
        const h = Math.max(0, Math.min(1, (m + 90) / 80)) * height;
        g.fillRect(b * bw + 0.5, height - h, bw - 1, h);
      }
    }
  });
  return (
    <canvas ref={ref} className="visualizer" style={{ width, height }} title="Master output (click: scope / spectrum)"
      onClick={() => setMode((m) => (m === 'scope' ? 'spectrum' : 'scope'))} />
  );
}
