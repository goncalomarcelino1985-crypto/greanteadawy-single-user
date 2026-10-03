// MCP production tools added after the music-industry review: voicings, bass lines, groove, sidechain, markers,
// transitions, fills, audio clip gain/fades/repitch, mix targets, analyze_sound and stem export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, ticksPerBar, STEP, PPQ } from '@greanteadawy/core';
import { startServer, agent, mcpClient, callTool, openSocket, waitFor, makeWav } from './helpers.js';

let srv;
let user;
let client;
let call;
let pid;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'prod', password: 'prod-pass-1' });
  client = await mcpClient(srv.base, (await user.post('/api/me/token')).body.token);
  call = callTool(client);
  await call('create_project', { name: 'Prod', template: 'empty', key: 'A', scale: 'minor', bpm: 120 });
  pid = (await user.get('/api/active')).body.projectId;
  for (const [name, instrument] of [['Kick', 'kick'], ['Snare', 'snare'], ['Hat', 'hat'], ['808', 'bass808'], ['Keys', 'fm']]) {
    await call('add_channel', { name, instrument });
  }
  await call('create_pattern', { name: 'Drums', bars: 1 });
  await call('write_drums', { pattern: 'Drums', tracks: { Kick: 'x-------x-x-----', Snare: '----x-------x---', Hat: 'x-x-x-x-x-x-x-x-' } });
  await call('create_pattern', { name: 'Music', bars: 4 });
});
after(async () => {
  await client.close();
  await srv.close();
});

const project = async () => (await user.get(`/api/projects/${pid}`)).body;
const chan = (p, name) => p.channels.find((c) => c.name === name);
const pat = (p, name) => p.patterns.find((x) => x.name === name);
const fails = (pr, re) => pr.then(() => assert.fail('expected an error'), (e) => assert.match(e.message, re));

/** A fake browser tab answering jobs with `handler(msg)`. */
async function fakeBrowser(handler) {
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  sock.ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type === 'job') handler(msg).catch((e) => console.error(e));
  });
  return sock;
}
const postForm = (url, fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob) fd.append(k, v, 'x.wav');
    else fd.append(k, String(v));
  }
  return fetch(`${srv.base}${url}`, { method: 'POST', headers: { cookie: user.cookie }, body: fd });
};

test('add_chords voicings and register; add_bassline degree lines with slides', async () => {
  assert.match(await call('add_chords', { pattern: 'Music', channel: 'Keys', chords: ['Am9', 'Dm9'], voicing: 'drop2', register: 'E4' }), /drop2 voicing/);
  let p = await project();
  const keys = pat(p, 'Music').notes[chan(p, 'Keys').id];
  const first = keys.filter((n) => n.start === 0).map((n) => n.key);
  assert.equal(first.length, 5);
  assert.ok(Math.abs(first.reduce((a, b) => a + b, 0) / first.length - 64) < 7);
  await fails(call('add_chords', { pattern: 'Music', channel: 'Keys', chords: ['C'], voicing: 'stacked' }), /Invalid|voicing/i);

  assert.match(await call('add_bassline', { pattern: 'Music', channel: '808', chords: ['i', 'iv'], line: 'R:6 R:4~ 8:2 -:2 5:2' }), /bassline/);
  p = await project();
  const bass = pat(p, 'Music').notes[chan(p, '808').id];
  assert.deepEqual(bass.filter((n) => n.start < 384).map((n) => n.key), [45, 45, 57, 52]); // A2 A2 A3 E3
  assert.equal(bass.find((n) => n.start === 6 * STEP).length, 4 * STEP + STEP / 2); // slide overlaps the next note
  await fails(call('add_bassline', { pattern: 'Music', channel: '808', chords: ['Am'], line: 'R:4', rhythm: 'x---' }), /either rhythm or line/);
  await fails(call('add_bassline', { pattern: 'Music', channel: '808', chords: ['Am'], line: 'Z:4' }), /Invalid bass token/);
});

