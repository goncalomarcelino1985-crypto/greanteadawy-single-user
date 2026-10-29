#!/usr/bin/env node
// Additive validation in an explicitly reviewed cloud destination. It retains
// its tiny synthetic checkpoint/object; it never removes cloud data or runs DDL.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { projectToMidi } from '@greanteadawy/core';
import { cloudConfig } from '../config.js';
import { openCloudStores, validateCloudConfig } from '../cloud-provider.js';
import { CloudWorkspace } from '../cloud-workspace.js';
import { ProjectStore } from '../store.js';
import { validatePreferences } from '../preferences.js';
import { PersistenceError, canonicalJSON, sha256, verifyObject } from '../persistence/index.js';

const fail = (code) => new PersistenceError(code, 'Synthetic cloud validation did not complete.');
const equal = (a, b) => canonicalJSON(a) === canonicalJSON(b);

/** Validate both exact bindings before opening any network connection. */
export function validationSettings(env) {
  const primary = cloudConfig(env, 'CLOUD_');
  const reader = cloudConfig(env, 'READER_');
  const a = validateCloudConfig(primary).binding;
  const b = validateCloudConfig(reader).binding;
  const projectId = env.CLOUD_VALIDATION_PROJECT_ID;
  const branchId = env.CLOUD_VALIDATION_BRANCH_ID;
  const database = env.CLOUD_VALIDATION_DATABASE || 'gm_ai_worker';
  if (!projectId || !branchId || a.projectId !== projectId || b.projectId !== projectId ||
      a.branchId !== branchId || b.branchId !== branchId || a.database.name !== database || b.database.name !== database ||
      a.database.host !== b.database.host || a.database.role === b.database.role || !equal(a.objects, b.objects)) {
    throw fail('VALIDATION_TARGET_MISMATCH');
  }
  return { primary, reader, projectId, branchId, database };
}

