import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { analyzeAudio, decodeWav } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool, openSocket, waitFor, makeWav } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let srv;
let user;
let token;
let client;
let call;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'producer', password: 'producer-pass' });
  token = (await user.post('/api/me/token')).body.token;
  client = await mcpClient(srv.base, token);
  call = callTool(client);
});
after(async () => {
  await client.close();
  await srv.close();
});

test('lists 70+ tools, prompts and resources', async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 70, `tools: ${tools.length}`);
  for (const t of tools) assert.ok(t.description && t.description.length > 15, `${t.name} has a description`);
  const names = new Set(tools.map((t) => t.name));
  for (const n of ['render_mix', 'get_sample_info', 'save_version', 'undo', 'music_theory', 'add_roll', 'update_notes', 'copy_bars', 'list_export_formats', 'export_audio', 'set_spatial', 'place_object', 'move_object', 'export_spatial']) assert.ok(names.has(n), n);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['make_beat', 'mix_review', 'spatial_mix', 'use_my_samples']);
  const res = await client.readResource({ uri: 'greanteadawy://guide' });
  assert.match(res.contents[0].text, /GreanTeaDawy/);
});

test('build a full track with the tools, live in a connected browser', async () => {
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  sock.ws.send(JSON.stringify({ type: 'hello', clientId: 'browser-1' }));
  await call('create_project', { name: 'Claude Beat', bpm: 142, template: 'empty', key: 'F', scale: 'minor' });
  const pid = (await user.get('/api/active')).body.projectId;
  await waitFor(() => sock.messages.find((m) => m.type === 'open' && m.projectId === pid));
  sock.ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
  await waitFor(() => sock.messages.find((m) => m.type === 'project'));

  await call('add_channel', { name: 'Kick', instrument: 'kick', preset: 'Deep' });
  await call('add_channel', { name: 'Clap', instrument: 'clap' });
  await call('add_channel', { name: 'Hat', instrument: 'hat', chokeGroup: 1 });
  await call('add_channel', { name: '808', instrument: 'bass808', params: { decay: 1.5 } });
  await call('add_channel', { name: 'Keys', instrument: 'fm', preset: 'E-Piano' });
  await call('add_channel', { name: 'Lead', instrument: 'synth', preset: 'Pluck' });
  await call('create_pattern', { name: 'Drums' });
  await call('write_drums', { pattern: 'Drums', tracks: { Kick: 'x-----x---x----- x-----x-x-----x-', Clap: '--------X------- --------X-------', Hat: 'x-x-x-x-x-x-x-x- x-x-x-x-x-x-----' } });
  assert.match(await call('add_roll', { pattern: 'Drums', channel: 'Hat', start: 28, length: 4, rate: '1/32', pitchRamp: 5 }), /8-hit/);
  await call('create_pattern', { name: 'Chords', bars: 4 });
  assert.match(await call('add_chords', { pattern: 'Chords', channel: 'Keys', chords: ['i', 'VI', 'III', 'VII'], style: 'rhythm', rhythm: 'x--x--x-' }), /Fm – Db – Ab – Eb/);
  await call('add_bassline', { pattern: 'Chords', channel: '808', chords: ['Fm', 'Db', 'Ab', 'Eb'], octave: 1, rhythm: 'x-----x---x-----' });
  await call('write_melody', { pattern: 'Chords', channel: 'Lead', melody: 'C6:2 Ab5:2 F5:4 -:4 Eb5:2 F5:2 Ab5:8' });
  await call('add_notes', { pattern: 'Chords', channel: 'Lead', notes: [{ note: 'C6', start: 32, length: 4, velocity: 100, pan: -0.3 }] });
  await call('copy_notes', { fromPattern: 'Chords', fromChannel: 'Lead', toChannel: 'Keys', transpose: -12 });
  await call('transform_notes', { pattern: 'Chords', channel: 'Lead', action: 'humanize', amount: 0.3 });
  await call('transform_notes', { pattern: 'Chords', channel: 'Keys', action: 'strum', amount: 0.25 });
  const pat = await call('get_pattern', { pattern: 'Chords', channel: 'Lead' });
  const ids = [...pat.matchAll(/\b(n_[a-z0-9]+)\b/g)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `ids ${ids.length}`);
  await call('update_notes', { pattern: 'Chords', channel: 'Lead', notes: [{ id: ids[0], note: 'D6', velocity: 1 }] });
  assert.match(await call('get_pattern', { pattern: 'Chords', channel: 'Lead' }), /D6/);
  assert.match(await call('delete_notes', { pattern: 'Chords', channel: 'Lead', ids: [ids[1]] }), /Deleted 1/);
  await call('clone_channel', { channel: 'Clap', name: 'Clap Layer', withNotes: true });
  await call('move_channel', { channel: 'Clap Layer', position: 0 });
  const arr = await call('arrange_song', { sections: [{ name: 'Intro', bars: 4, patterns: ['Chords'] }, { name: 'Hook', bars: 8, patterns: ['Drums', 'Chords'] }] });
  assert.match(arr, /12 bars total/);
  assert.match(await call('copy_bars', { fromBar: 5, toBar: 12, toPosition: 13 }), /Copied bars 5–12 \(2 clip/);
  await call('update_track', { track: 1, name: 'Music', color: '#46c79a' });
  const before = await user.get(`/api/projects/${pid}`);
  const clip = before.body.playlist.clips.find((c) => c.start === 0);
  await call('update_clips', { clips: [{ clipId: clip.id, track: 5, offsetBars: 1, bars: 3 }] });
  await call('add_effect', { insert: 5, type: 'reverb', params: { mix: 0.3 } });
  await call('add_effect', { insert: 5, type: 'eq', params: { lowMid: 0 } }).then(() => assert.fail('bad param accepted'), (e) => assert.match(e.message, /Unknown param/));
  await call('add_effect', { insert: 5, type: 'eq', params: { mid: -3 } });
  await call('move_effect', { insert: 5, effectId: 'eq', position: 0 });
  await call('add_effect', { insert: 0, type: 'compressor' });
  await call('set_mixer', { insert: 4, volumeDb: -3, pan: 0.1 });
  await call('add_automation', { name: 'Intro sweep', target: { type: 'channel', channel: 'Keys', param: 'filterCutoff' }, points: [{ bar: 0, value: 0.3 }, { bar: 4, value: 1 }], startBar: 1 });
  await call('update_automation', { automation: 'Intro sweep', points: [{ bar: 0, value: 0.2 }, { bar: 4, value: 1 }] });
  await call('update_project', { swing: 20 });
  const summary = await call('get_project', {});
  assert.match(summary, /Claude Beat/);
  assert.match(summary, /Intro sweep/);
  const p = (await user.get(`/api/projects/${pid}`)).body;
  assert.equal(p.mixer[0].effects.at(-1).type, 'limiter', 'master limiter stays last');
  assert.equal(p.mixer[5].effects[0].type, 'eq');
  assert.equal(p.channels[0].name, 'Clap Layer');
  assert.ok(Math.abs(p.mixer[4].volume - 0.708) < 0.01);
  // live ops reached the browser socket
  await waitFor(() => sock.messages.filter((m) => m.type === 'ops' && m.source === 'mcp').length > 20);
  // errors are reported as tool errors, not protocol errors
  const err = await client.callTool({ name: 'write_drums', arguments: { pattern: 'Nope', tracks: { Kick: 'x' } } });
  assert.ok(err.isError);
  assert.match(err.content[0].text, /not found/);
  await call('remove_automation', { automation: 'Intro sweep' });
  sock.ws.close();
});

test('versions and undo', async () => {
  const v = await call('save_version', { name: 'before experiment' });
  const vid = /\[(ver_[a-z0-9]+)\]/.exec(v)[1];
  await call('update_project', { bpm: 90 });
  assert.match(await call('undo', {}), /Undid/);
  assert.match(await call('get_project', { includeNotes: false }), /142 BPM/);
  await call('update_project', { bpm: 100 });
  // a user edit after Claude's change blocks undo unless forced
  const pid = (await user.get('/api/active')).body.projectId;
  await user.post(`/api/projects/${pid}/ops`, { ops: [{ type: 'project/update', patch: { swing: 0.1 } }] });
  await call('undo', {}).then(() => assert.fail('should refuse'), (e) => assert.match(e.message, /edited after/));
  await call('restore_version', { versionId: vid });
  assert.match(await call('get_project', { includeNotes: false }), /142 BPM/);
  assert.match(await call('list_versions', {}), /before experiment/);
});

test('music theory helper', async () => {
  assert.match(await call('music_theory', { action: 'progression', progression: 'i-VI-III-VII', key: 'A', scale: 'minor' }), /Am – F – C – G/);
  assert.match(await call('music_theory', { action: 'diatonic_chords', key: 'C', scale: 'major' }), /vii°\s+Bdim/);
  assert.match(await call('music_theory', { action: 'chord', chord: 'Cmaj7' }), /C4 E4 G4 B4/);
  assert.match(await call('music_theory', { action: 'scale', key: 'A', scale: 'minorPentatonic', octave: 3 }), /A3 C4 D4 E4 G4/);
});

test('sample metadata, analysis and sampler root key', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([makeWav(0.6, { freq: 220, sr: 44100 })], { type: 'audio/wav' }), 'Bell A3.wav');
  const up = await user.post('/api/samples', fd);
  assert.equal(up.status, 201);
  assert.equal(up.body.metadata.sampleRate, 44100);
  assert.equal(up.body.metadata.bitsPerSample, 16);
  assert.equal(up.body.metadata.channels, 1);
  assert.ok(up.body.metadata.bitrateKbps > 600);
  assert.equal(up.body.analysis.pitch.note, 'A3');
  const list = await call('list_samples', {});
  assert.match(list, /Bell A3 .*44\.1 kHz, 16-bit, 706 kbps, mono/);
  const info = await call('get_sample_info', { sampleId: up.body.id });
  assert.match(info, /"bitrateKbps": 706/);
  assert.match(info, /Pitch ≈ A3/);
  const added = await call('add_channel', { name: 'Bell', instrument: 'sampler', sampleId: up.body.id });
  assert.match(added, /Root key set to the detected pitch A3/);
  // browser-provided analysis for formats the server can't decode
  const patched = await user.patch(`/api/samples/${up.body.id}`, { analysis: { kind: 'loop', character: 'test', lufs: -12 } });
  assert.equal(patched.body.analysis.analyzedBy, 'browser');
  assert.equal((await user.patch(`/api/samples/${up.body.id}`, { analysis: 'x'.repeat(10) })).status, 400);
  await call('rename_sample', { sampleId: up.body.id, name: 'Bell' });
  assert.match(await call('add_audio_clip', { sampleId: up.body.id, startBar: 2, repeat: 2 }), /Placed sample "Bell"/);
});

