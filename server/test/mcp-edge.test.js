// Regression tests for MCP tool edge cases found in QA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, ticksPerBar } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool, openSocket, waitFor } from './helpers.js';

let srv;
let user;
let client;
let call;
let pid;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'edge', password: 'edge-pass-1' });
  client = await mcpClient(srv.base, (await user.post('/api/me/token')).body.token);
  call = callTool(client);
  await call('create_project', { name: 'Edge', template: 'empty', key: 'A', scale: 'minorPentatonic', bpm: 120 });
  pid = (await user.get('/api/active')).body.projectId;
  await call('add_channel', { name: 'Keys', instrument: 'fm' });
  await call('add_channel', { name: 'Bass', instrument: 'bass808' });
  await call('add_channel', { name: 'Kick', instrument: 'kick' });
  await call('create_pattern', { name: 'Song', bars: 4 });
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const fails = (p, re) => p.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));

test('an empty rhythm is an error, not a frozen server', async () => {
  await fails(call('add_chords', { pattern: 'Song', channel: 'Keys', chords: ['Am'], style: 'rhythm', rhythm: ' | ' }), /no steps/);
  await fails(call('add_bassline', { pattern: 'Song', channel: 'Bass', chords: ['Am'], rhythm: '--------' }), /no hits/);
  assert.equal((await user.get('/api/health')).status, 200);
});

test('roman numerals in a pentatonic key use the parent minor scale', async () => {
  assert.match(await call('add_chords', { pattern: 'Song', channel: 'Keys', chords: ['i', 'VI', 'III', 'VII'] }), /Am – F – C – G/);
});

test('writing a later section keeps the earlier one (range replace)', async () => {
  await call('add_chords', { pattern: 'Song', channel: 'Keys', chords: ['Am', 'F'], stepsPerChord: 16 });
  await call('add_chords', { pattern: 'Song', channel: 'Keys', chords: ['C', 'G'], stepsPerChord: 16, start: 32 });
  const pt = (await project()).patterns.find((x) => x.name === 'Song');
  const keys = (await project()).channels.find((c) => c.name === 'Keys').id;
  const starts = [...new Set(pt.notes[keys].map((n) => n.start))].sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 384, 768, 1152]);
});

test('undo can be repeated', async () => {
  await call('update_project', { bpm: 99 });
  await call('update_project', { bpm: 101 });
  await call('undo');
  assert.equal((await project()).bpm, 99);
  await call('undo');
  assert.equal((await project()).bpm, 120);
});