test('groove: update_channel nudge/swingMix and apply_groove presets', async () => {
  assert.match(await call('update_channel', { channel: 'Snare', nudge: 12, swingMix: 0.5 }), /nudge \+12 ms, swing ×0.5/);
  assert.match(await call('apply_groove', { preset: 'boom-bap', patterns: ['Drums'], humanize: false }), /boom-bap/);
  let p = await project();
  assert.equal(p.swing, 0.55);
  assert.equal(chan(p, 'Snare').nudge, 14);
  assert.equal(chan(p, 'Kick').swingMix, 0.7);
  const hats = () => pat(p, 'Drums').notes[chan(p, 'Hat').id];
  const v1 = hats().map((n) => n.velocity);
  assert.ok(Math.max(...v1) - Math.min(...v1) > 0.12, 'hats get accents (downbeat 8ths louder than off-beat 8ths)');
  // re-applying doesn't stack accents or drift notes further off the grid
  for (let i = 0; i < 3; i++) await call('apply_groove', { preset: 'boom-bap', patterns: ['Drums'] });
  p = await project();
  for (const n of hats()) assert.ok(Math.abs(n.start - Math.round(n.start / STEP) * STEP) <= 2, `drifted to ${n.start}`);
  const v2 = hats().map((n) => n.velocity);
  assert.ok(Math.max(...v2) <= 1 && Math.min(...v2) > 0.4, 'accents are not stacked');
  await call('apply_groove', { preset: 'dilla', patterns: ['Drums'] });
  await call('apply_groove', { preset: 'trap', patterns: ['Drums'] }); // no timing jitter: re-quantizes
  p = await project();
  for (const n of hats()) assert.equal(n.start % STEP, 0);
  await call('apply_groove', { preset: 'straight' });
  p = await project();
  assert.equal(p.swing, 0);
  assert.equal(chan(p, 'Snare').nudge, 0);
  for (const n of hats()) assert.equal(n.start % STEP, 0); // straight re-quantizes
  assert.match(await call('apply_groove', { preset: 'lo-fi', amount: 0.5, ghostNotes: true, patterns: ['Drums'] }), /ghost snares/);
  p = await project();
  assert.ok(pat(p, 'Drums').notes[chan(p, 'Snare').id].some((n) => n.velocity < 0.5)); // ghosts at 0.4 ± 0.05
});

test('bass lines and generators are bounded before any notes are generated', async () => {
  await fails(call('add_bassline', { pattern: 'Music', channel: '808', chords: ['Am'], line: 'R:0.001' }), /at least 0.5 steps/);
  await fails(call('add_bassline', { pattern: 'Music', channel: '808', chords: Array(256).fill('Am'), stepsPerChord: 1024, line: 'R:1' }), /at most 64 bars/);
  await fails(call('add_chords', { pattern: 'Music', channel: 'Keys', chords: Array(256).fill('Am'), stepsPerChord: 1024, style: 'arp-up', arpRate: 0.25 }), /at most 64 bars/);
  await fails(call('add_roll', { pattern: 'Music', channel: 'Hat', start: 0, length: 2048 }), /at most 64 bars/);
  assert.equal((await user.get('/api/health')).status, 200);
});

test('removing a sidechain trigger channel clears the pump source', async () => {
  await call('add_channel', { name: 'Ghost Kick', instrument: 'kick', volume: 0 });
  await call('add_effect', { insert: 1, type: 'pump', params: { source: 'Ghost Kick' } });
  assert.match(await call('remove_channel', { channel: 'Ghost Kick' }), /sidechain pump on insert 1: that pump now has no source/);
  const p = await project();
  assert.equal(p.mixer[1].effects.find((e) => e.type === 'pump').params.source, null);
  await call('remove_effect', { insert: 1, effectId: 'pump' });
});

test('pump sidechain source by channel name', async () => {
  assert.match(await call('add_effect', { insert: 4, type: 'pump', params: { source: 'Kick', depth: 0.6 } }), /Added pump/);
  let p = await project();
  const fx = p.mixer[4].effects.find((e) => e.type === 'pump');
  assert.equal(fx.params.source, chan(p, 'Kick').id);
  assert.match((await call('get_project', {})), /pump\[[^\]]+\]\{source:"Kick"/);
  await call('update_effect', { insert: 4, effectId: 'pump', params: { source: null } });
  p = await project();
  assert.equal(p.mixer[4].effects.find((e) => e.type === 'pump').params.source, null);
  await fails(call('update_effect', { insert: 4, effectId: 'pump', params: { source: 'Nope' } }), /Channel "Nope" not found/);
  await fails(call('update_effect', { insert: 4, effectId: 'pump', params: { depth: 3 } }), /between 0 and 1/);
});