test('sample folders, search, move, replace and usage-aware delete', async () => {
  const upload = async (name, extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([makeWav(0.3, { freq: 330, sr: 22050 })], { type: 'audio/wav' }), `${name}.wav`);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await user.post('/api/samples', fd);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  // folders over REST: unique names (case-insensitive), "Unfiled" reserved, uploads straight into a folder
  const drums = (await user.post('/api/samples/folders', { name: '  Drums ' })).body;
  assert.equal(drums.name, 'Drums');
  assert.equal((await user.post('/api/samples/folders', { name: 'drums' })).status, 409);
  assert.equal((await user.post('/api/samples/folders', { name: 'Unfiled' })).status, 400);
  assert.equal((await user.post('/api/samples/folders', { name: '' })).status, 400);
  assert.equal((await user.post('/api/samples/folders', { name: 'x'.repeat(41) })).status, 400);
  const kick = await upload('Kick Dark', { folderId: drums.id });
  assert.equal(kick.folderId, drums.id);
  assert.equal(kick.rev, 1);
  const vox = await upload('Vox Hook');
  assert.equal(vox.folderId, null);
  const fd = new FormData();
  fd.append('file', new Blob([makeWav(0.1)], { type: 'audio/wav' }), 'x.wav');
  fd.append('folderId', 'fld_nope');
  assert.equal((await user.post('/api/samples', fd)).status, 404);
  assert.equal((await user.get('/api/samples/folders')).body.find((f) => f.id === drums.id).count, 1);
  // Claude: search, folder filter, create via move, rename, list
  const list = await call('list_samples', { query: 'kick dark' });
  assert.match(list, /## Drums \[fld_/);
  assert.match(list, /Kick Dark/);
  assert.doesNotMatch(list, /Vox Hook/);
  assert.match(await call('list_samples', { folder: 'unfiled' }), /Vox Hook/);
  assert.doesNotMatch(await call('list_samples', { folder: 'unfiled' }), /Kick Dark/);
  assert.match(await call('list_samples', { query: 'nothing-like-this' }), /No samples match/);
  await assert.rejects(call('list_samples', { folder: 'Nope' }), /No folder "Nope"/);
  assert.match(await call('move_samples', { sampleIds: [vox.id], folder: 'Vocals' }), /Moved 1 sample to "Vocals" \[fld_\w+\] \(new folder\)/);
  assert.match(await call('sample_folders', { action: 'rename', folder: 'vocals', newName: 'Vox' }), /Renamed folder "Vocals" to "Vox"/);
  assert.match(await call('sample_folders', {}), /Drums \[fld_\w+\] — 1 sample\nVox \[fld_\w+\] — 1 sample/);
  assert.match(await call('get_sample_info', { sampleId: vox.id }), /Folder: Vox/);
  await assert.rejects(call('move_samples', { sampleIds: [vox.id, 'smp_nope'], folder: 'Drums' }), /not found/);
  assert.equal((await user.get(`/api/samples/${vox.id}`)).body.folderId !== drums.id, true); // nothing moved
  // deleting a folder keeps its samples
  const voxFolder = (await user.get('/api/samples/folders')).body.find((f) => f.name === 'Vox');
  assert.match(await call('sample_folders', { action: 'delete', folder: 'Vox' }), /its 1 sample is now unfiled/);
  assert.equal((await user.get(`/api/samples/${vox.id}`)).body.folderId, null);
  assert.equal((await user.patch(`/api/samples/${vox.id}`, { folderId: voxFolder.id })).status, 404);
  // another user can't see or use the folders
  const other = agent(srv.base);
  await user.post('/api/admin/users', { username: 'folderbob', password: 'folderbob-pass' });
  await other.post('/api/auth/login', { username: 'folderbob', password: 'folderbob-pass' });
  assert.deepEqual((await other.get('/api/samples/folders')).body, []);
  assert.equal((await other.patch(`/api/samples/folders/${drums.id}`, { name: 'Mine' })).status, 404);
  assert.equal((await other.post('/api/samples/move', { ids: [kick.id], folderId: null })).status, 404);
  assert.equal((await other.post('/api/samples/usage', { ids: [kick.id] })).status, 404);
  // replace the audio: same id, rev goes up, file served fresh
  const before = await (await fetch(`${srv.base}/api/samples/${kick.id}/file`, { headers: { cookie: user.cookie } })).arrayBuffer();
  const rep = new FormData();
  rep.append('file', new Blob([makeWav(0.8, { freq: 440, sr: 44100 })], { type: 'audio/wav' }), 'edited.wav');
  const replaced = await user.put(`/api/samples/${kick.id}/file`, rep);
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.rev, 2);
  assert.equal(replaced.body.name, 'Kick Dark');
  assert.equal(replaced.body.folderId, drums.id);
  assert.ok(Math.abs(replaced.body.duration - 0.8) < 0.01);
  const after2 = await (await fetch(`${srv.base}/api/samples/${kick.id}/file?v=2`, { headers: { cookie: user.cookie } })).arrayBuffer();
  assert.ok(after2.byteLength > before.byteLength);
  assert.equal((await other.put(`/api/samples/${kick.id}/file`, rep)).status, 404);
  // usage: a sampler channel and an audio clip; delete reports what goes silent
  await call('add_channel', { name: 'Kicker', instrument: 'sampler', sampleId: kick.id });
  await call('add_audio_clip', { sampleId: kick.id, startBar: 1, repeat: 2 });
  const usage = (await user.post('/api/samples/usage', { ids: [kick.id, vox.id] })).body;
  assert.equal(usage[kick.id].length, 1);
  assert.deepEqual(usage[kick.id][0].channels, ['Kicker']);
  assert.equal(usage[kick.id][0].clips, 2);
  assert.deepEqual(usage[vox.id], []);
  const del = await call('delete_sample', { sampleIds: [kick.id, vox.id] });
  assert.match(del, /Deleted "Kick Dark" \[smp_\w+\], "Vox Hook"/);
  assert.match(del, /Now silent: "Kick Dark" was used in 1 project \(.*channel Kicker, 2 clips\)/);
  assert.equal((await user.get(`/api/samples/${kick.id}`)).status, 404);
  assert.equal((await user.post('/api/samples/delete', { ids: [] })).status, 400);
  assert.equal((await user.get('/api/samples/folders')).body.find((f) => f.id === drums.id).count, 0);
});

