// Counter Melody — example generator plugin (permission "project-read": it receives the pattern's notes).
gtd.registerGenerator({
  generate({ params, notes, scaleNotes, channel, random }) {
    // the melody to follow: the channel (other than the target) with the highest average pitch
    const byChannel = new Map();
    for (const n of notes || []) {
      if (n.channel === channel.name) continue;
      if (!byChannel.has(n.channel)) byChannel.set(n.channel, []);
      byChannel.get(n.channel).push(n);
    }
    let lead = [];
    let best = -1;
    for (const list of byChannel.values()) {
      const avg = list.reduce((a, n) => a + n.key, 0) / list.length;
      if (avg > best) { best = avg; lead = list; }
    }
    // the melody's top line: one note per step (the highest)
    const top = new Map();
    for (const n of lead) if (!top.has(n.step) || top.get(n.step).key < n.key) top.set(n.step, n);
    const line = [...top.values()].sort((a, b) => a.step - b.step);
    const pcs = scaleNotes && scaleNotes.length ? scaleNotes : [0, 2, 3, 5, 7, 8, 10];
    const inScale = (k) => pcs.includes(((k % 12) + 12) % 12);
    // move `steps` scale degrees down from k
    const down = (k, steps) => { let x = k; let s = 0; while (s < steps && x > 0) { x -= 1; if (inScale(x)) s++; } return x; };
    return line.filter(() => random() < params.density).map((n, i) => {
      const deg = params.interval === 'third' ? 2 : params.interval === 'sixth' ? 5 : (i % 2 ? 5 : 2);
      const key = down(inScale(n.key) ? n.key : n.key - 1, deg) + 12 * params.octave;
      return { step: n.step, length: n.length, key, velocity: params.velocity * (0.9 + random() * 0.2) };
    });
  }
});
