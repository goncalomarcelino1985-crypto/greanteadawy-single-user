// Instrument template: one oscillator (naive waveforms — fine for low notes; band-limit for bright leads) + ADSR.
// createVoice() runs for every note; process() fills the stereo output; return false when the voice is finished.
gtd.registerInstrument({
  createVoice({ sampleRate, frequency, velocity, params }) {
    const sr = sampleRate;
    const peak = velocity * velocity * params.gain; // squared velocity, like the built-in instruments
    const attack = Math.max(0.001, params.attack);
    const decay = Math.max(0.01, params.decay);
    const relK = Math.exp(-6.9 / (Math.max(0.005, params.release) * sr)); // -60 dB after `release`
    let phase = 0;
    let n = 0;
    let env = 0;
    let released = false;
    const osc = (p) => {
      if (params.wave === 'sine') return Math.sin(2 * Math.PI * p);
      if (params.wave === 'saw') return 2 * p - 1;
      return 1 - 4 * Math.abs(p - 0.5); // triangle
    };
    return {
      release() { released = true; },
      process(output, frames) {
        for (let i = 0; i < frames; i++, n++) {
          const t = n / sr;
          if (released) env *= relK;
          else if (t < attack) env = t / attack;
          else env = params.sustain + (1 - params.sustain) * Math.exp(-(t - attack) / (decay / 3));
          const s = osc(phase) * env * peak;
          phase += frequency / sr;
          if (phase >= 1) phase -= 1;
          output[0][i] = s;
          output[1][i] = s;
        }
        return !(released && env < 0.0001); // false = done
      }
    };
  }
});