test('sample library: replacements and uploads must hold audio, names are cleaned, checks come before changes', async () => {
  const up = async (buf, name = 'x.wav', extra = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), name);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return user.post('/api/samples', fd);
  };
  const put = async (id, buf, name = 'edit.wav') => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), name);
    return user.put(`/api/samples/${id}/file`, fd);
  };
  const orig = (await up(makeWav(0.4), 'Keep Me.wav')).body;
  const before = Buffer.from(await (await fetch(`${srv.base}/api/samples/${orig.id}/file?v=1`, { headers: { cookie: user.cookie } })).arrayBuffer());
  const emptyWav = makeWav(0.4).subarray(0, 44);
  emptyWav.writeUInt32LE(0, 40);
  for (const [buf, re] of [[Buffer.alloc(0), /empty/], [Buffer.from('this is not a wav file!!'), /Not a usable WAV/], [emptyWav, /no audio|Not a usable/]]) {
    const r = await put(orig.id, buf);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, re);
  }
  assert.equal((await up(Buffer.alloc(0))).status, 400);
  // text dressed up as compressed audio
  for (const name of ['t.mp3', 't.ogg', 't.flac']) assert.equal((await put(orig.id, Buffer.from('definitely not audio, just words'), name)).status, 400, name);
  // a replacement that loses the race against a delete leaves no file behind (same extension: same file name)
  const victim = (await up(makeWav(0.3), 'victim.wav')).body;
  const racing = srv.samples.replaceFile(victim.id, (await user.get('/api/me')).body.user.id, { buffer: makeWav(3), originalName: 'x.wav', mime: 'audio/wav' });
  assert.equal((await user.del(`/api/samples/${victim.id}`)).status, 200);
  await assert.rejects(racing, /not found/);
  const files = await (await import('node:fs/promises')).readdir(path.join(srv.dataDir, 'samples'));
  assert.ok(!files.some((f) => f.startsWith(victim.id)), files.join(','));
  const after = await fetch(`${srv.base}/api/samples/${orig.id}/file?v=1`, { headers: { cookie: user.cookie } });
  assert.deepEqual(Buffer.from(await after.arrayBuffer()), before);
  assert.equal(after.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal((await fetch(`${srv.base}/api/samples/${orig.id}/file`, { headers: { cookie: user.cookie } })).headers.get('cache-control'), 'private, no-cache');
  assert.equal((await user.get(`/api/samples/${orig.id}`)).body.rev, 1);
  // stale browser analysis after a replacement; a failing PATCH changes nothing
  assert.equal((await put(orig.id, makeWav(0.7))).body.rev, 2);
  assert.equal((await user.patch(`/api/samples/${orig.id}`, { analysis: { kind: 'loop' }, duration: 0.4, rev: 1 })).status, 409);
  assert.equal((await user.patch(`/api/samples/${orig.id}`, { name: 'Renamed?', analysis: { x: 'y'.repeat(70000) } })).status, 413);
  const now = (await user.get(`/api/samples/${orig.id}`)).body;
  assert.equal(now.name, 'Keep Me');
  assert.ok(Math.abs(now.duration - 0.7) < 0.01);
  // names: control and invisible characters go, NFC/NFD duplicates are the same folder, "Unfiled" stays reserved
  const named = (await up(makeWav(0.1), 'n.wav', { name: 'line1\nline2 [smp_fake]\u0007' })).body;
  assert.equal(named.name, 'line1 line2 [smp_fake]');
  assert.equal((await user.patch(`/api/samples/${named.id}`, { name: '\u200b\u202e' })).status, 400);
  // zero-width joiners stay (emoji families, Persian), and a family emoji counts as one character
  assert.equal((await user.patch(`/api/samples/${named.id}`, { name: 'می\u200cخواهم 👨\u200d👩\u200d👧' })).body.name, 'می\u200cخواهم 👨\u200d👩\u200d👧');
  assert.equal((await user.post('/api/samples/folders', { name: '🇫🇷'.repeat(40) })).status, 201);
  assert.equal((await user.post('/api/samples/folders', { name: '\u200bUnfiled' })).status, 400);
  assert.equal((await user.post('/api/samples/folders', { name: '\u200b\u202e' })).status, 400);
  assert.equal((await user.post('/api/samples/folders', { name: 'Caf\u00e9' })).status, 201);
  assert.equal((await user.post('/api/samples/folders', { name: 'Cafe\u0301' })).status, 409);
  assert.equal((await user.post('/api/samples/folders', { name: '🥁'.repeat(40) })).status, 201);
  // nothing visible is not a name (lone joiners, a blank braille cell, bare marks); joiners don't make a new name
  for (const bad of ['\u200d', '\u200c\u200d', '\u2800', '\u0301', '\ufe0f']) {
    assert.equal((await user.post('/api/samples/folders', { name: bad })).status, 400, JSON.stringify(bad));
    assert.equal((await user.patch(`/api/samples/${named.id}`, { name: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await user.post('/api/samples/folders', { name: '\u200dUnfiled' })).status, 400);
  assert.equal((await user.post('/api/samples/folders', { name: 'Pads' })).status, 201);
  assert.equal((await user.post('/api/samples/folders', { name: 'Pa\u200dds' })).status, 409);
  // combining marks can't bloat a name (the index is one file for everyone)
  const bloated = (await user.patch(`/api/samples/${named.id}`, { name: ('e' + '\u0301'.repeat(5000)).repeat(80) })).body.name;
  assert.ok(bloated.length <= 640, String(bloated.length));
  assert.equal((await user.post('/api/samples/folders', { name: '👨\u200d👩\u200d👧\u200d👦'.repeat(40) })).status, 400);
  // a folder id that doesn't exist (any more) is an error, not the name of a new folder; replies name the folder found
  const before2 = (await user.get('/api/samples/folders')).body.length;
  await assert.rejects(call('move_samples', { sampleIds: [orig.id], folder: 'fld_0123456789' }), /No folder "fld_0123456789"/);
  assert.equal((await user.get('/api/samples/folders')).body.length, before2);
  assert.match(await call('list_samples', { folder: '  cafe\u0301 ', query: 'zzzz' }), /No samples match "zzzz" in "Café"/);
  // audio with no frames is refused also when it doesn't state a length; a streamed FLAC with frames is fine
  const flac = (frame) => {
    const si = Buffer.alloc(38);
    si[0] = 0x80; si.writeUIntBE(34, 1, 3); si.writeUInt16BE(4096, 4); si.writeUInt16BE(4096, 6);
    si[14] = (44100 >> 12) & 0xff; si[15] = (44100 >> 4) & 0xff; si[16] = ((44100 & 0xf) << 4) | 0; si[17] = 0xf0; // 16-bit mono, 0 samples (= unknown)
    // a frame header (fixed blocksize 4096, 44.1 kHz, mono, 16-bit, frame 0) with its CRC-8, then some frame data
    const head = [0xff, 0xf8, 0xc9, 0x08, 0x00];
    let crc = 0;
    for (const b of head) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff; }
    return Buffer.concat([Buffer.from('fLaC'), si, frame ? Buffer.from([...head, crc, ...new Array(16).fill(0)]) : Buffer.alloc(0)]);
  };
  assert.equal((await put(orig.id, flac(false), 'z.flac')).status, 400);
  const junk = flac(true);
  junk[junk.length - 17] ^= 0x55; // the frame header's CRC no longer matches
  assert.equal((await put(orig.id, junk, 'junk.flac')).status, 400);
  assert.equal((await up(flac(true), 'streamed.flac')).status, 201);
  // MP3: a frame needs a frame (or the end, or a tag) after it — random bytes with a frame-like header don't count; a
  // tiny real MP3 of two frames with no stated length does
  const frame = () => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; f[3] = 0x64; return f; }; // MPEG-1 L3 128 kbps 44.1 kHz
  assert.equal((await up(Buffer.concat([frame(), frame()]), 'tiny.mp3')).status, 201);
  const junkMp3 = Buffer.concat([frame(), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 131 + 7) & 0x7f))]);
  assert.equal((await up(junkMp3, 'junk.mp3')).status, 400);
  // a false sync in front of the real frames (a file cut mid-frame) is skipped, not fatal
  const falseSync = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(96), frame(), frame(), frame()]);
  assert.equal((await up(falseSync, 'cut.mp3')).status, 201);
  // a µ-law WAV whose "fact" chunk claims a length its data chunk doesn't have
  const mulaw = Buffer.alloc(12 + 26 + 12 + 8);
  mulaw.write('RIFF', 0); mulaw.writeUInt32LE(mulaw.length - 8, 4); mulaw.write('WAVE', 8);
  mulaw.write('fmt ', 12); mulaw.writeUInt32LE(18, 16); mulaw.writeUInt16LE(7, 20); mulaw.writeUInt16LE(1, 22); mulaw.writeUInt32LE(8000, 24); mulaw.writeUInt32LE(8000, 28); mulaw.writeUInt16LE(1, 32); mulaw.writeUInt16LE(8, 34);
  mulaw.write('fact', 38); mulaw.writeUInt32LE(4, 42); mulaw.writeUInt32LE(44100, 46);
  mulaw.write('data', 50); mulaw.writeUInt32LE(0, 54);
  assert.equal((await put(orig.id, mulaw, 'm.wav')).status, 400);
  // a replacement with another file type racing a delete leaves no file behind either
  const victim2 = (await up(makeWav(0.3), 'victim2.wav')).body;
  const me = (await user.get('/api/me')).body.user.id;
  const outcome = srv.samples.replaceFile(victim2.id, me, { buffer: flac(true), originalName: 'x.flac', mime: 'audio/flac' }).then(() => null, (e) => e);
  await new Promise((r) => setImmediate(r)); // the new file is being checked
  await srv.samples.remove(victim2.id, me);
  const err = await outcome;
  assert.ok(!err || /not found/.test(err.message), String(err));
  const left = await (await import('node:fs/promises')).readdir(path.join(srv.dataDir, 'samples'));
  assert.ok(!left.some((f) => f.startsWith(victim2.id)), left.join(','));
  // a real folder called "None" wins over the "unfiled" alias; a bad id creates no folder
  await user.post('/api/samples/folders', { name: 'None' });
  assert.match(await call('move_samples', { sampleIds: [orig.id], folder: 'none' }), /to "None" \[fld_/);
  const folders = (await user.get('/api/samples/folders')).body.length;
  await assert.rejects(call('move_samples', { sampleIds: [orig.id, 'smp_typo'], folder: 'Typo Folder' }), /not found/);
  assert.equal((await user.get('/api/samples/folders')).body.length, folders);
  await assert.rejects(call('edit_sample', { sampleId: orig.id, ops: [{ op: 'delete' }] }), /leave the sample empty/);
  await assert.rejects(call('edit_sample', { sampleId: orig.id, ops: [{ op: 'pitch_correct', scale: 'constructor' }] }), /Unknown scale/);
  await assert.rejects(call('edit_sample', { sampleId: orig.id, ops: [{ op: 'pitch_correct', key: '' }] }), /Invalid key/);
  // a folder deleted while a sample is uploaded into it: the sample ends up unfiled, and its info still works
  const doomed = (await user.post('/api/samples/folders', { name: 'Doomed' })).body;
  const fd = new FormData();
  fd.append('folderId', doomed.id);
  fd.append('file', new Blob([makeWav(1.5)], { type: 'audio/wav' }), 'late.wav');
  const [late] = await Promise.all([user.post('/api/samples', fd), new Promise((r) => setTimeout(r, 5)).then(() => user.del(`/api/samples/folders/${doomed.id}`))]);
  if (late.status === 201) {
    const info = await user.get(`/api/samples/${late.body.id}/info`);
    assert.equal(info.status, 200);
  }
});