test('transform double repeats every channel; shift wraps', async () => {
  await call('create_pattern', { name: 'Beat', bars: 1 });
  await call('write_drums', { pattern: 'Beat', tracks: { Kick: 'x---x---x---x---' } });
  await call('add_notes', { pattern: 'Beat', channel: 'Bass', notes: [{ note: 'A1', start: 0, length: 4 }] });
  assert.match(await call('transform_notes', { pattern: 'Beat', channel: 'Bass', action: 'double' }), /2 bars \(every channel/);
  const p = await project();
  const pt = p.patterns.find((x) => x.name === 'Beat');
  const kick = p.channels.find((c) => c.name === 'Kick').id;
  assert.equal(pt.notes[kick].length, 8);
  await call('transform_notes', { pattern: 'Beat', channel: 'Bass', action: 'shift', amount: -2 });
  const bass = p.channels.find((c) => c.name === 'Bass').id;
  const after2 = (await project()).patterns.find((x) => x.name === 'Beat').notes[bass].map((n) => n.start).sort((a, b) => a - b);
  assert.deepEqual(after2, [336, 720]); // -2 steps wrapped to the end
  await fails(call('transform_notes', { pattern: 'Beat', channel: 'Bass', action: 'transpose' }), /needs an amount/);
  await fails(call('transform_notes', { pattern: 'Beat', channel: 'Bass', action: 'transpose', amount: 100 }), /MIDI range/);
});

test('shrinking a pattern with notes past the end needs trimNotes', async () => {
  await fails(call('update_pattern', { pattern: 'Beat', bars: 1 }), /trimNotes/);
  assert.match(await call('update_pattern', { pattern: 'Beat', bars: 1, trimNotes: true }), /Deleted \d+ note/);
  const pt = (await project()).patterns.find((x) => x.name === 'Beat');
  assert.equal(pt.length, ticksPerBar(await project()));
});

test('remove_clips refuses all=true with filters; copy_bars cuts clips to the range', async () => {
  await call('place_pattern', { pattern: 'Song', startBar: 1 }); // a 4-bar clip
  await fails(call('remove_clips', { all: true, pattern: 'Song' }), /all=true/);
  const res = await call('copy_bars', { fromBar: 2, toBar: 3, toPosition: 9 });
  assert.match(res, /New clip ids: clip_/);
  const p = await project();
  const bar = ticksPerBar(p);
  const copy = p.playlist.clips.find((c) => c.start === 8 * bar);
  assert.equal(copy.length, 2 * bar);
  assert.equal(copy.offset, bar);
});

test('ops broadcast to browsers carry the ids the server used (replicas stay identical)', async () => {
  const sock = openSocket(srv.base, user.cookie);
  await sock.opened;
  sock.ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
  const snapshot = (await waitFor(() => sock.messages.find((m) => m.type === 'project'))).project;
  await call('add_automation', { target: { type: 'master', param: 'volume' }, points: [{ bar: 0, value: 0.8 }, { bar: 2, value: 0.5 }], startBar: 1 });
  await call('create_pattern', { name: 'Fresh', bars: 1 });
  await call('update_track', { track: 30, name: 'Far away' });
  const broadcasts = await waitFor(() => {
    const ops = sock.messages.filter((m) => m.type === 'ops');
    return ops.length >= 3 && ops;
  });
  let replica = snapshot;
  for (const m of broadcasts) replica = applyOps(replica, m.ops);
  const server = await project();
  const strip = (p) => JSON.stringify({ ...p, rev: 0, updatedAt: 0, createdAt: 0, ownerId: 0 });
  assert.equal(strip(replica), strip(server));
  sock.ws.close();
});

test('update_automation bars resizes its full-length clips; points beyond the clip are rejected', async () => {
  await fails(call('add_automation', { target: { type: 'master', param: 'pan' }, points: [{ bar: 6, value: 1 }], startBar: 1, bars: 4 }), /beyond the clip length/);
  const p0 = await project();
  const a = p0.automations[0];
  await call('update_automation', { automation: a.id, bars: 4 });
  const p = await project();
  const clip = p.playlist.clips.find((c) => c.refId === a.id);
  assert.equal(clip.length, 4 * ticksPerBar(p));
});

test('create_project validates before creating anything', async () => {
  const before = (await user.get('/api/projects')).body.length;
  await fails(call('create_project', { name: 'Bad', key: 'A minor' }), /Invalid key/);
  await fails(call('create_project', { name: 'Bad', timeSignature: '4/0' }), /Time signature/);
  assert.equal((await user.get('/api/projects')).body.length, before);
  await call('create_project', { name: 'Trap in F#', template: 'trap', key: 'F#' });
  const id = (await user.get('/api/active')).body.projectId;
  const p = (await user.get(`/api/projects/${id}`)).body;
  assert.equal(p.key, 'F#');
  // melodic parts moved from C to F# (nearest: down 6 semitones), drums untouched
  const pad = p.channels.find((c) => c.instrument.kind === 'synth');
  const kick = p.channels.find((c) => c.instrument.kind === 'kick');
  const notesOf = (cid) => p.patterns.flatMap((pt) => pt.notes[cid] || []);
  assert.ok(notesOf(pad.id).some((n) => [6, 1, 9].includes(n.key % 12)), 'pad notes are in F#');
  assert.ok(notesOf(kick.id).every((n) => n.key === kick.rootKey));
});

test('effect params out of range are rejected; duplicate sends too', async () => {
  await fails(call('add_effect', { insert: 1, type: 'reverb', params: { mix: 5 } }), /between 0 and 1/);
  await fails(call('set_mixer', { insert: 2, sends: [{ to: 4, amount: 0.5 }, { to: 4, amount: 0.3 }] }), /only once/);
  await fails(call('add_channel', { name: 'Nowhere', instrument: 'synth', mixerTrack: 60 }), /does not exist/);
});

test('round 2: transforms stay inside the loop; 64-bar cap; slash chords keep their bass', async () => {
  await call('open_project', { projectId: pid }); // an earlier test made another project active
  await call('create_pattern', { name: 'Loop1', bars: 1 });
  await call('add_notes', { pattern: 'Loop1', channel: 'Bass', notes: [{ note: 'C2', start: 0, length: 4 }, { note: 'G2', start: 8, length: 4 }] });
  await call('transform_notes', { pattern: 'Loop1', channel: 'Bass', action: 'shift', amount: -2 });
  await call('add_notes', { pattern: 'Loop1', channel: 'Keys', notes: [{ note: 'C4', start: 15, length: 1 }] });
  await call('transform_notes', { pattern: 'Loop1', channel: 'Keys', action: 'quantize', amount: 4 });
  assert.match(await call('get_pattern', { pattern: 'Loop1' }), /16 steps \(1 bars\)/);
  await fails(call('add_notes', { pattern: 'Loop1', channel: 'Keys', notes: [{ note: 'C4', start: 2000 }] }), /at most 64 bars/);
  await call('create_pattern', { name: 'Slash', bars: 4 });
  await call('add_chords', { pattern: 'Slash', channel: 'Keys', chords: ['Am', 'C/G', 'F/A', 'G/B'] });
  const p = await project();
  const pt = p.patterns.find((x) => x.name === 'Slash');
  const keys = p.channels.find((c) => c.name === 'Keys').id;
  const bar = ticksPerBar(p);
  for (const [i, pc] of [[1, 7], [2, 9], [3, 11]]) {
    const chord = pt.notes[keys].filter((n) => n.start === i * bar).map((n) => n.key).sort((a, b) => a - b);
    assert.equal(chord[0] % 12, pc, `bar ${i + 1} bass`);
    assert.equal(new Set(chord).size, chord.length, `bar ${i + 1} has no duplicate notes`);
  }
});

test('round 2: validation and naming', async () => {
  await fails(call('update_channel', { channel: 'Keys', params: { ratio: 99999 } }), /between/);
  const res = await call('add_channel', { name: 'Kick', instrument: 'kick' });
  assert.match(res, /"Kick 2"/);
  await fails(call('update_channel', { channel: 'Kick 2', name: 'kick' }), /already exists/);
  const auto = await call('add_automation', { target: { type: 'channel', channel: 'Keys', param: 'filterCutoff' }, points: [{ bar: 0, value: 0.2 }, { bar: 1, value: 0.9 }], startBar: 1 });
  const name = auto.match(/automation "([^"]+)"/)[1];
  assert.match(await call('update_automation', { automation: name, name: 'Sweep' }), /Sweep/);
  await fails(call('set_mixer', { insert: 0, output: 3 }), /master/);
  await fails(call('remove_clips', { fromBar: 5, toBar: 2 }), /toBar/);
  await fails(call('create_project', { name: 'Waltz trap', template: 'trap', timeSignature: '3/4' }), /4\/4/);
  assert.match(await call('music_theory', { action: 'progression', progression: 'i iv vii°', key: 'A', scale: 'minor' }), /G#dim/);
});

test('round 2: project/replace without ids replicates identically', async () => {
  const sock = openSocket(srv.base, user.cookie);
  await sock.opened;
  sock.ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
  const snapshot = (await waitFor(() => sock.messages.find((m) => m.type === 'project'))).project;
  const bare = { name: 'Bare', bpm: 100, channels: [{ name: 'K', instrument: { kind: 'kick' } }], patterns: [{ name: 'P', notes: {} }], playlist: { tracks: [{ name: 'T' }], clips: [] }, mixer: [{ name: 'Master' }, { name: 'One' }] };
  assert.equal((await user.post(`/api/projects/${pid}/ops`, { ops: [{ type: 'project/replace', project: bare }] })).status, 200);
  const msg = await waitFor(() => sock.messages.find((m) => m.type === 'ops' && m.ops[0].type === 'project/replace'));
  const replica = applyOps(snapshot, msg.ops);
  const server = await project();
  const strip = (x) => JSON.stringify({ ...x, rev: 0, updatedAt: 0, createdAt: 0, ownerId: 0 });
  assert.equal(strip(replica), strip(server));
  sock.ws.close();
});
