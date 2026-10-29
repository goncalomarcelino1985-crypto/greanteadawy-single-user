import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedCloudTargets } from './helpers/isolated-cloud.js';

const database = 'postgresql://fixture:synthetic@127.0.0.1:5432/gm_test';
const objects = 'http://127.0.0.1:9000';

test('destructive fixture cleanup is restricted to explicit loopback test services', () => {
  assert.doesNotThrow(() => assertIsolatedCloudTargets(database, objects));
  assert.doesNotThrow(() => assertIsolatedCloudTargets('postgres://fixture@[::1]/gm_test', 'http://[::1]:9000'));
  for (const remote of ['postgres://fixture@ep-example.eu-central-1.aws.neon.tech/neondb', 'postgres://fixture@localhost/gm_test']) {
    assert.throws(() => assertIsolatedCloudTargets(remote, objects), /isolated loopback/);
  }
  assert.throws(() => assertIsolatedCloudTargets(database, 'https://br-example.storage.c-2.eu-central-1.aws.neon.tech'), /isolated loopback/);
});

test('connection overrides and malformed secret input fail before clients can connect', () => {
  for (const query of ['?host=remote.example', '?connectionString=postgres://remote.example/db', '#override']) {
    assert.throws(() => assertIsolatedCloudTargets(database + query, objects), /connection overrides/);
  }
  assert.throws(() => assertIsolatedCloudTargets(database, objects + '?endpoint=remote.example'), /connection overrides/);
  assert.throws(() => assertIsolatedCloudTargets('SECRET-not-a-url', objects), (error) => !error.message.includes('SECRET'));
});