test('markers: arrange_song names sections; set_markers adds, removes and clears', async () => {
  await call('arrange_song', { sections: [{ name: 'Intro', bars: 4, patterns: ['Music'] }, { name: 'Hook', bars: 8, patterns: ['Drums', 'Music'] }, { bars: 4, patterns: ['Drums'] }] });
  let p = await project();
  assert.deepEqual(p.markers.map((m) => [m.name, m.tick / ticksPerBar(p) + 1]), [['Intro', 1], ['Hook', 5]]);
  assert.match(await call('set_markers', { add: [{ bar: 13, name: 'Outro' }], remove: ['Intro'] }), /Hook @ bar 5 .* Outro @ bar 13/);
  assert.match(await call('get_project', {}), /MARKERS: Hook @ bar 5/);
  await fails(call('set_markers', { remove: ['Bridge'] }), /Marker "Bridge" not found/);
  await call('set_markers', { clear: true });
  p = await project();
  assert.equal(p.markers.length, 0);
  // arranging again replaces the old markers
  await call('arrange_song', { sections: [{ name: 'A', bars: 2, patterns: ['Drums'] }] });
  await call('arrange_song', { sections: [{ name: 'B', bars: 2, patterns: ['Drums'] }] });
  assert.deepEqual((await project()).markers.map((m) => m.name), ['B']);
});

test('add_transition: riser ends on the downbeat with sweeps; impact; validation', async () => {
  assert.match(await call('add_transition', { type: 'riser', atBar: 9 }), /bars 5–9/);
  let p = await project();
  const bar = ticksPerBar(p);
  const riser = chan(p, 'Riser');
  assert.ok(riser && riser.instrument.preset === 'Riser Noise');
  const rp = pat(p, 'Riser 4 bars');
  const clip = p.playlist.clips.find((c) => c.refId === rp.id);
  assert.equal(clip.start, 4 * bar);
  assert.equal(clip.length, 4 * bar);
  assert.equal(p.playlist.tracks[clip.track].name, 'Transitions');
  const autos = p.playlist.clips.filter((c) => c.kind === 'automation' && c.start === 4 * bar);
  assert.equal(autos.length, 2);
  // a second riser reuses the channel, pattern and automation
  await call('add_transition', { type: 'riser', atBar: 17 });
  p = await project();
  assert.equal(p.channels.filter((c) => c.name.startsWith('Riser')).length, 1);
  assert.equal(p.automations.length, 2);
  assert.match(await call('add_transition', { type: 'impact', atBar: 9 }), /Created channel "Crash".*channel "Sub Drop"/);
  assert.match(await call('add_transition', { type: 'snare_build', atBar: 9 }), /snare build/);
  const swell = await call('add_transition', { type: 'reverse_swell', atBar: 5, bars: 2 });
  assert.match(swell, /Swell/);
  // the swell is the tonic chord of the project's scale (A minor here; sus2/sus4 and the scale's own fifth when it
  // has no third or no perfect fifth)
  const swellKeys = async (reply) => {
    const id = reply.match(/\[(pat_[^\]]+)\]/)[1];
    const pr = await project();
    return pr.patterns.find((x) => x.id === id).notes[chan(pr, 'Swell').id].map((n) => n.key).sort((a, b) => a - b);
  };
  assert.deepEqual(await swellKeys(swell), [69, 72, 76]);
  await call('update_project', { scale: 'yo' });
  assert.deepEqual(await swellKeys(await call('add_transition', { type: 'reverse_swell', atBar: 21 })), [69, 71, 76]);
  await call('update_project', { scale: 'iwato' });
  assert.deepEqual(await swellKeys(await call('add_transition', { type: 'reverse_swell', atBar: 23 })), [69, 74, 75]);
  await call('update_project', { scale: 'minor' });
  p = await project();
  // swells are shaped by volume automation, so different lengths can share the channel
  assert.equal(chan(p, 'Swell').instrument.params.attack, 0.02);
  assert.ok(p.automations.some((a) => a.name === 'Swell 2 bars' && a.target.param === 'volume'));
  // an explicit track holds the pattern; the automation goes to a different track
  await call('add_transition', { type: 'riser', atBar: 13, bars: 2, track: 9 });
  p = await project();
  const riserClips = p.playlist.clips.filter((c) => c.start === 10 * bar);
  assert.ok(riserClips.some((c) => c.kind === 'pattern' && c.track === 8));
  assert.ok(riserClips.filter((c) => c.kind === 'automation').every((c) => c.track !== 8));
  await fails(call('add_transition', { type: 'riser', atBar: 2, bars: 4 }), /before bar 1/);
});

