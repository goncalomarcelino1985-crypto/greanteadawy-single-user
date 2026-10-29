import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../src/store.js';

const ownerId = 'usr_durable';
const bpmOp = (bpm) => [{ type: 'project/update', patch: { bpm } }];

async function fixture(t, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-durable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await new ProjectStore(dir, options).init();
  const project = await store.create({ ownerId, template: 'empty', bpm: 126, name: 'Durability House' });
  return { dir, store, project };
}

test('an acknowledged edit survives a new process without flush or a save timer', async (t) => {
  const { dir, store, project } = await fixture(t, { saveDelay: 60_000 });
  const events = [];
  store.on('ops', (event) => events.push(event));
  const after = await store.applyOps(project.id, bpmOp(127), { userId: ownerId, source: 'mcp', undoable: true, operationId: 'edit-1' });
  assert.equal(after.rev, 1);
  assert.equal(store.timers.size, 0);
  assert.equal(events.length, 1);
  const restarted = await new ProjectStore(dir).init();
  assert.equal((await restarted.getOwned(project.id, ownerId)).bpm, 127);
  assert.equal((await restarted.getOperationReceipt(project.id, 'edit-1', ownerId, bpmOp(127))).rev, 1);
  assert.equal((await restarted.undoLast(project.id, ownerId)).project.bpm, 126);
});

test('a failed write changes neither cache, undo, receipts nor emitted events', async (t) => {
  const { dir, store, project } = await fixture(t);
  await store.applyOps(project.id, bpmOp(127), { userId: ownerId, source: 'mcp', undoable: true, operationId: 'saved' });
  const before = await store.get(project.id);
  const undoBefore = structuredClone(store.undo.get(project.id));
  const receiptsBefore = structuredClone(store.receipts.get(project.id));
  const events = [];
  store.on('ops', (event) => events.push(event));
  const write = store.writeNow;
  store.writeNow = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(store.applyOps(project.id, bpmOp(128), { userId: ownerId, undoable: true, operationId: 'failed' }), /storage unavailable/);
  assert.strictEqual(await store.get(project.id), before);
  assert.deepEqual(store.undo.get(project.id), undoBefore);
  assert.deepEqual(store.receipts.get(project.id), receiptsBefore);
  assert.deepEqual(events, []);
  assert.equal((await new ProjectStore(dir).get(project.id)).bpm, 127);
  store.writeNow = write;
  assert.equal((await store.applyOps(project.id, bpmOp(128), { userId: ownerId, operationId: 'failed' })).rev, 2);
});