// Eight PCM samples, with a valid WAV header. No rendering or audio model runs.
function tinyWav() {
  const bytes = Buffer.alloc(60);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(52, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(16, 40);
  bytes.writeInt16LE(128, 44); bytes.writeInt16LE(-128, 46);
  return bytes;
}

async function mustDenyWrite(fn) {
  try { await fn(); }
  catch (error) { if (error.code === 'READ_ONLY') return; throw fail('VALIDATION_READER_GUARD'); }
  throw fail('VALIDATION_READER_GUARD');
}

/** Importing this module is inert. Tests inject stores; the CLI uses real providers. */
export async function validateCloudRoundTrip({ env = process.env, openStores = openCloudStores,
  uuid = randomUUID, onProgress = () => {} } = {}) {
  const settings = validationSettings(env);
  const suffix = uuid();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(suffix)) throw fail('VALIDATION_NAMESPACE');
  const workspaceId = `synthetic-validation-${suffix}`;
  const identity = { projectId: settings.projectId, branchId: settings.branchId, database: settings.database, workspaceId };
  onProgress({ status: 'starting', ...identity });
  const stores = new Set(), caches = new Set();
  const open = async (config, readOnly) => {
    const store = await openStores(config, { readOnly });
    stores.add(store);
    return store;
  };
  const closeStore = async (store) => { await store.disconnect(); stores.delete(store); };
  const makeCache = async (store, allowInitialize) => {
    const cache = new CloudWorkspace({ ...store, workspaceId, allowInitialize });
    caches.add(cache);
    await cache.init();
    return cache;
  };
  const closeCache = async (cache) => { await cache.close(); caches.delete(cache); };
  try {
    const writer = await open(settings.primary, false);
    // Its SELECT-only access preflight must pass before any synthetic writes.
    const readerPreflight = await open(settings.reader, true);
    const cache = await makeCache(writer, true);
    if (cache.generation !== 0) throw fail('VALIDATION_NAMESPACE_OCCUPIED');
    const ownerId = 'synthetic_validation';
    const operationId = `synthetic-edit-${suffix}`;
    const ops = [{ type: 'project/update', patch: { name: 'Synthetic storage validation edited' } }];
    const editMeta = { userId: ownerId, source: 'mcp', undoable: true, operationId };
    const projectStore = await new ProjectStore(cache.dataDir, { saveDelay: 0 }).init();
    cache.flush = () => projectStore.flush();
    cache.guardMethods(projectStore, ['create', 'applyOps', 'undoLast']);
    const sample = tinyWav();
    const sampleFile = 'samples/synthetic-validation.wav';
    const wavExportFile = `exports/${ownerId}/synthetic-validation.wav`;
    const midiExportFile = `exports/${ownerId}/synthetic-validation.mid`;
    const preferencesFile = `preferences/${ownerId}.json`;
    const preferences = { revision: 1, preferences: validatePreferences({ snap: 'bar', metronome: true, kbOctave: 4,
      recorderPreferences: { countIn: 2, channels: 1, along: 'song' } }) };
    let originalProject, project, midi;
    await cache.run(async () => {
      originalProject = await projectStore.create({ ownerId, template: 'house', name: 'Synthetic storage validation', bpm: 126 });
      project = await projectStore.applyOps(originalProject.id, ops, editMeta);
      midi = Buffer.from(projectToMidi(project, { mode: 'pattern', patternId: project.patterns[0].id }));
      await fs.mkdir(path.join(cache.dataDir, 'samples'), { recursive: true });
      await fs.mkdir(path.join(cache.dataDir, 'exports', ownerId), { recursive: true });
      await fs.mkdir(path.join(cache.dataDir, 'preferences'), { recursive: true });
      await fs.writeFile(path.join(cache.dataDir, sampleFile), sample, { mode: 0o600 });
      await fs.writeFile(path.join(cache.dataDir, 'samples/index.json'), JSON.stringify([{ id: 'synthetic_sample', ownerId,
        name: 'Synthetic sample', file: path.basename(sampleFile), mime: 'audio/wav', size: sample.length, rev: 1 }]), { mode: 0o600 });
      await fs.writeFile(path.join(cache.dataDir, wavExportFile), sample, { mode: 0o600 });
      await fs.writeFile(path.join(cache.dataDir, midiExportFile), midi, { mode: 0o600 });
      await fs.writeFile(path.join(cache.dataDir, preferencesFile), JSON.stringify(preferences), { mode: 0o600 });
    });
    const committed = await writer.repository.load(workspaceId);
    const expectedHash = sha256(canonicalJSON(cache.state));
    if (committed?.generation !== 1 || sha256(canonicalJSON(committed.state)) !== expectedHash) throw fail('VALIDATION_CHECKPOINT');
    const ref = committed.state.files[sampleFile];
    const midiRef = committed.state.files[midiExportFile];
    verifyObject(ref, await writer.objects.get(ref));
    onProgress({ status: 'committed', ...identity, generation: committed.generation, metadataSha256: expectedHash,
      objectSha256: ref.sha256, objectBytes: ref.size, syntheticDataRetained: true });
    const oldCache = cache.dataDir;
    await closeCache(cache);
    await closeStore(writer);
    await closeStore(readerPreflight);

    // New pool/client and new empty cache: neither old connection nor local bytes
    // can provide the result. This is rehydration, not an independent backup.
    const verifyFixture = async (restoredCache, expectedProject, expectedGeneration, stateHash, undoDepth) => {
      if (restoredCache.dataDir === oldCache || restoredCache.generation !== expectedGeneration ||
          sha256(canonicalJSON(restoredCache.state)) !== stateHash) throw fail('VALIDATION_REHYDRATION');
      const store = await new ProjectStore(restoredCache.dataDir, { saveDelay: 0 }).init();
      if (!equal(await store.getOwned(project.id, ownerId), expectedProject)) throw fail('VALIDATION_REHYDRATION');
      const receipt = await store.getOperationReceipt(project.id, operationId, ownerId, ops);
      if (receipt?.rev !== 1 || store.undo.get(project.id)?.length !== undoDepth) throw fail('VALIDATION_HISTORY');
      const restoredPreferences = JSON.parse(await fs.readFile(path.join(restoredCache.dataDir, preferencesFile), 'utf8'));
      if (!equal(restoredPreferences, preferences) || !equal(validatePreferences(restoredPreferences.preferences), preferences.preferences)) throw fail('VALIDATION_PREFERENCES');
      for (const [file, expectedBytes] of [[sampleFile, sample], [wavExportFile, sample], [midiExportFile, midi]]) {
        const bytes = await fs.readFile(await restoredCache.ensureFile(file));
        verifyObject(restoredCache.state.files[file], bytes);
        if (!bytes.equals(expectedBytes)) throw fail('VALIDATION_REHYDRATION');
      }
      return store;
    };
    const reader = await open(settings.reader, true);
    const reopened = await makeCache(reader, false);
    await verifyFixture(reopened, project, 1, expectedHash, 1);
    if (reader.repository.readOnly !== true || reader.objects.readOnly !== true) throw fail('VALIDATION_READER_GUARD');
    // Expected generation zero is deliberately stale. Even a broken application
    // guard cannot overwrite the committed fixture through this CAS operation.
    await mustDenyWrite(() => reader.repository.commit(workspaceId, 0, committed.state));
    await mustDenyWrite(() => reader.objects.put(sample));
    if (!equal(await reader.repository.load(workspaceId), committed)) throw fail('VALIDATION_CHECKPOINT');
    await closeCache(reopened);
    await closeStore(reader);

    // Exercise retry and Undo with the real store after reconstruction. Only this
    // new UUID fixture can change; no existing studio or cloud object is deleted.
    const undoWriter = await open(settings.primary, false);
    const undoCache = await makeCache(undoWriter, false);
    const undoStore = await verifyFixture(undoCache, project, 1, expectedHash, 1);
    undoCache.flush = () => undoStore.flush();
    undoCache.guardMethods(undoStore, ['applyOps', 'undoLast']);
    const repeated = await undoCache.run(() => undoStore.applyOps(project.id, ops, editMeta));
    if (!equal(repeated, project) || undoCache.generation !== 1 ||
        !equal(await undoWriter.repository.load(workspaceId), committed)) throw fail('VALIDATION_IDEMPOTENCY');
    const undone = await undoCache.run(() => undoStore.undoLast(project.id, ownerId));
    if (undone.project.name !== originalProject.name || undone.project.bpm !== 126 || undone.project.rev !== 2 ||
        undoCache.generation !== 2) throw fail('VALIDATION_UNDO');
    const undoHash = sha256(canonicalJSON(undoCache.state));
    await closeCache(undoCache);
    await closeStore(undoWriter);
    const finalReader = await open(settings.reader, true);
    const finalCache = await makeCache(finalReader, false);
    await verifyFixture(finalCache, undone.project, 2, undoHash, 0);
    return { status: 'verified', ...identity, generation: finalCache.generation,
      metadataSha256: undoHash, initialMetadataSha256: expectedHash, objectSha256: ref.sha256, objectBytes: ref.size,
      midiExportSha256: midiRef.sha256, midiExportBytes: midiRef.size,
      freshConnectionVerified: true, freshCacheVerified: true, readerDatabasePrivilegesVerified: true,
      readerMetadataWriteGuardVerified: true, readerObjectApplicationGuardVerified: true,
      preferencesVerified: true, audioExportVerified: true, midiExportVerified: true,
      undoHistoryRestored: true, operationReceiptRestored: true, retryIdempotencyVerified: true, undoRoundTripVerified: true,
      objectCredentialReadOnlyVerified: false, independentBackupVerified: false,
      syntheticDataRetained: true, productionDeploymentPerformed: false };
  } finally {
    // Only the caches created above are removed. Cloud rows/objects are retained,
    // including partial runs, for inspection; there is no cloud deletion method.
    await Promise.allSettled([...caches].map((cache) => cache.close()));
    await Promise.allSettled([...stores].map((store) => store.disconnect()));
  }
}

