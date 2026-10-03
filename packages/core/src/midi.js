// Minimal Standard MIDI File (SMF) writer and reader.
import { PPQ } from './constants.js';
import { INSTRUMENTS } from './instruments.js';
import { allSongNotes } from './timeline.js';

function vlq(n) {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

function strBytes(s) {
  return Array.from(new TextEncoder().encode(s));
}

function chunk(type, data) {
  const len = data.length;
  return [...strBytes(type), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

function trackChunk(events) {
  // events: [{ tick, bytes, order }]
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(Math.max(0, e.tick - last)), ...e.bytes);
    last = e.tick;
  }
  data.push(0x00, 0xff, 0x2f, 0x00);
  return chunk('MTrk', data);
}

/**
 * Export a project to a type-1 MIDI file.
 * mode 'song' renders the playlist; mode 'pattern' renders a single pattern.
 */
export function projectToMidi(project, { mode = 'song', patternId } = {}) {
  let notes;
  if (mode === 'pattern' || !project.playlist.clips.some((c) => c.kind === 'pattern')) {
    const p = project.patterns.find((x) => x.id === patternId) || project.patterns[0];
    notes = [];
    for (const [channelId, list] of Object.entries(p?.notes || {})) for (const n of list) notes.push({ ...n, channelId });
  } else {
    notes = allSongNotes(project);
  }
  const tempo = Math.round(60000000 / project.bpm);
  const [num, den] = project.timeSig;
  const meta = [
    { tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(strBytes(project.name).length), ...strBytes(project.name)] },
    { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255] },
    { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, num, Math.log2(den), 24, 8] }
  ];
  const tracks = [trackChunk(meta)];
  let melodicChan = 0;
  for (const c of project.channels) {
    const list = notes.filter((n) => n.channelId === c.id);
    if (!list.length) continue;
    const def = INSTRUMENTS[c.instrument.kind];
    const isDrum = !def.melodic && def.gm;
    let ch;
    if (isDrum) ch = 9;
    else {
      ch = melodicChan % 16;
      if (ch === 9) ch = ++melodicChan % 16;
      melodicChan++;
    }
    const events = [{ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(strBytes(c.name).length), ...strBytes(c.name)] }];
    for (const n of list) {
      let key = isDrum ? def.gm + (n.key - 60) : n.key + Math.round(c.pitch || 0);
      key = Math.max(0, Math.min(127, key));
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
      events.push({ tick: n.start, order: 2, bytes: [0x90 | ch, key, vel] });
      events.push({ tick: n.start + n.length, order: 1, bytes: [0x80 | ch, key, 0] });
    }
    tracks.push(trackChunk(events));
  }
  const header = chunk('MThd', [0, 1, (tracks.length >> 8) & 255, tracks.length & 255, (PPQ >> 8) & 255, PPQ & 255]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

/** Parse a MIDI file into tracks of notes (ticks converted to PPQ 96). */
export function parseMidi(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  const read32 = () => { const v = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]; pos += 4; return v >>> 0; };
  const read16 = () => { const v = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; return v; };
  const readStr = (len) => { const s = new TextDecoder().decode(bytes.slice(pos, pos + len)); pos += len; return s; };
  const readVlq = () => { let v = 0; let b; do { b = bytes[pos++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && pos < bytes.length); return v; };

  if (readStr(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = read32();
  const format = read16();
  const ntracks = read16();
  const division = read16();
  pos += hlen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const scale = PPQ / division;
  let bpm = null;
  let timeSig = null;
  const tracks = [];
  for (let t = 0; t < ntracks && pos < bytes.length; t++) {
    const type = readStr(4);
    const len = read32();
    const end = pos + len;
    if (type !== 'MTrk') { pos = end; continue; }
    let tick = 0;
    let status = 0;
    let name = '';
    const open = new Map();
    const notes = [];
    let program = null;
    let channel = null;
    while (pos < end) {
      tick += readVlq();
      const b = bytes[pos];
      if (b & 0x80) { status = b; pos++; } else if (!status) { pos++; continue; }
      const hi = status & 0xf0;
      if (status === 0xff) {
        const mtype = bytes[pos++];
        const mlen = readVlq();
        if (mtype === 0x03 && !name) name = new TextDecoder().decode(bytes.slice(pos, pos + mlen));
        if (mtype === 0x51 && bpm === null) bpm = Math.round(60000000 / ((bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2]) * 100) / 100;
        if (mtype === 0x58 && !timeSig) timeSig = [bytes[pos], Math.pow(2, bytes[pos + 1])];
        pos += mlen;
        status = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVlq();
        status = 0;
      } else if (hi === 0x90 || hi === 0x80) {
        const key = bytes[pos++];
        const vel = bytes[pos++];
        const ch = status & 0x0f;
        channel = channel ?? ch;
        const k = `${ch}:${key}`;
        if (hi === 0x90 && vel > 0) {
          if (!open.has(k)) open.set(k, []);
          open.get(k).push({ start: tick, vel });
        } else {
          const stack = open.get(k);
          const on = stack?.shift();
          if (on) notes.push({ key, start: Math.round(on.start * scale), length: Math.max(1, Math.round((tick - on.start) * scale)), velocity: Math.round((on.vel / 127) * 100) / 100, channel: ch });
        }
      } else if (hi === 0xc0) {
        program = bytes[pos++];
      } else if (hi === 0xd0) {
        pos += 1;
      } else {
        pos += 2; // 0xA0, 0xB0, 0xE0
      }
    }
    pos = end;
    if (notes.length) {
      notes.sort((a, b) => a.start - b.start || a.key - b.key);
      tracks.push({ name: name || `Track ${tracks.length + 1}`, notes, program, channel, isDrum: channel === 9 });
    }
  }
  return { format, bpm, timeSig, tracks };
}
