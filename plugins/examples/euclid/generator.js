// Euclidean Rhythms — example generator plugin for GreanTeaDawy. Runs in an isolated sandbox (no network, no access
// to the studio); generate() returns notes in 16th-note steps: [{ step, length, key, velocity }].
gtd.registerGenerator({
  generate({ params, steps, channel, random }) {
    const k = Math.min(params.pulses, params.cycle);
    const n = params.cycle;
    // Bresenham form of Bjorklund's algorithm: k hits spread evenly over n steps, the first one on step 0
    // (3/8 → x--x--x-, the tresillo)
    const hit = (i) => (i * k) % n < k;
    const notes = [];
    for (let s = 0; s < steps; s++) {
      const i = (((s - params.rotate) % n) + n) % n;
      if (!hit(i)) continue;
      const v = params.velocity + (i === 0 ? params.accent : 0) + (random() * 2 - 1) * params.humanize; // accent: the cycle's first hit
      notes.push({ step: s, length: params.gate, key: channel.rootKey, velocity: Math.max(0.05, Math.min(1, v)) });
    }
    return notes;
  }
});
