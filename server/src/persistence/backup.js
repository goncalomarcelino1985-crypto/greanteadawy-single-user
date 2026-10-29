import { PersistenceError, canonicalJSON, sha256, validateIdentifier, validateState, verifyObject } from './validation.js';

export async function backupWorkspace({ sourceRepository, sourceObjects, backupRepository, backupObjects, workspaceId, backupId }) {
  validateIdentifier(workspaceId, 'Workspace');
  validateIdentifier(backupId, 'Backup');
  if (sourceRepository === backupRepository || sourceObjects === backupObjects) {
    throw new PersistenceError('BACKUP_NOT_ISOLATED', 'Backup requires separate metadata and object destinations.');
  }
  if (await backupRepository.load(backupId)) throw new PersistenceError('BACKUP_EXISTS', 'Backup IDs are immutable.');
  const checkpoint = await sourceRepository.load(workspaceId);
  if (!checkpoint) throw new PersistenceError('CHECKPOINT_MISSING', 'No cloud checkpoint exists to back up.');
  const objects = validateState(checkpoint.state);
  for (const ref of objects) {
    const bytes = verifyObject(ref, await sourceObjects.get(ref));
    const copied = await backupObjects.put(bytes);
    if (canonicalJSON(copied) !== canonicalJSON(ref)) throw new PersistenceError('OBJECT_CORRUPT', 'Backup object identity changed.');
    verifyObject(ref, await backupObjects.get(ref));
  }
  const manifest = {
    schemaVersion: 1, kind: 'gm-cloud-backup', sourceWorkspaceId: workspaceId,
    sourceGeneration: checkpoint.generation, createdAt: new Date().toISOString(),
    checkpoint: checkpoint.state, checkpointSha256: sha256(canonicalJSON(checkpoint.state)), objects
  };
  const generation = await backupRepository.commit(backupId, 0, manifest);
  return { backupId, generation, sourceGeneration: checkpoint.generation, objectCount: objects.length,
    objectBytes: objects.reduce((sum, ref) => sum + ref.size, 0), checkpointSha256: manifest.checkpointSha256 };
}

export async function restoreWorkspace({ backupRepository, backupObjects, targetRepository, targetObjects, backupId, targetWorkspaceId }) {
  validateIdentifier(backupId, 'Backup');
  validateIdentifier(targetWorkspaceId, 'Target workspace');
  if (backupRepository === targetRepository || backupObjects === targetObjects) {
    throw new PersistenceError('RESTORE_NOT_ISOLATED', 'Restore must use destinations separate from the backup.');
  }
  if (await targetRepository.load(targetWorkspaceId)) {
    throw new PersistenceError('RESTORE_NOT_EMPTY', 'Restore only supports an empty target workspace.');
  }
  const saved = await backupRepository.load(backupId);
  const manifest = saved?.state;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'gm-cloud-backup' ||
      manifest.checkpointSha256 !== sha256(canonicalJSON(manifest.checkpoint))) {
    throw new PersistenceError('BACKUP_CORRUPT', 'Backup manifest is absent or failed its checksum.');
  }
  const refs = validateState(manifest.checkpoint);
  if (canonicalJSON(refs) !== canonicalJSON(manifest.objects)) {
    throw new PersistenceError('BACKUP_CORRUPT', 'Backup object manifest does not match the checkpoint.');
  }
  // No checkpoint is made visible until every source and destination byte verifies.
  // One object at a time bounds memory; failed restores can leave only harmless blobs.
  for (const ref of refs) {
    const bytes = verifyObject(ref, await backupObjects.get(ref));
    const copied = await targetObjects.put(bytes);
    if (canonicalJSON(copied) !== canonicalJSON(ref)) throw new PersistenceError('OBJECT_CORRUPT', 'Restored object identity changed.');
    verifyObject(ref, await targetObjects.get(ref));
  }
  const generation = await targetRepository.commit(targetWorkspaceId, 0, manifest.checkpoint);
  return { workspaceId: targetWorkspaceId, generation, objectCount: refs.length,
    objectBytes: refs.reduce((sum, ref) => sum + ref.size, 0), checkpointSha256: manifest.checkpointSha256 };
}
