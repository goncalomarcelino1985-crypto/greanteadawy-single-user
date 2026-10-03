// Tape Wobble — example effect plugin for GreanTeaDawy (runs in the browser's audio worklet).
// create() is called once per effect slot; process() gets [left, right] input and output blocks plus the current params.
gtd.registerEffect({
  create({ sampleRate }) {
    const sr = sampleRate;
    const size = Math.ceil(sr * 0.06);
    const bufL = new Float32Array(size);
    const bufR = new Float32Array(size);
    let w = 0;
    let wowPhase = 0;
    let flutterPhase = 0;
    let lpL = 0;
    let lpR = 0;
    const read = (buf, delay) => {
      let pos = w - delay;
      while (pos < 0) pos += size;
      const i = Math.floor(pos);
      const f = pos - i;
      return buf[i] * (1 - f) + buf[(i + 1) % size] * f;
    };
    return {
      process(input, output, frames, params) {
        const [inL, inR] = input;
        const [L, R] = output;
        // tape saturation: tanh(k·x)/k has unity gain for quiet signals and rounds off the peaks
        const k = 1 + params.drive * 3;
        const a = 1 - Math.exp((-2 * Math.PI * params.tone) / sr);
        for (let i = 0; i < frames; i++) {
          wowPhase += 0.55 / sr;
          flutterPhase += 7.3 / sr;
          if (wowPhase > 1) wowPhase -= 1;
          if (flutterPhase > 1) flutterPhase -= 1;
          // delay modulation in samples: wow up to 6 ms, flutter up to 0.6 ms, around a fixed 2 ms
          const d = sr * (0.002 + params.wow * 0.006 * (0.5 + 0.5 * Math.sin(2 * Math.PI * wowPhase)) + params.flutter * 0.0006 * (0.5 + 0.5 * Math.sin(2 * Math.PI * flutterPhase)));
          bufL[w] = inL[i];
          bufR[w] = inR[i];
          let yL = Math.tanh(read(bufL, d) * k) / k;
          let yR = Math.tanh(read(bufR, d) * k) / k;
          lpL += a * (yL - lpL);
          lpR += a * (yR - lpR);
          yL = lpL;
          yR = lpR;
          L[i] = inL[i] * (1 - params.mix) + yL * params.mix;
          R[i] = inR[i] * (1 - params.mix) + yR * params.mix;
          w = (w + 1) % size;
        }
      }
    };
  }
});