const safeCodes = new Set(['VALIDATION_TARGET_MISMATCH', 'VALIDATION_NAMESPACE', 'VALIDATION_NAMESPACE_OCCUPIED',
  'VALIDATION_READER_GUARD', 'VALIDATION_CHECKPOINT', 'VALIDATION_REHYDRATION', 'VALIDATION_HISTORY',
  'VALIDATION_PREFERENCES', 'VALIDATION_IDEMPOTENCY', 'VALIDATION_UNDO', 'CLOUD_ACCESS_UNSAFE',
  'CLOUD_ACCESS_UNVERIFIED', 'OBJECT_ACCESS_DENIED', 'OBJECT_MISSING', 'OBJECT_CORRUPT', 'OBJECT_QUOTA', 'METADATA_QUOTA', 'CHECKPOINT_CONFLICT']);

export async function runValidationCli({ env = process.env, args = process.argv.slice(2), openStores = openCloudStores,
  output = (value) => console.log(JSON.stringify(value)), errorOutput = (value) => console.error(JSON.stringify(value)) } = {}) {
  if (args.length) { errorOutput({ status: 'rejected', code: 'VALIDATION_NO_ARGUMENTS', usage: 'node server/src/cli/cloud-validate.js' }); return 1; }
  try {
    output(await validateCloudRoundTrip({ env, openStores, onProgress: output }));
    return 0;
  } catch (error) {
    // Never print provider messages, URLs, credential-bearing config or raw codes.
    errorOutput({ status: 'failed', code: safeCodes.has(error.code) ? error.code : 'CLOUD_VALIDATION_FAILED' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runValidationCli();
}
