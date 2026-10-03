// Effect template: soft saturation + one-pole tone filter, with dry/wet mix.
// create() runs once per effect slot; process() runs for every block (128 frames today — don't rely on it).
gtd.registerEffect({
  create({ sampleRate }) {
    let lpL = 0;
    let lpR = 0;
    return {
      process(input, output, frames, params) {
        // tanh(k·x)/k: unity gain for quiet signals, rounded peaks; (1 + amount) is a little makeup gain
        const k = 1 + params.amount * 4;
        const makeup = (1 + params.amount) / k;
        const a = 1 - Math.exp((-2 * Math.PI * params.tone) / sampleRate);
        for (let i = 0; i < frames; i++) {
          const xL = input[0][i];
          const xR = input[1][i];
          lpL += a * (Math.tanh(xL * k) * makeup - lpL);
          lpR += a * (Math.tanh(xR * k) * makeup - lpR);
          output[0][i] = xL + (lpL - xL) * params.mix;
          output[1][i] = xR + (lpR - xR) * params.mix;
        }
      }
    };
  }
});