test('add_fill: styles, copies by default, in place on request', async () => {
  assert.match(await call('add_fill', { pattern: 'Drums', style: 'snare_roll' }), /Created "Drums Fill"/);
  let p = await project();
  const fill = pat(p, 'Drums Fill');
  const sn = fill.notes[chan(p, 'Snare').id].filter((n) => n.start >= 3 * PPQ);
  assert.ok(sn.length >= 6 && sn.at(-1).velocity > sn[0].velocity);
  assert.match(await call('add_fill', { pattern: 'Drums', style: 'tom_run', name: 'Tom Fill' }), /Created channel "Toms"/);
  assert.match(await call('add_fill', { pattern: 'Drums', style: 'dropout', name: 'Gap' }), /dropout/);
  p = await project();
  assert.ok(!pat(p, 'Gap').notes[chan(p, 'Kick').id].some((n) => n.start >= 3 * PPQ));
  const before = (await project()).patterns.length;
  await call('add_fill', { pattern: 'Drums Fill', style: 'hat_roll', inPlace: true });
  assert.equal((await project()).patterns.length, before);
  await fails(call('add_fill', { pattern: 'Drums', style: 'snare_roll', name: 'Gap' }), /already exists/);
});

test('audio clips: gain, fades, repitch to the project tempo; audio-only fields', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([makeWav(2, { freq: 220 })], { type: 'audio/wav' }), 'loop.wav');
  const up = await user.post('/api/samples', fd);
  assert.equal(up.status, 201);
  const r = await call('add_audio_clip', { sampleId: up.body.id, startBar: 1, fit: 'repitch', sampleBpm: 100, gainDb: -6, fadeInSteps: 2, fadeOutSteps: 4 });
  assert.match(r, /Repitched 100 → 120 BPM \(speed ×1.2, \+3.2 semitones\)/);
  let p = await project();
  const c = p.playlist.clips.find((x) => x.kind === 'audio');
  assert.equal(c.rate, 1.2);
  assert.ok(Math.abs(c.gain - 0.501) < 0.01);
  assert.deepEqual([c.fadeIn, c.fadeOut], [2 * STEP, 4 * STEP]);
  // 2 s of audio at 1.2× speed lasts 1.667 s = 3.33 beats at 120 BPM
  assert.equal(c.length, Math.round((2 / 1.2) * 2 * PPQ));
  await call('update_clips', { clips: [{ clipId: c.id, gainDb: 0, rate: 1 }] });
  p = await project();
  assert.deepEqual([p.playlist.clips.find((x) => x.id === c.id).gain, p.playlist.clips.find((x) => x.id === c.id).rate], [1, 1]);
  const patternClip = p.playlist.clips.find((x) => x.kind === 'pattern');
  await fails(call('update_clips', { clips: [{ clipId: patternClip.id, gainDb: -3 }] }), /only apply to audio clips/);
  await fails(call('add_audio_clip', { sampleId: up.body.id, startBar: 1, fit: 'repitch' }), /pass sampleBpm/);
  assert.match(await call('get_project', {}), /audio:smp_\w+ \(-6 dB|audio:smp_\w+ \(/);
});

