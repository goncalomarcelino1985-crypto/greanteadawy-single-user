// Spatial (Atmos-style) model: object settings, ops, automation, speaker panning, polar input, ADM metadata, WAV chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultProject, createProjectFromTemplate, applyOps, normalizeProject, summarizeProject, decodeWav, encodeWav,
  normalizeInsertSpatial, isSpatialObject, spatialObjects, speakerGains, SPEAKER_LAYOUTS, polarToPosition,
  objectPositionAt, objectBlocks, buildAdmXml, admChna, bextChunk, admTime, spatialToNorm, spatialFromNorm, POSITION_PRESETS
} from '../src/index.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const idx = (layout, id) => SPEAKER_LAYOUTS[layout].speakers.findIndex(([s]) => s === id);

test('spatial settings: defaults, clamping, normalization of old projects', () => {
  const p = createDefaultProject();
  assert.deepEqual(p.spatial, { enabled: false, monitor: 'stereo' });
  assert.deepEqual(p.mixer[1].spatial, { enabled: false, x: 0, y: 1, z: 0, lfe: 0 });
  assert.deepEqual(normalizeInsertSpatial({ enabled: 1, x: 5, y: -3, z: -1, lfe: 2 }), { enabled: true, x: 1, y: -1, z: 0, lfe: 1 });
  assert.equal(normalizeInsertSpatial({}, -0.4).x, -0.4); // a new object starts at its pan position on the front wall
  const old = JSON.parse(JSON.stringify(p));
  delete old.spatial;
  for (const m of old.mixer) delete m.spatial;
  old.mixer[2].spatial = { enabled: true, x: 'bad', y: 0.5 };
  old.spatial = { enabled: true, monitor: 'surround-sound' };
  const n = normalizeProject(old);
  assert.deepEqual(n.spatial, { enabled: true, monitor: 'stereo' });
  assert.deepEqual(n.mixer[2].spatial, { enabled: true, x: 0, y: 0.5, z: 0, lfe: 0 });
  assert.equal(n.mixer[0].spatial.enabled, false); // the master is never an object
});

test('spatial ops: project/update and mixer/update merge; objects need the spatial mix and a route to the master', () => {
  let p = createDefaultProject();
  p = applyOps(p, [{ type: 'mixer/update', index: 1, patch: { spatial: { enabled: true, x: -1 } } }]);
  assert.deepEqual(p.mixer[1].spatial, { enabled: true, x: -1, y: 1, z: 0, lfe: 0 });
  assert.equal(isSpatialObject(p, 1), false); // spatial mix still off
  p = applyOps(p, [{ type: 'project/update', patch: { spatial: { enabled: true } } }]);
  assert.deepEqual(p.spatial, { enabled: true, monitor: 'stereo' });
  assert.deepEqual(spatialObjects(p), [1]);
  p = applyOps(p, [{ type: 'mixer/update', index: 1, patch: { spatial: { z: 0.5 } } }]);
  assert.deepEqual(p.mixer[1].spatial, { enabled: true, x: -1, y: 1, z: 0.5, lfe: 0 });
  p = applyOps(p, [{ type: 'mixer/update', index: 1, patch: { output: 2 } }]);
  assert.equal(isSpatialObject(p, 1), false); // routed into a bus
  p = applyOps(p, [{ type: 'mixer/update', index: 0, patch: { spatial: { enabled: true } } }]);
  assert.equal(p.mixer[0].spatial.enabled, false);
  assert.throws(() => applyOps(p, [{ type: 'mixer/update', index: 1, patch: { spatial: 'left' } }]), /spatial must be an object/);
  assert.match(summarizeProject(applyOps(p, [{ type: 'mixer/update', index: 1, patch: { output: 0 } }])), /spatial \(3D\) mix ON[\s\S]*3D\(-1, 1, 0\.5\)/);
});