test('render_mix runs as a browser job and returns a mix report', async () => {
  // fake browser: answers render jobs with an analysis + WAV upload
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  sock.ws.on('message', async (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type !== 'job') return;
    for (const progress of [0.3, 0.2, 0.6]) sock.ws.send(JSON.stringify({ type: 'job-progress', jobId: msg.jobId, progress }));
    await new Promise((r) => setTimeout(r, 50));
    const sr = 22050;
    const n = sr * 2;
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.4 * Math.sin((2 * Math.PI * 110 * i) / sr);
    const mix = analyzeAudio({ channels: [L, L], sampleRate: sr }, { segmentSeconds: 0.5, segmentLabel: '4 bars' });
    const fd = new FormData();
    fd.append('result', JSON.stringify({ mix, stems: [{ name: 'Kick', lufs: -12, peakDb: -3, centroidHz: 90, bandsPercent: { sub: 60, low: 30 } }] }));
    fd.append('name', 'Claude Beat');
    fd.append('file', new Blob([makeWav(0.2)], { type: 'audio/wav' }), 'mix.wav');
    await fetch(`${srv.base}/api/jobs/${msg.jobId}/result`, { method: 'POST', headers: { cookie: user.cookie }, body: fd });
  });
  const progress = [];
  const res = await client.callTool({ name: 'render_mix', arguments: { stems: true, save: true } }, undefined, { onprogress: (p) => progress.push(p.progress) });
  const report = res.content[0].text;
  // progress notifications stream back (SSE) and only ever increase
  assert.deepEqual(progress, [30, 60]);
  assert.match(report, /MIX ANALYSIS/);
  assert.match(report, /LUFS integrated/);
  assert.match(report, /Kick/);
  assert.match(report, /Saved WAV: .*\/api\/exports\/Claude_Beat-/);
  const exports = await user.get('/api/exports');
  assert.equal(exports.body.length, 1);
  const wav = await fetch(`${srv.base}${exports.body[0].url}`, { headers: { cookie: user.cookie } });
  assert.equal(wav.status, 200);
  assert.equal(decodeWav(new Uint8Array(await wav.arrayBuffer())).sampleRate, 22050);
  sock.ws.close();
  // no browser -> clear error
  const uid = srv.users.findByUsername('producer').id;
  await waitFor(() => srv.hub.status(uid).browsers === 0);
  await call('render_mix', {}).then(() => assert.fail('should fail'), (e) => assert.match(e.message, /No studio is open/));
});

