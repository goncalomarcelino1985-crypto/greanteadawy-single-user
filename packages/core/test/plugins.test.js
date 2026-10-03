// Plugin manifests: what a plugin may declare, and how values from plugins and generators are cleaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest, sanitizePluginValues, sanitizeStoredPluginParams, pluginParamValues, cleanGeneratedNotes,
  createDefaultProject, applyOps, normalizeProject, summarizeProject, makeInstrument, createEffect
} from '../src/index.js';

const base = (extra = {}) => ({
  id: 'acme.echo', name: 'Echo', version: '1.2.3', type: 'effect', main: 'dsp.js', permissions: ['audio-processing'],
  params: [{ key: 'mix', min: 0, max: 1, default: 0.5, automatable: true }, { key: 'mode', type: 'select', options: ['a', 'b'] }],
  ...extra
});
const files = new Set(['plugin.json', 'dsp.js', 'gen.js', 'samples/c4.wav']);
const bad = (m, re) => assert.throws(() => validateManifest(m, files), re);

test('manifests: valid ones normalize; identity, version and type are checked', () => {
  const m = validateManifest(base(), files);
  assert.equal(m.id, 'acme.echo');
  assert.deepEqual(m.presets, { Default: {} });
  assert.deepEqual(m.params[0], { key: 'mix', label: 'mix', type: 'number', min: 0, max: 1, default: 0.5, automatable: true });
  assert.equal(m.params[1].default, 'a');
  bad(base({ id: 'Bad Id' }), /id must be/);
  bad(base({ id: '../x' }), /id must be/);
  bad(base({ version: 'one' }), /version must look like/);
  bad(base({ type: 'virus' }), /type must be one of/);
  bad(base({ apiVersion: 2 }), /apiVersion 2 is not supported/);
  bad(base({ name: '' }), /name is required/);
  bad([], /must be a JSON object/);
});