test('second-file write failure rolls the local project and history back together', async (t) => {
  const { dir, store, project } = await fixture(t);
  const beforeProject = await fs.readFile(store.file(project.id));
  const beforeHistory = await fs.readFile(store.historyFile(project.id));
  const rename = fs.rename;
  let rejectOnce = true;
  fs.rename = async (from, to) => {
    if (rejectOnce && to === store.historyFile(project.id)) {
      rejectOnce = false;
      throw Object.assign(new Error('history disk full'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  };
  try {
    await assert.rejects(store.applyOps(project.id, bpmOp(128), { userId: ownerId, undoable: true, operationId: 'not-committed' }), /history disk full/);
  } finally {
    fs.rename = rename;
  }
  assert.deepEqual(await fs.readFile(store.file(project.id)), beforeProject);
  assert.deepEqual(await fs.readFile(store.historyFile(project.id)), beforeHistory);
  assert.equal((await store.get(project.id)).rev, 0);
  assert.equal((await new ProjectStore(dir).get(project.id)).bpm, 126);
  assert.equal(await store.getOperationReceipt(project.id, 'not-committed', ownerId), null);
});

test('failed creation does not publish or retain a ghost project', async (t) => {
  const { store } = await fixture(t);
  const before = await store.list(ownerId);
  let notified = false;
  store.on('list-changed', () => { notified = true; });
  store.writeNow = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(store.create({ ownerId, template: 'empty', name: 'Never saved' }), /storage unavailable/);
  assert.deepEqual(await store.list(ownerId), before);
  assert.equal(store.cache.size, 1);
  assert.equal(notified, false);
});

test('failed undo keeps its entry; repeated undo persists across each restart', async (t) => {
  const { dir, store, project } = await fixture(t);
  await store.applyOps(project.id, bpmOp(127), { userId: ownerId, undoable: true });
  await store.applyOps(project.id, bpmOp(128), { userId: ownerId, undoable: true });
  const restarted = await new ProjectStore(dir).init();
  const write = restarted.writeNow;
  restarted.writeNow = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(restarted.undoLast(project.id, ownerId), /storage unavailable/);
  assert.equal((await restarted.get(project.id)).bpm, 128);
  assert.equal(restarted.undo.get(project.id).length, 2);
  restarted.writeNow = write;
  assert.equal((await restarted.undoLast(project.id, ownerId)).project.bpm, 127);
  const again = await new ProjectStore(dir).init();
  assert.equal((await again.undoLast(project.id, ownerId)).project.bpm, 126);
  await assert.rejects(new ProjectStore(dir).undoLast(project.id, ownerId), /Nothing to undo/);
});

test('undo conflict protection survives restart', async (t) => {
  const { dir, store, project } = await fixture(t);
  await store.applyOps(project.id, bpmOp(127), { userId: ownerId, undoable: true });
  await store.applyOps(project.id, bpmOp(130), { userId: ownerId });
  const restarted = await new ProjectStore(dir).init();
  await assert.rejects(restarted.undoLast(project.id, ownerId), { status: 409 });
  assert.equal((await restarted.get(project.id)).bpm, 130);
  assert.equal((await restarted.undoLast(project.id, ownerId, { force: true })).project.bpm, 126);
});

test('a retried operation is deduplicated after restart, with payload and owner checks', async (t) => {
  const { dir, store, project } = await fixture(t);
  const original = [{ type: 'channel/add', channel: { name: 'Kick', kind: 'kick', mixerTrack: 'auto' } }];
  await store.applyOps(project.id, original, { userId: ownerId, undoable: true, operationId: 'lost-ack' });
  await store.applyOps(project.id, bpmOp(127), { userId: ownerId });
  const restarted = await new ProjectStore(dir).init();
  let notified = false;
  restarted.on('ops', () => { notified = true; });
  const reordered = [{ channel: { kind: 'kick', mixerTrack: 'auto', name: 'Kick' }, type: 'channel/add' }];
  const after = await restarted.applyOps(project.id, reordered, { userId: ownerId, undoable: true, operationId: 'lost-ack' });
  assert.equal(after.rev, 2);
  assert.equal(after.channels.length, 1);
  assert.equal(restarted.undo.get(project.id).length, 1);
  assert.equal(notified, false);
  assert.equal((await restarted.getOperationReceipt(project.id, 'lost-ack', ownerId, original)).rev, 1);
  await assert.rejects(restarted.applyOps(project.id, bpmOp(132), { userId: ownerId, operationId: 'lost-ack' }), { status: 409 });
  await assert.rejects(restarted.getOperationReceipt(project.id, 'lost-ack', ownerId, bpmOp(132)), { status: 409 });
  await assert.rejects(restarted.getOperationReceipt(project.id, 'lost-ack', 'usr_else'), { status: 404 });
  assert.equal((await restarted.get(project.id)).rev, 2);
});

test('concurrent copies of one operation commit exactly once', async (t) => {
  const { store, project } = await fixture(t, { cache: false });
  const ops = [{ type: 'channel/add', channel: { name: 'Bass', kind: 'bass', mixerTrack: 'auto' } }];
  const results = await Promise.all(Array.from({ length: 8 }, () => store.applyOps(project.id, ops, { userId: ownerId, operationId: 'concurrent' })));
  assert.ok(results.every((p) => p.rev === 1));
  assert.equal((await store.get(project.id)).channels.length, 1);
});

test('corrupt and mismatched history fails closed without silently clearing Undo', async (t) => {
  const { dir, store, project } = await fixture(t);
  await store.applyOps(project.id, bpmOp(127), { userId: ownerId, undoable: true });
  const history = JSON.parse(await fs.readFile(store.historyFile(project.id), 'utf8'));
  await fs.writeFile(store.historyFile(project.id), JSON.stringify({ ...history, rev: history.rev + 1 }));
  await assert.rejects(new ProjectStore(dir).get(project.id), { status: 503 });
  await assert.rejects(new ProjectStore(dir).list(ownerId), { status: 503 });
  await fs.writeFile(store.historyFile(project.id), '{');
  await assert.rejects(new ProjectStore(dir).get(project.id), { status: 503 });
  assert.equal(await fs.readFile(store.historyFile(project.id), 'utf8'), '{');
});

test('old projects without a sidecar acquire durable history on their next edit', async (t) => {
  const { dir, store, project } = await fixture(t);
  await fs.rm(store.historyFile(project.id));
  const legacy = await new ProjectStore(dir).init();
  assert.equal((await legacy.get(project.id)).bpm, 126);
  await legacy.applyOps(project.id, bpmOp(127), { userId: ownerId, undoable: true });
  assert.equal((await new ProjectStore(dir).undoLast(project.id, ownerId)).project.bpm, 126);
});

test('deleting a project removes durable history and snapshots and cannot be resurrected by flush', async (t) => {
  const { dir, store, project } = await fixture(t);
  await store.applyOps(project.id, bpmOp(127), { userId: ownerId, undoable: true, operationId: 'gone' });
  await store.saveVersion(project.id, ownerId, 'Before removal');
  await store.remove(project.id);
  await store.flush();
  await assert.rejects(store.get(project.id), { status: 404 });
  await assert.rejects(new ProjectStore(dir).get(project.id), { status: 404 });
  for (const file of [store.file(project.id), store.historyFile(project.id), store.versionDir(project.id)]) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
  }
  assert.equal(store.undo.has(project.id), false);
  assert.equal(store.receipts.has(project.id), false);
});

test('durable Undo and deduplication history are bounded', async (t) => {
  const { dir, store, project } = await fixture(t);
  for (let i = 0; i < 515; i++) {
    await store.applyOps(project.id, bpmOp(126 + i % 2), { userId: ownerId, undoable: i < 35, operationId: `bounded-${i}` });
  }
  const restarted = await new ProjectStore(dir).init();
  await restarted.get(project.id);
  assert.equal(restarted.undo.get(project.id).length, 30);
  assert.equal(restarted.receipts.get(project.id).length, 512);
  assert.equal(await restarted.getOperationReceipt(project.id, 'bounded-0', ownerId), null);
  assert.equal((await restarted.getOperationReceipt(project.id, 'bounded-514', ownerId)).rev, 515);
});
