// MCP spatial tools: set_spatial, place_object (presets, polar, x/y/z, errors), move_object (automation),
// export_spatial (browser job with files and server-written positions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { objectPositionAt } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool, openSocket, makeWav } from './helpers.js';

let srv;
let user;
let client;
let call;
let pid;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'atmos', password: 'atmos-pass-1' });
  client = await mcpClient(srv.base, (await user.post('/api/me/token')).body.token);
  call = callTool(client);
  await call('create_project', { name: 'Space', template: 'band' });
  pid = (await user.get('/api/active')).body.projectId;
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const insertOf = (p, name) => p.mixer.findIndex((m) => m.name === name);
const fails = (pr, re) => pr.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));

test('set_spatial and place_object: presets, polar, x/y/z, the bed and the errors', async () => {
  assert.match(await call('set_spatial', { monitor: 'binaural' }), /Spatial mix OFF, monitoring binaural[\s\S]*no 3D objects yet/);
  // a channel name resolves to its insert; placing turns the spatial mix on
  let out = await call('place_object', { insert: 'Strings', position: 'overhead' });
  assert.match(out, /Placed insert \d+ "Strings" at x 0, y 0, z 1/);
  assert.match(out, /Spatial mix turned on/);
  out = await call('place_object', { insert: 'Guitar', azimuth: -90, elevation: 0, distance: 0.5, lfe: 0.2 });
  assert.match(out, /"Guitar" at x -0\.5, y 0, z 0, lfe 0\.2/);
  out = await call('place_object', { insert: 'Piano', position: 'front-left', z: 0.4 });
  assert.match(out, /x -1, y 1, z 0\.4/);
  let p = await project();
  assert.deepEqual(p.spatial, { enabled: true, monitor: 'binaural' });
  assert.equal(p.mixer[insertOf(p, 'Strings')].spatial.enabled, true);
  assert.match(await call('get_project', {}), /spatial \(3D\) mix ON, monitoring binaural/);

  // back to the bed
  assert.match(await call('place_object', { insert: 'Piano', enabled: false }), /back in the stereo bed/);
  p = await project();
  assert.equal(p.mixer[insertOf(p, 'Piano')].spatial.enabled, false);

  await fails(call('place_object', { insert: 0, position: 'left' }), /master can't be a 3D object/);
  await fails(call('place_object', { insert: 'Nope', position: 'left' }), /No mixer insert or channel named "Nope"/);
  // an insert that feeds a bus can't be an object
  const bass = insertOf(p, 'Bass');
  await call('set_mixer', { insert: bass, output: insertOf(p, 'Reverb') });
  await fails(call('place_object', { insert: 'Bass', position: 'left' }), /routes into insert/);
});

test('move_object: circle, line and keyframe paths become spatialX/Y/Z automation clips', async () => {
  const out = await call('move_object', { insert: 'Strings', path: 'circle', startBar: 5, bars: 4, radius: 1, height: 0.5 });
  assert.match(out, /Moving insert \d+ "Strings" \(circle\) from bar 5 for 4 bars/);
  let p = await project();
  const i = insertOf(p, 'Strings');
  const autos = p.automations.filter((a) => a.target.type === 'mixer' && a.target.index === i);
  assert.deepEqual(autos.map((a) => a.target.param).sort(), ['spatialX', 'spatialY']); // height stays put: z is static
  assert.equal(p.mixer[i].spatial.z, 0.5);
  const bar = 384;
  // a quarter of the way through a clockwise circle that starts at the front: on the right wall
  const q = objectPositionAt(p, i, 4 * bar + bar);
  assert.ok(q.x > 0.95 && Math.abs(q.y) < 0.1, JSON.stringify(q));
  // the clips sit on separate playlist tracks, from bar 5
  const clips = p.playlist.clips.filter((c) => autos.some((a) => a.id === c.refId));
  assert.equal(new Set(clips.map((c) => c.track)).size, 2);
  assert.ok(clips.every((c) => c.start === 4 * bar && c.length === 4 * bar));

  await call('move_object', { insert: 'Guitar', path: 'points', startBar: 1, bars: 2, points: [{ bar: 0, position: 'rear-left' }, { bar: 1, x: 1, y: -1 }, { bar: 2, z: 1 }] });
  p = await project();
  const g = insertOf(p, 'Guitar');
  assert.deepEqual(objectPositionAt(p, g, 0), { enabled: true, x: -1, y: -1, z: 0, lfe: 0.2 });
  const end = objectPositionAt(p, g, 2 * bar - 1);
  assert.ok(end.x > 0.99 && end.y < -0.99 && end.z > 0.99, JSON.stringify(end));
  await fails(call('move_object', { insert: 'Guitar', path: 'points', startBar: 1, bars: 1, points: [{ bar: 0, x: 0 }, { bar: 3, x: 1 }] }), /beyond the movement/);
  await fails(call('move_object', { insert: 'Piano', path: 'rise', startBar: 1, bars: 1 }).then(() => call('move_object', { insert: 'Piano', path: 'points', startBar: 1, bars: 1, points: [{ bar: 0, x: 0.5 }, { bar: 1, x: 0.5 }] })), /does not move/);
});

test('export_spatial: browser job, object files and the positions JSON written by the server', async () => {
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  const jobs = [];
  sock.ws.on('message', async (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type !== 'job') return;
    jobs.push(msg.job);
    const post = async (url, fields) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v, ...(v instanceof Blob ? ['x.wav'] : []));
      return fetch(`${srv.base}${url}`, { method: 'POST', headers: { cookie: user.cookie }, body: fd });
    };
    const files = [];
    for (const name of ['Space-bed', 'Space-obj01-Guitar', 'Space-obj02-Strings']) {
      const r = await (await post(`/api/jobs/${msg.jobId}/files`, { name, file: new Blob([makeWav(0.1)]) })).json();
      files.push(r.export);
    }
    const positions = {
      title: 'Space', sampleRate: 48000, seconds: 2,
      objects: [{ name: 'Guitar', insert: 6, blocks: [{ start: 0, duration: 2, x: -5, y: 'x', z: 0.5 }] }, { name: 'Strings', insert: 7, blocks: [{ start: 0, duration: 2, x: 0, y: 0, z: 1 }] }]
    };
    await post(`/api/jobs/${msg.jobId}/result`, {
      name: 'Space',
      result: JSON.stringify({ format: msg.job.format, files, objects: [{ name: 'Guitar', insert: 6, moves: true }, { name: 'Strings', insert: 7, moves: false }], seconds: 2, sampleRate: 48000, bitDepth: 24, tracks: 3, positions })
    });
  });
  const out = await call('export_spatial', { format: 'objects', mode: 'pattern', pattern: 'Piano' });
  assert.equal(jobs[0].kind, 'spatial');
  assert.equal(jobs[0].format, 'objects');
  assert.match(out, /Exported Object stems \+ positions \(2s, 48 kHz \/ 24-bit\)/);
  assert.match(out, /Space-bed\.wav/);
  assert.match(out, /Space-positions\.json/);
  assert.match(out, /Objects: Guitar \(moving\), Strings/);
  const res = await user.get('/api/exports/Space-positions.json');
  assert.equal(res.status, 200);
  const doc = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
  assert.equal(doc.objects.length, 2);
  assert.deepEqual(doc.objects[0].blocks[0], { start: 0, duration: 2, x: -1, y: 0, z: 0.5 }); // clamped/cleaned by the server
  assert.match(doc.coordinates, /ADM Cartesian/);
  sock.ws.close();
});

test('export_spatial needs objects; the job kinds and files are guarded', async () => {
  await call('create_project', { name: 'Flat', template: 'trap' });
  await fails(call('export_spatial', { format: '5.1' }), /No 3D objects yet/);
  // a render job can't upload files; a spatial job can
  const r = await user.post('/api/jobs', { job: { kind: 'nope' } });
  assert.equal(r.status, 400);
});