test('position automation: spatialX/Y/Z targets (not on the master) and the position at a song tick', () => {
  let p = createProjectFromTemplate('band');
  p = applyOps(p, [
    { type: 'project/update', patch: { spatial: { enabled: true } } },
    { type: 'mixer/update', index: 4, patch: { spatial: { enabled: true, x: 0, y: 1, z: 0 } } },
    { type: 'automation/add', automation: { id: 'auto_x', name: 'x', target: { type: 'mixer', index: 4, param: 'spatialX' }, length: 384, points: [{ t: 0, v: 0 }, { t: 384, v: 1 }] } },
    { type: 'clip/add', clips: [{ id: 'clip_x', kind: 'automation', refId: 'auto_x', track: 9, start: 384, length: 384 }] }
  ]);
  assert.throws(() => applyOps(p, [{ type: 'automation/add', automation: { name: 'm', target: { type: 'mixer', index: 0, param: 'spatialX' }, length: 96, points: [] } }]), /volume, pan/);
  assert.deepEqual(objectPositionAt(p, 4, 0), { enabled: true, x: 0, y: 1, z: 0, lfe: 0 }); // before the clip: static
  assert.ok(near(objectPositionAt(p, 4, 384).x, -1));
  assert.ok(near(objectPositionAt(p, 4, 576).x, 0));
  assert.ok(near(spatialFromNorm('spatialZ', spatialToNorm('spatialZ', 0.25)), 0.25));
  const blocks = objectBlocks(p, 4, { song: true, ticks: 384 * 3 });
  assert.equal(blocks[0].start, 0);
  assert.ok(blocks.length >= 3 && blocks.length < 40, `${blocks.length} blocks`); // the linear move collapses to few blocks
  assert.ok(near(blocks.at(-1).x, 1, 0.02));
  // ADM semantics: a block glides to its position by its end. Halfway through the move (bar 2.5) the object is
  // halfway between the positions of the block that covers that time: the move is a glide, not a hold + jump
  const sec = (t) => t * (60 / p.bpm / 96);
  const at = (time) => {
    let prev = blocks[0];
    for (const b of blocks) {
      if (time < b.start + b.duration) return b.jump ? b.x : prev.x + ((time - b.start) / b.duration) * (b.x - prev.x);
      prev = b;
    }
    return blocks.at(-1).x;
  };
  for (const tick of [0, 384, 480, 576, 672, 768, 1000]) assert.ok(near(at(sec(tick)), objectPositionAt(p, 4, tick).x, 0.03), `tick ${tick}: ${at(sec(tick))} vs ${objectPositionAt(p, 4, tick).x}`);
  for (let i = 1; i < blocks.length; i++) assert.ok(near(blocks[i].start, blocks[i - 1].start + blocks[i - 1].duration, 1e-6), 'blocks are contiguous');
  assert.deepEqual(objectBlocks(p, 4, { song: false, ticks: 384 }), [{ start: 0, duration: Math.round(384 * (60 / p.bpm / 96) * 1000) / 1000, x: 0, y: 1, z: 0, jump: true }]);
  // slow and curved moves: the blocks a BS.2076 renderer reads reproduce the automation everywhere (within 0.03),
  // including a move that starts late (bar 9) and a curve; a cut in the automation stays a cut
  const curve = Array.from({ length: 33 }, (_, i) => ({ t: i * 192, v: 0.5 + 0.5 * Math.sin((i / 32) * 2 * Math.PI) }));
  let q = applyOps(createProjectFromTemplate('band'), [
    { type: 'project/update', patch: { spatial: { enabled: true } } },
    { type: 'mixer/update', index: 4, patch: { spatial: { enabled: true, x: -1, y: 1, z: 0 } } },
    { type: 'mixer/update', index: 5, patch: { spatial: { enabled: true, x: 0, y: 1, z: 0 } } },
    { type: 'mixer/update', index: 6, patch: { spatial: { enabled: true, x: -1, y: 1, z: 0 } } },
    { type: 'automation/add', automation: { id: 'auto_slow', name: 'slow', target: { type: 'mixer', index: 4, param: 'spatialX' }, length: 384 * 16, points: [{ t: 0, v: 0 }, { t: 384 * 16, v: 1 }] } },
    { type: 'automation/add', automation: { id: 'auto_curve', name: 'curve', target: { type: 'mixer', index: 5, param: 'spatialX' }, length: 384 * 16, points: curve } },
    { type: 'automation/add', automation: { id: 'auto_cut', name: 'cut', target: { type: 'mixer', index: 6, param: 'spatialX' }, length: 384 * 4, points: [{ t: 0, v: 0 }, { t: 768, v: 0 }, { t: 769, v: 1 }, { t: 1536, v: 1 }] } },
    { type: 'clip/add', clips: [
      { id: 'clip_slow', kind: 'automation', refId: 'auto_slow', track: 9, start: 384 * 8, length: 384 * 16 },
      { id: 'clip_curve', kind: 'automation', refId: 'auto_curve', track: 10, start: 0, length: 384 * 16 },
      { id: 'clip_cut', kind: 'automation', refId: 'auto_cut', track: 11, start: 0, length: 384 * 4 }
    ] }
  ]);
  const ticks = 384 * 28;
  const s = (t) => t * (60 / q.bpm / 96);
  const rendererX = (bl, time) => {
    let prev = bl[0];
    for (const b of bl) {
      if (time < b.start + b.duration) return b.jump ? b.x : prev.x + ((time - b.start) / b.duration) * (b.x - prev.x);
      prev = b;
    }
    return bl.at(-1).x;
  };
  for (const index of [4, 5]) {
    const bl = objectBlocks(q, index, { song: true, ticks });
    assert.ok(bl.length < 400, `${bl.length} blocks`);
    for (let t = 0; t < ticks; t += 48) assert.ok(near(rendererX(bl, s(t)), objectPositionAt(q, index, t).x, 0.03), `insert ${index} tick ${t}: ${rendererX(bl, s(t))} vs ${objectPositionAt(q, index, t).x}`);
  }
  const cut = objectBlocks(q, 6, { song: true, ticks: 384 * 4 });
  assert.ok(cut.some((b) => b.jump && b.x === 1 && b.start > 0 && b.duration < 0.1), 'the cut is a jump block');
  // a fast smooth move (2 turns in one bar) keeps gliding: no jumps in the middle of it
  q = applyOps(q, [
    { type: 'automation/add', automation: { id: 'auto_fast', name: 'fast', target: { type: 'mixer', index: 5, param: 'spatialX' }, length: 384, points: Array.from({ length: 17 }, (_, i) => ({ t: i * 24, v: 0.5 + 0.5 * Math.sin((i / 16) * 4 * Math.PI) })) } },
    { type: 'clip/remove', ids: ['clip_curve'] },
    { type: 'clip/add', clips: [{ id: 'clip_fast', kind: 'automation', refId: 'auto_fast', track: 10, start: 384, length: 384 }] }
  ]);
  const fast = objectBlocks(q, 5, { song: true, ticks: 384 * 3 });
  assert.equal(fast.filter((b) => b.jump && b.start > 0.01 && b.start < s(384 * 2) - 0.01).length, 0);
  for (let t = 0; t < 384 * 3; t += 12) assert.ok(near(rendererX(fast, s(t)), objectPositionAt(q, 5, t).x, 0.03), `fast tick ${t}`);
  q = null;
  // the normalizer keeps spatial automation of inserts (and drops it for the master)
  const n = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.ok(n.automations.find((a) => a.id === 'auto_x'));
});

