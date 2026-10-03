// Generator template: an arpeggio over the project's scale. generate() must be synchronous and return
// [{ step, length, key, velocity }] in 16th-note steps from 0 to input.steps. Use input.random() (seeded), not Math.random().
gtd.registerGenerator({
  generate({ params, steps, scaleNotes, channel, random }) {
    const root = channel.melodic ? channel.rootKey : 60;
    const pcs = scaleNotes && scaleNotes.length ? scaleNotes : [0, 2, 4, 5, 7, 9, 11];
    const pool = [];
    for (let k = root; k < root + 12 * params.range; k++) if (pcs.includes(((k % 12) + 12) % 12)) pool.push(k);
    const order = params.direction === 'down' ? [...pool].reverse()
      : params.direction === 'updown' ? [...pool, ...pool.slice(1, -1).reverse()]
        : pool;
    const every = params.rate === '8th' ? 2 : 1;
    const notes = [];
    let i = 0;
    for (let s = 0; s < steps; s += every, i++) {
      const key = params.direction === 'random' ? pool[Math.floor(random() * pool.length)] : order[i % order.length];
      const accent = s % 4 === 0 ? 0.1 : 0;
      notes.push({ step: s, length: every * params.gate, key, velocity: Math.min(1, params.velocity + accent) });
    }
    return notes;
  }
});