test('manifests: permissions — network & co. are never granted; each type needs its own', () => {
  for (const p of ['network', 'Internet', 'storage', 'files', 'account', 'microphone']) bad(base({ permissions: ['audio-processing', p] }), /never granted/);
  bad(base({ permissions: ['audio-processing', 'root'] }), /unknown permission "root"/);
  bad(base({ permissions: [] }), /must ask for the "audio-processing" permission/);
  bad(base({ main: undefined, permissions: [] }), /an effect needs main/);
  bad(base({ type: 'generator', main: 'gen.js', permissions: ['audio-processing'] }), /must ask for the "generator" permission/);
  bad(base({ type: 'generator', main: 'gen.js', permissions: ['generator', 'audio-processing'] }), /don't process audio/);
  bad(base({ permissions: ['audio-processing', 'project-read'] }), /can't ask for generator or project-read/);
  assert.equal(validateManifest(base({ type: 'generator', main: 'gen.js', permissions: ['generator', 'project-read'] }), files).type, 'generator');
  // sample instruments: no code, samples permission
  const s = base({ type: 'instrument', main: undefined, permissions: ['samples'], params: [], samples: [{ file: 'samples/c4.wav', root: 60 }] });
  assert.deepEqual(validateManifest(s, files).samples, [{ file: 'samples/c4.wav', root: 60, lo: 0, hi: 127, velLo: 0, velHi: 1 }]);
  bad({ ...s, permissions: [] }, /must ask for the "samples" permission/);
  bad({ ...s, samples: [{ file: 'samples/missing.wav' }] }, /not in the package/);
  bad({ ...s, samples: [{ file: '../etc/passwd.wav' }] }, /must be a \.wav/);
  bad({ ...s, samples: [{ file: 'samples/c4.wav', lo: 70, hi: 60 }] }, /hi must be ≥ lo/);
  bad(base({ main: 'other.js' }), /not in the package/);
  bad(base({ main: 'dsp.mjs' }), /must be a \.js file/);
});

test('manifests: params, presets and reserved names', () => {
  bad(base({ params: [{ key: 'gtdGate' }] }), /reserved/);
  bad(base({ params: [{ key: '1x' }] }), /short identifier/);
  bad(base({ params: [{ key: 'a', min: 1, max: 0 }] }), /max must be greater/);
  bad(base({ params: [{ key: 'a', min: 0, max: 1, default: 3 }] }), /default must be between/);
  bad(base({ params: [{ key: 'f', min: 0, max: 100, curve: 'log' }] }), /log curve needs min > 0/);
  bad(base({ params: [{ key: 'a' }, { key: 'a' }] }), /unique/);
  bad(base({ params: [{ key: 's', type: 'select', options: [] }] }), /1–24 choices/);
  bad(base({ presets: { Loud: { mix: 2 } } }), /between 0 and 1/);
  bad(base({ presets: { Odd: { nope: 1 } } }), /unknown parameter "nope"/);
  const m = validateManifest(base({ presets: { Wet: { mix: 1 }, Dry: { mix: 0, mode: 'b' } } }), files);
  assert.deepEqual(pluginParamValues(m, 'Dry', { mix: 0.25 }), { mix: 0.25, mode: 'b' });
  assert.deepEqual(sanitizePluginValues(m.params, { mix: 5, mode: 'z', junk: 1 }), { mix: 1 });
  // stepped params are rounded to their step (a generator's "pulses" is an integer)
  const st = validateManifest(base({ params: [{ key: 'n', min: 1, max: 32, default: 4, step: 1 }, { key: 'q', min: 0, max: 1, default: 0, step: 0.25 }] }), files);
  assert.deepEqual(sanitizePluginValues(st.params, { n: 2.5, q: 0.3 }), { n: 3, q: 0.25 });
  assert.throws(() => sanitizePluginValues(m.params, { mix: 5 }, { strict: true }), /between 0 and 1/);
  // descriptive text is cleaned, homepage must be https
  const t = validateManifest(base({ description: 'a\u0000b\nc', homepage: 'javascript:alert(1)' }), files);
  assert.equal(t.description, 'a b c');
  assert.equal(t.homepage, '');
});

test('projects keep plugin instruments and effects (even when the plugin is missing), values cleaned loosely', () => {
  let p = createDefaultProject();
  p = applyOps(p, [
    { type: 'channel/add', channel: { id: 'ch_plug', name: 'Chip', kind: 'plugin', plugin: 'acme.chip', preset: 'Lead', params: { duty: '50%', gain: 0.5, x: { evil: 1 }, 'bad key': 1 } } },
    { type: 'effect/add', index: 1, effect: { id: 'fx_plug', type: 'plugin', plugin: 'acme.echo', params: { mix: 0.3, huge: 1e12 } } }
  ]);
  const ch = p.channels.find((c) => c.id === 'ch_plug');
  assert.deepEqual(ch.instrument, { kind: 'plugin', plugin: 'acme.chip', preset: 'Lead', params: { duty: '50%', gain: 0.5 } });
  const fx = p.mixer[1].effects.find((e) => e.id === 'fx_plug');
  assert.deepEqual(fx, { id: 'fx_plug', type: 'plugin', plugin: 'acme.echo', enabled: true, params: { mix: 0.3, huge: 1e6 } });
  // automation of a plugin effect's numeric param
  p = applyOps(p, [{ type: 'automation/add', automation: { id: 'auto_m', name: 'm', target: { type: 'effect', index: 1, effectId: 'fx_plug', param: 'mix' }, length: 96, points: [] } }]);
  assert.throws(() => applyOps(p, [{ type: 'automation/add', automation: { name: 'x', target: { type: 'effect', index: 1, effectId: 'fx_plug', param: 'nope' }, length: 96, points: [] } }]), /not a number/);
  const n = normalizeProject(JSON.parse(JSON.stringify(p)));
  assert.equal(n.channels.find((c) => c.id === 'ch_plug').instrument.plugin, 'acme.chip');
  assert.equal(n.mixer[1].effects.find((e) => e.id === 'fx_plug').plugin, 'acme.echo');
  assert.ok(n.automations.find((a) => a.id === 'auto_m'));
  assert.match(summarizeProject(n), /plugin\/Lead plugin=acme\.chip/);
  assert.match(summarizeProject(n), /plugin\(acme\.echo\)/);
  assert.equal(makeInstrument('plugin', null, {}, { plugin: '../../etc' }).plugin, null); // invalid ids are dropped
  assert.equal(createEffect('plugin', {}, { plugin: 'UPPER' }).plugin, null);
  assert.deepEqual(sanitizeStoredPluginParams({ a: 1, b: 'x'.repeat(100), c: [1], d: true }), { a: 1, b: 'x'.repeat(64), d: true });
  // switching a channel to another plugin
  p = applyOps(p, [{ type: 'channel/update', id: 'ch_plug', patch: { instrument: { kind: 'plugin', plugin: 'acme.other', preset: 'Default', params: { q: 1 } } } }]);
  assert.deepEqual(p.channels.find((c) => c.id === 'ch_plug').instrument, { kind: 'plugin', plugin: 'acme.other', preset: 'Default', params: { q: 1 } });
});

test('generator output is untrusted: invalid notes dropped, values clamped, count capped', () => {
  const out = cleanGeneratedNotes([
    { step: 0, key: 60, length: 2, velocity: 0.8 },
    { step: -1, key: 60 }, { step: 99, key: 60 }, { step: 'x', key: 60 }, null, 'note',
    { step: 3.3, key: 200, length: 0, velocity: 9 },
    { step: 15, key: 60.6, length: 10 }
  ], 16);
  assert.deepEqual(out, [
    { step: 0, length: 2, key: 60, velocity: 0.8 },
    { step: 3.25, length: 0.25, key: 127, velocity: 1 },
    { step: 15, length: 1, key: 61, velocity: 0.8 }
  ]);
  assert.equal(cleanGeneratedNotes(Array.from({ length: 10000 }, (_, i) => ({ step: i % 16, key: 60 })), 16).length, 4096);
  assert.throws(() => cleanGeneratedNotes({ notes: [] }, 16), /must return a list/);
});