test('speaker panning: energy-preserving, localised, folds height down, spreads near the listener', () => {
  for (const layout of Object.keys(SPEAKER_LAYOUTS)) {
    for (const name of Object.keys(POSITION_PRESETS)) {
      const [x, y, z] = POSITION_PRESETS[name];
      const g = speakerGains(layout, { x, y, z });
      assert.ok(near(g.reduce((a, v) => a + v * v, 0), 1), `${layout} ${name} energy`);
      assert.equal(g[idx(layout, 'LFE')], 0);
      assert.ok(g.every((v) => v >= 0 && Number.isFinite(v)));
    }
  }
  // Cartesian positions follow the room, as in ADM: the front corners are the L/R speakers, the sides the side
  // surrounds (7.1) and the rear corners the rearmost surrounds
  for (const layout of ['5.1', '7.1', '7.1.4']) {
    const fl = speakerGains(layout, { x: -1, y: 1, z: 0 });
    assert.ok(near(fl[idx(layout, 'L')], 1), `${layout} front-left → L`);
    const rr = speakerGains(layout, { x: 1, y: -1, z: 0 });
    assert.ok(near(rr[idx(layout, layout === '5.1' ? 'Rs' : 'Rrs')], 1), `${layout} rear-right`);
  }
  assert.ok(near(speakerGains('7.1', { x: -1, y: 0, z: 0 })[idx('7.1', 'Lss')], 1));
  const side51 = speakerGains('5.1', { x: -1, y: 0, z: 0 }); // between L and Ls
  assert.ok(near(side51[idx('5.1', 'L')], side51[idx('5.1', 'Ls')], 1e-6));
  assert.ok(near(speakerGains('7.1.4', { x: -1, y: 1, z: 1 })[idx('7.1.4', 'Ltf')], 1)); // top front corner → Ltf
  // walking along the walls the gains change smoothly (no jumps between speaker pairs) and keep unit energy
  for (const layout of ['5.1', '7.1', '7.1.4']) {
    const wall = (u) => { // 0..4 around the square room, starting front-left, clockwise
      const t = u % 1;
      const side = Math.floor(u) % 4;
      return [{ x: -1 + 2 * t, y: 1 }, { x: 1, y: 1 - 2 * t }, { x: 1 - 2 * t, y: -1 }, { x: -1, y: -1 + 2 * t }][side];
    };
    let prev = speakerGains(layout, { ...wall(0), z: 0.3 });
    for (let u = 0.002; u <= 4; u += 0.002) {
      const g = speakerGains(layout, { ...wall(u), z: 0.3 });
      assert.ok(near(g.reduce((a, v) => a + v * v, 0), 1, 1e-9));
      assert.ok(Math.max(...g.map((v, i) => Math.abs(v - prev[i]))) < 0.02, `${layout} jump at ${u.toFixed(3)}`);
      prev = g;
    }
  }
  // front centre → C
  assert.ok(speakerGains('7.1', { x: 0, y: 1, z: 0 })[idx('7.1', 'C')] > 0.8);
  // overhead: only height speakers on 7.1.4, an even spread on 5.1
  const top = speakerGains('7.1.4', { x: 0, y: 0, z: 1 });
  for (const id of ['Ltf', 'Rtf', 'Ltr', 'Rtr']) assert.ok(near(top[idx('7.1.4', id)], 0.5, 0.01), id);
  const top51 = speakerGains('5.1', { x: 0, y: 0, z: 1 }).filter((v) => v > 0);
  assert.equal(top51.length, 5);
  assert.ok(Math.max(...top51) - Math.min(...top51) < 1e-9);
  // rear-left on 7.1 favours the rear surround
  const rl = speakerGains('7.1', { x: -1, y: -1, z: 0 });
  assert.equal(rl.indexOf(Math.max(...rl)), idx('7.1', 'Lrs'));
});

