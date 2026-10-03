// Chiptune — example instrument plugin for GreanTeaDawy (runs in the browser's audio worklet).
// The harness calls createVoice() for every note and process() for every 128-sample block; release() at note-off.
gtd.registerInstrument({
  createVoice({ sampleRate, frequency, velocity, params }) {
    const sr = sampleRate;
    const duty = params.duty === '12.5%' ? 0.125 : params.duty === '25%' ? 0.25 : 0.5;
    const peak = velocity * velocity * params.gain; // squared velocity, like the built-in instruments
    const attack = Math.max(0.001, params.attack);
    const decay = Math.max(0.001, params.decay);
    const relK = Math.exp(-6.9 / (Math.max(0.005, params.release) * sr)); // -60 dB after `release`
    let phase = 0;
    let n = 0;
    let env = 0;
    let released = false;
    // polyBLEP: removes the aliasing of the pulse's two jumps
    const blep = (t, dt) => {
      if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
      if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
      return 0;
    };
    return {
      release() { released = true; },
      process(out, frames) {
        const [L, R] = out;
        for (let i = 0; i < frames; i++, n++) {
          const time = n / sr;
          if (released) env *= relK;
          else if (time < attack) env = time / attack;
          else env = params.sustain + (1 - params.sustain) * Math.exp(-(time - attack) / (decay / 3));
          // delayed vibrato: starts at 0.15 s from zero phase and fades in over 0.25 s (no pitch jump)
          const vt = time - 0.15;
          const vib = vt > 0 ? Math.pow(2, (params.vibrato / 1200) * Math.min(1, vt / 0.25) * Math.sin(2 * Math.PI * params.vibratoRate * vt)) : 1;
          const dt = (frequency * vib) / sr;
          phase += dt;
          if (phase >= 1) phase -= 1;
          let s = (phase < duty ? 1 : -1) + blep(phase, dt) - blep((phase - duty + 1) % 1, dt);
          s -= 2 * duty - 1; // remove the pulse's DC offset
          const level = params.steps ? Math.round(env * 15) / 15 : env; // 4-bit volume steps
          const y = s * level * peak * 0.5;
          L[i] = y;
          R[i] = y;
        }
        return !(released && env < 0.0005);
      }
    };
  }
});
