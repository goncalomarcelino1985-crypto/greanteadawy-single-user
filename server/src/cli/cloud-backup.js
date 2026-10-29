#!/usr/bin/env node
// Run in an online maintenance environment with dedicated credentials. Never
// upload the environment or the complete checkpoint as a CI artifact.
import { openCloudStores, assertIndependentCloudBindings } from '../cloud-provider.js';
import { backupWorkspace, restoreWorkspace } from '../persistence/index.js';
import { cloudConfig } from '../config.js';

const [command, workspaceId, backupId] = process.argv.slice(2);
if (!['backup', 'restore'].includes(command) || !workspaceId || !backupId) {
  console.error('Usage: node server/src/cli/cloud-backup.js backup|restore WORKSPACE_ID BACKUP_ID');
  process.exit(1);
}
const primarySettings = cloudConfig(process.env, 'CLOUD_');
const backupSettings = cloudConfig(process.env, 'BACKUP_');
let primary, backup;
try {
  // Parse both reviewed bindings before any connection, including credentials
  // that differ only by a database role or a pooled hostname.
  assertIndependentCloudBindings(primarySettings, backupSettings);
  primary = await openCloudStores(primarySettings, { readOnly: command === 'backup' });
  backup = await openCloudStores(backupSettings, { readOnly: command === 'restore' });
  const result = command === 'backup'
    ? await backupWorkspace({ sourceRepository: primary.repository, sourceObjects: primary.objects, backupRepository: backup.repository, backupObjects: backup.objects, workspaceId, backupId })
    : await restoreWorkspace({ targetRepository: primary.repository, targetObjects: primary.objects, backupRepository: backup.repository, backupObjects: backup.objects, targetWorkspaceId: workspaceId, backupId });
  console.log(JSON.stringify({ command, verified: true, ...result }));
} catch (error) {
  // Provider errors may contain connection details; log only safe codes.
  console.error(JSON.stringify({ command, verified: false, code: error.code || 'CLOUD_OPERATION_FAILED' }));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([primary?.disconnect(), backup?.disconnect()]);
}