test('preview_sound and play reach the browser', async () => {
  const sock = openSocket(srv.base, user.cookie);
  await sock.opened;
  const pid = (await user.get('/api/active')).body.projectId;
  sock.ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
  await waitFor(() => sock.messages.find((m) => m.type === 'project'));
  assert.match(await call('preview_sound', { channel: 'Kick' }), /Played C4/);
  await waitFor(() => sock.messages.find((m) => m.type === 'transport' && m.action === 'audition'));
  assert.match(await call('play', { mode: 'pattern' }), /Playing/);
  assert.match(await call('export_midi', {}), /Exported MIDI/);
  sock.ws.close();
});

test('stdio bridge forwards to the server with the API token', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'src', 'mcp', 'stdio.js')],
    env: { ...process.env, GREANTEADAWY_URL: srv.base, GREANTEADAWY_TOKEN: token, DATA_DIR: srv.dataDir },
    stderr: 'pipe'
  });
  const c = new Client({ name: 'stdio-test', version: '1.0.0' });
  await c.connect(transport);
  const r = await c.callTool({ name: 'get_studio_status', arguments: {} });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[1].text, /producer/);
  const r2 = await c.callTool({ name: 'update_project', arguments: { bpm: 99 } });
  assert.ok(!r2.isError, r2.content[0].text);
  const pid = (await user.get('/api/active')).body.projectId;
  assert.equal((await user.get(`/api/projects/${pid}`)).body.bpm, 99);
  // the sample library tools work through the bridge too (remote backend)
  const f = await c.callTool({ name: 'sample_folders', arguments: { action: 'create', folder: 'Bridge' } });
  assert.match(f.content[0].text, /Created folder "Bridge"/);
  const l = await c.callTool({ name: 'sample_folders', arguments: {} });
  assert.match(l.content[0].text, /Bridge \[fld_\w+\] — 0 samples/);
  const d = await c.callTool({ name: 'sample_folders', arguments: { action: 'delete', folder: 'bridge' } });
  assert.match(d.content[0].text, /Deleted folder "Bridge"/);
  await c.close();
});