test('render_mix target, true peak and limiter report; analyze_sound; export_stems', async () => {
  const sock = await fakeBrowser(async (msg) => {
    const { jobId, job } = msg;
    if (job.kind === 'render') {
      const sr = 22050;
      const n = sr * 4;
      const L = new Float32Array(n);
      for (let i = 0; i < n; i++) L[i] = 0.25 * Math.sin((2 * Math.PI * 55 * i) / sr);
      const mix = analyzeAudio({ channels: [L, L], sampleRate: sr }, { segmentSeconds: 1, segmentLabel: '4 bars' });
      const stems = [
        { name: 'Kick', lufs: -14, peakDb: -6, centroidHz: 70, bandsPercent: { sub: 70, low: 25 }, lowPeakHz: 55, lowPeakNote: 'A1' },
        { name: '808', lufs: -12, peakDb: -5, centroidHz: 60, bandsPercent: { sub: 80, low: 15 }, lowPeakHz: 56, lowPeakNote: 'A1 +31c' }
      ];
      await postForm(`/api/jobs/${jobId}/result`, { result: JSON.stringify({ mix, stems, limiter: { avgDb: -2, maxDb: -9.5, activePercent: 60 } }) });
    } else if (job.kind === 'sound') {
      assert.equal(job.through, 'insert');
      await postForm(`/api/jobs/${jobId}/result`, {
        result: JSON.stringify({
          channel: '808', key: 33, velocity: 0.8, noteSeconds: 1, through: 'insert',
          analysis: { lufs: -16, peakDb: -4, truePeakDb: -3.8, crestDb: 12, pitch: { note: 'A1', hz: 55.2, cents: 6, confidence: 0.9 }, lowPeakHz: 55, lowPeakNote: 'A1', centroidHz: 80, brightness: 'dark', tonality: 'tonal', bandsPercent: { sub: 80, low: 18, lowMid: 1, mid: 1, highMid: 0, high: 0 }, character: '808 / bass hit' },
          envelope: { attackMs: 5, decay20Ms: 400, decay40Ms: 900, decay60Ms: null }
        })
      });
    } else if (job.kind === 'export-stems') {
      // a render job can't take files
      for (const name of ['Prod-01-Kick-20260101-000000', 'Prod-02-808-20260101-000000']) {
        const r = await postForm(`/api/jobs/${jobId}/files`, { name, file: new Blob([makeWav(0.1)], { type: 'audio/wav' }) });
        assert.equal(r.status, 200);
      }
      const bad = await postForm(`/api/jobs/${jobId}/files`, { name: 'x', file: new Blob([Buffer.from('not a wav at all')]) });
      assert.equal(bad.status, 400);
      await postForm(`/api/jobs/${jobId}/result`, { result: JSON.stringify({ stems: ['Kick', '808'], bitDepth: 24, mode: 'song' }) });
    }
  });
  const report = await call('render_mix', { target: 'hip-hop', stems: true });
  assert.match(report, /true peak -?\d+(\.\d)? dBTP/);
  assert.match(report, /loudness range/);
  assert.match(report, /Master limiter: gain reduction avg -2 dB, max -9.5 dB/);
  assert.match(report, /Target modern hip-hop .*: -9 LUFS.*change the master limiter input gain by \+/);
  assert.match(report, /squashing up to 9.5 dB/);
  assert.match(report, /"Kick" \(55 Hz\) and "808" \(56 Hz\) peak at nearly the same low frequency/);
  assert.match(report, /strongest low frequency 55(\.\d)? Hz/);

  const sound = await call('analyze_sound', { channel: '808', through: 'insert' });
  assert.match(sound, /SOUND — "808"/);
  assert.match(sound, /Pitch: A1 \(55.2 Hz, \+6 cents/);
  assert.match(sound, /-60 dB after longer than the render/);

  const stems = await call('export_stems', {});
  assert.match(stems, /Exported 2 stems \(24-bit WAV/);
  assert.match(stems, /Prod-01-Kick-20260101-000000\.wav/);
  const list = (await user.get('/api/exports')).body.map((x) => x.name);
  assert.ok(list.includes('Prod-02-808-20260101-000000.wav'));
  sock.ws.close();
  await waitFor(() => srv.hub.status(srv.users.findByUsername('prod').id).browsers === 0);
});

test('POST /api/exports stores a browser-rendered WAV (stems from the File menu)', async () => {
  const ok = await postForm('/api/exports', { name: 'My Song-01-Kick', file: new Blob([makeWav(0.1)], { type: 'audio/wav' }) });
  assert.equal(ok.status, 201);
  const again = await postForm('/api/exports', { name: 'My Song-01-Kick', file: new Blob([makeWav(0.1)], { type: 'audio/wav' }) });
  assert.equal((await again.json()).export.name, 'My_Song-01-Kick-2.wav'); // never overwrites
  assert.equal((await postForm('/api/exports', { name: 'x', file: new Blob([Buffer.from('nope nope nope')]) })).status, 400);
  assert.equal((await postForm('/api/exports', { name: 'x' })).status, 400);
  const anon = await fetch(`${srv.base}/api/exports`, { method: 'POST', body: new FormData() });
  assert.equal(anon.status, 401);
});

test('job files: only export-stems jobs take them, and only from their owner', async () => {
  const other = agent(srv.base);
  await user.post('/api/admin/users', { username: 'other', password: 'other-pass-1', displayName: 'Other' });
  await other.post('/api/auth/login', { username: 'other', password: 'other-pass-1' });
  let seen = null;
  const sock = await fakeBrowser(async (msg) => {
    seen = msg.jobId;
    // a render job can't take extra files
    const wrongKind = await postForm(`/api/jobs/${msg.jobId}/files`, { name: 'x', file: new Blob([makeWav(0.1)], { type: 'audio/wav' }) });
    assert.equal(wrongKind.status, 400);
    // another user can't post into this job
    const fd = new FormData();
    fd.append('file', new Blob([makeWav(0.1)], { type: 'audio/wav' }), 'x.wav');
    const foreign = await fetch(`${srv.base}/api/jobs/${msg.jobId}/files`, { method: 'POST', headers: { cookie: other.cookie }, body: fd });
    assert.equal(foreign.status, 404);
    await postForm(`/api/jobs/${msg.jobId}/result`, { result: JSON.stringify({ mix: null }) });
  });
  await call('render_mix', { stems: false });
  assert.ok(seen);
  sock.ws.close();
  await waitFor(() => srv.hub.status(srv.users.findByUsername('prod').id).browsers === 0);
});

test('loudness advice never asks for a negative limiter gain', async () => {
  const { formatMixReport, MIX_TARGETS } = await import('../src/mcp/tools/mix.js');
  const p = await project();
  const mix = { duration: 10, lufs: -8, peakDb: -1, truePeakDb: -0.8, crestDb: 7, clipping: { samples: 0 }, spectrum: { bandsPercent: { sub: 10, low: 20, lowMid: 10, mid: 30, highMid: 20, high: 10 }, centroidHz: 1500, brightness: 'warm' } };
  const report = formatMixReport({ mix }, p, 'song', MIX_TARGETS.streaming);
  assert.match(report, /lower the master fader by 6 dB \(set_mixer insert 0 volumeDb -6;/); // new projects: master at 0 dB
  // an old project (master fader -1.9 dB) that is too quiet: give back the fader first, then drive the limiter
  const old = { ...p, mixer: p.mixer.map((m, i) => (i === 0 ? { ...m, volume: 0.8 } : m)) };
  const quiet = formatMixReport({ mix: { ...mix, lufs: -17, truePeakDb: -3, peakDb: -3 } }, old, 'song', MIX_TARGETS.streaming);
  assert.match(quiet, /set the master fader to 0 dB .*\+1\.9 dB.*then raise the master limiter input gain by \+1\.1 dB/);
  // the true-peak fix moves from the current ceiling
  const hot = formatMixReport({ mix: { ...mix, lufs: -14, truePeakDb: -0.6 } }, p, 'song', MIX_TARGETS.streaming);
  assert.match(hot, /lower the master limiter ceiling by 0\.6 dB \(to -1\.6 dB\)/);
});

test('roles from sample-file names; melody typos; slides never add a bar', async () => {
  const { roleOf } = await import('../src/mcp/tools/production.js');
  const cases = { Snare_Tight: 'snare', Snare2: 'snare', HH_Closed: 'hat', OpenHat_03: 'hat', Clap_808: 'snare', '808_Sub': 'bass', Perc_Loop_1: 'perc', 'Phat Bass': 'bass', Primary: 'other', 'Oh Yeah Vox': 'other', OH: 'hat', Kick_01: 'kick' };
  for (const [name, want] of Object.entries(cases)) assert.equal(roleOf({ name, instrument: { kind: 'sampler' } }), want, name);
  await fails(call('write_melody', { pattern: 'Music', channel: 'Keys', melody: 'C5:2 D5:x' }), /Invalid melody token "D5:x"/);
  const { bassLineFromChords } = await import('@greanteadawy/core');
  const notes = bassLineFromChords(['Am', 'F'], 'R:14 5:2~', { chordLength: 384 });
  assert.ok(Math.max(...notes.map((n) => n.start + n.length)) <= 768);
  assert.ok(notes.find((n) => n.start === 14 * STEP).length > 2 * STEP); // the first chord's slide still overlaps
});

test('list_instruments: grouped by collection; category narrows it; kind wins over category', async () => {
  const all = await call('list_instruments', {});
  for (const section of ['Drums', 'Flutes', 'Beatbox', 'Indian', 'East Asian']) assert.match(all, new RegExp(`^## ${section}$`, 'm'));
  const indian = await call('list_instruments', { category: 'indian' });
  assert.match(indian, /^tabla \(/m);
  assert.doesNotMatch(indian, /^kick \(|^## Drums$/m);
  const tabla = await call('list_instruments', { kind: 'tabla', category: 'drums' });
  assert.match(tabla, /"stroke"/);
  await fails(call('list_instruments', { category: 'nope' }), /category/);
});
