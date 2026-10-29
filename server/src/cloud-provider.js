import pg from 'pg';
import { S3Client } from '@aws-sdk/client-s3';
import { PostgresCheckpointRepository, PostgresObjectLedger, S3ObjectStore } from './persistence/index.js';
import { verifyRuntimeAccess } from './persistence/access.js';
import { CloudWorkspace } from './cloud-workspace.js';

/** Credentials stay server-side. This code cannot create a paid plan or upgrade one. */
export async function connectCloud(config) {
  if (config.storageMode !== 'cloud') return null;
  if (!config.singleUser) throw new Error('Cloud workspace mode currently requires SINGLE_USER=true');
  const c = config.cloud;
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(c?.workspaceId || '')) throw new Error('Invalid CLOUD_WORKSPACE_ID');
  const stores = await openCloudStores(c);
  let cloud;
  try {
    cloud = new CloudWorkspace({ ...stores, workspaceId: c.workspaceId, allowInitialize: c.initializeEmpty });
    await cloud.init();
  } catch (error) { await stores.disconnect(); throw error; }
  cloud.disconnect = async () => { await cloud.close(); await stores.disconnect(); };
  return cloud;
}

const invalid = () => new Error('Cloud configuration does not match the reviewed project and branch binding.');
const hostname = (value) => typeof value === 'string' && /^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(value) && !value.endsWith('.localhost');
const nonempty = (value) => typeof value === 'string' && value.length > 0 && value === value.trim();
const keysAre = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

/** Pure validation: a reviewed mapping pins exact destinations, not inferred project identity from an ep-* hostname. */
export function validateCloudConfig(c) {
  if (c?.initializeSchema) throw new Error('Runtime schema initialization is disabled. Use the separate manual provisioning SQL.');
  for (const name of ['databaseUrl', 'endpoint', 'bucket', 'accessKeyId', 'secretAccessKey', 'region']) {
    if (!c?.[name]) throw new Error(`Missing cloud configuration: ${name}`);
  }
  let endpoint, connection, binding;
  try {
    endpoint = new URL(c.endpoint); connection = new URL(c.databaseUrl);
    binding = typeof c.binding === 'string' ? JSON.parse(c.binding) : c.binding;
  }
  catch { throw new Error('Invalid private cloud connection configuration'); }
  if (!keysAre(binding, ['projectId', 'branchId', 'database', 'objects']) ||
      !keysAre(binding.database, ['host', 'name', 'role']) || !keysAre(binding.objects, ['endpoint', 'bucket', 'region']) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(binding.projectId || '') ||
      !/^br-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(binding.branchId || '') ||
      !hostname(binding.database?.host) || !nonempty(binding.database?.name) || binding.database.name.includes('/') ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(binding.database?.role || '') || !binding.objects) throw invalid();
  if (endpoint.protocol !== 'https:' || !hostname(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !['postgres:', 'postgresql:'].includes(connection.protocol) || connection.port && connection.port !== '5432' || connection.hash) throw invalid();
  let dbName, role;
  try { dbName = decodeURIComponent(connection.pathname.slice(1)); role = decodeURIComponent(connection.username); }
  catch { throw invalid(); }
  if (connection.hostname !== binding.database.host || dbName !== binding.database.name || role !== binding.database.role || !connection.password ||
      c.endpoint !== binding.objects.endpoint || c.bucket !== binding.objects.bucket || c.region !== binding.objects.region ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket) || c.bucket.includes('..') || !/^[a-z]{2}-[a-z]+-\d+$/.test(c.region)) throw invalid();
  // URI overrides must not redirect a pinned host/role/database or change the
  // session's search_path. SSL convenience options are replaced by strict TLS.
  const sslOptions = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'];
  if ([...connection.searchParams.keys()].some((key) => !sslOptions.includes(key) && key !== 'channel_binding')) throw invalid();
  // pg URL SSL parameters override the ssl object. Require certificate checks
  // regardless of a copied provider URI's sslmode=require convenience option.
  for (const key of sslOptions) connection.searchParams.delete(key);
  return { binding, poolOptions: { connectionString: connection.href, max: 2, connectionTimeoutMillis: 20000, idleTimeoutMillis: 30000,
    application_name: 'gm-ai-worker', options: '-c search_path=pg_catalog,public', ssl: { rejectUnauthorized: true } } };
}

export function assertIndependentCloudBindings(primary, backup) {
  const a = validateCloudConfig(primary).binding;
  const b = validateCloudConfig(backup).binding;
  if (a.projectId === b.projectId || a.branchId === b.branchId || primary.endpoint === backup.endpoint || a.database.host === b.database.host) {
    throw Object.assign(new Error('Backup requires separately reviewed projects and endpoints.'), { code: 'BACKUP_NOT_ISOLATED' });
  }
}

export async function openCloudStores(c, { readOnly = false, makePool = (options) => new pg.Pool(options), makeClient = (options) => new S3Client(options) } = {}) {
  const { binding, poolOptions } = validateCloudConfig(c);
  const pool = makePool(poolOptions);
  try { await verifyRuntimeAccess(pool, { role: binding.database.role, database: binding.database.name, readOnly }); }
  catch (error) { await pool.end(); throw error; }
  const client = makeClient({ endpoint: c.endpoint, region: c.region, forcePathStyle: true, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, maxAttempts: 3 });
  const repository = new PostgresCheckpointRepository({ pool, namespace: 'gm-worker', maxStateBytes: 32 * 1024 * 1024, maxMetadataBytes: 250 * 1024 * 1024, readOnly });
  const ledger = new PostgresObjectLedger({ pool, namespace: 'gm-worker-objects', maxTotalBytes: 2 * 1024 * 1024 * 1024 });
  const objects = new S3ObjectStore({ client, bucket: c.bucket, prefix: 'gm-worker/', ledger, maxObjectBytes: 64 * 1024 * 1024, readOnly });
  return { repository, objects, disconnect: async () => { await pool.end(); client.destroy(); } };
}