test('polar positions: azimuth clockwise from the front, elevation up, distance to the walls', () => {
  assert.deepEqual(polarToPosition({ azimuth: 0 }), { x: 0, y: 1, z: 0 });
  assert.deepEqual(polarToPosition({ azimuth: 90 }), { x: 1, y: 0, z: 0 });
  assert.deepEqual(polarToPosition({ azimuth: -90, distance: 0.5 }), { x: -0.5, y: 0, z: 0 });
  assert.deepEqual(polarToPosition({ azimuth: 180 }), { x: 0, y: -1, z: 0 });
  assert.deepEqual(polarToPosition({ azimuth: 45 }), { x: 1, y: 1, z: 0 });
  assert.deepEqual(polarToPosition({ elevation: 90 }), { x: 0, y: 0, z: 1 });
});

test('ADM BWF: axml references resolve, chna rows, bext, extensible WAV with chunks decodes', () => {
  const objects = [
    { name: 'Lead <vox>', blocks: [{ start: 0, duration: 2, x: 0, y: 1, z: 0 }] },
    { name: 'Pad', blocks: [{ start: 0, duration: 1, x: -1, y: 1, z: 0 }, { start: 1, duration: 1, x: 1, y: -1, z: 1 }] }
  ];
  const xml = buildAdmXml({ title: 'Mix & "Song"', duration: 2, objects });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /audioProgrammeName="Mix &amp; &quot;Song&quot;"/);
  assert.match(xml, /audioObjectName="Lead &lt;vox&gt;"/);
  assert.equal((xml.match(/<audioObject /g) || []).length, 3); // bed + 2 objects
  assert.equal((xml.match(/<audioBlockFormat /g) || []).length, 3);
  assert.equal((xml.match(/<audioTrackUID /g) || []).length, 4);
  // every referenced ID is defined (or a common definition: AP_0001…, AT_0001…)
  const defined = new Set([...xml.matchAll(/ (?:audio\w+ID|UID)="([^"]+)"/g)].map((m) => m[1]));
  for (const [, ref] of xml.matchAll(/<audio\w+IDRef>([^<]+)</g)) assert.ok(defined.has(ref) || /^(AP|AT)_0001/.test(ref), ref);
  for (const [, ref] of xml.matchAll(/<audioTrackUIDRef>([^<]+)</g)) assert.ok(defined.has(ref), ref);
  assert.match(xml, /<position coordinate="Z">1<\/position>/);
  assert.equal((xml.match(/<jumpPosition>1<\/jumpPosition>/g) || []).length, 0); // these blocks glide (no jump flag)
  // a holding block is flagged, and the programme's tail is covered by a hold after the last glide
  const held = buildAdmXml({ duration: 3, objects: [{ name: 'A', blocks: [{ start: 0, duration: 0.001, x: -1, y: 1, z: 0, jump: true }, { start: 0.001, duration: 1.999, x: 1, y: 1, z: 0 }] }] });
  assert.equal((held.match(/<audioBlockFormat /g) || []).length, 3);
  assert.equal((held.match(/<jumpPosition>1<\/jumpPosition>/g) || []).length, 2);
  assert.match(held, /rtime="00:00:02.00000" duration="00:00:01.00000"/);
  // names with control characters still give well-formed XML
  const ctl = buildAdmXml({ title: 'a\u0001b', duration: 1, objects: [{ name: 'x\u0002y', blocks: [] }] });
  assert.ok(!ctl.includes('\u0001') && !ctl.includes('\u0002'));
  assert.equal(admTime(3725.5), '01:02:05.50000');

  const chna = admChna(2);
  const v = new DataView(chna.buffer);
  assert.equal(chna.length, 4 + 4 * 40);
  assert.equal(v.getUint16(0, true), 4);
  assert.equal(v.getUint16(2, true), 4);
  const row = (i) => String.fromCharCode(...chna.subarray(4 + i * 40 + 2, 4 + i * 40 + 39));
  assert.equal(row(0), 'ATU_00000001AT_00010001_01AP_00010002');
  assert.equal(row(3), 'ATU_00000004AT_00031002_01AP_00031002');
  assert.equal(v.getUint16(4 + 3 * 40, true), 4); // track index

  const bext = bextChunk({ description: 'x', date: new Date('2026-10-01T12:34:56Z') });
  assert.equal(bext.length, 602);
  assert.equal(String.fromCharCode(...bext.subarray(320, 338)), '2026-10-0112:34:56');

  const n = 101; // odd frame count, mono-per-track 24-bit: exercises the pad byte
  const chans = Array.from({ length: 4 }, (_, c) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / (c + 2)) * 0.5));
  const wav = encodeWav(chans, 48000, { bitDepth: 24, channelMask: 0, chunks: [{ id: 'bext', data: bext }, { id: 'chna', data: chna }, { id: 'axml', data: new TextEncoder().encode(xml) }] });
  const dv = new DataView(wav.buffer);
  assert.equal(dv.getUint32(4, true) + 8, wav.length);
  assert.equal(dv.getUint16(20, true), 0xfffe);
  const ids = [];
  for (let o = 12; o + 8 <= wav.length;) { const id = String.fromCharCode(...wav.subarray(o, o + 4)); ids.push(id); const sz = dv.getUint32(o + 4, true); o += 8 + sz + (sz % 2); }
  assert.deepEqual(ids, ['fmt ', 'bext', 'chna', 'axml', 'data']);
  const back = decodeWav(wav);
  assert.equal(back.channels.length, 4);
  assert.equal(back.bitsPerSample, 24);
  assert.ok(near(back.channels[3][50], chans[3][50], 1e-5));
  // 5.1 speaker mask
  const six = encodeWav(Array.from({ length: 6 }, () => new Float32Array(10)), 48000, { bitDepth: 24, channelMask: SPEAKER_LAYOUTS['5.1'].mask });
  assert.equal(new DataView(six.buffer).getUint32(40, true), 0x3f);
  // stereo stays plain PCM (format 1, 44-byte header)
  const st = encodeWav([new Float32Array(4), new Float32Array(4)], 44100, { bitDepth: 16, dither: false });
  assert.equal(st.length, 44 + 16);
  assert.equal(new DataView(st.buffer).getUint16(20, true), 1);
});
