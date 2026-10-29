# GM AI Worker cloud persistence foundation

These adapters do not provision resources, choose a paid plan, migrate a live
workspace, or depend on a local directory. The server integration must explicitly
select cloud mode and treat its working directory only as a disposable cache.

## Contract

```js
import {
  PostgresCheckpointRepository, PostgresObjectLedger,
  S3ObjectStore, backupWorkspace, restoreWorkspace
} from './persistence/index.js';

// Schema and grants are prepared separately, with an owner-only connection.
// This pool is the limited runtime role, with no DDL or DELETE privileges.
const repository = new PostgresCheckpointRepository({ pool, namespace: 'studio' });
const ledger = new PostgresObjectLedger({ pool, namespace: 'studio-audio' });
const objects = new S3ObjectStore({ client: s3Client, bucket: privateBucket, ledger });

const checkpoint = await repository.load('goncalo'); // null or {generation,state}
const ref = await objects.put(audioBytes); // {key: sha256, sha256, size}
const generation = await repository.commit('goncalo', checkpoint?.generation || 0, {
  schemaVersion: 1,
  files: {
    'projects/project.json': {kind: 'json', value: project},
    'samples/kick.wav': {kind: 'blob', ...ref}
  },
  runtime: {undo: [], receipts: []}
});
```

The S3 client must use a **private** dedicated bucket and authenticated HTTPS.
For Neon, use path-style addressing, the branch's endpoint and region, and scoped
storage credentials. Neon storage-write also allows DeleteObject; this adapter's
Get/Put-only behavior is not a provider-side no-delete permission. Never expose those credentials in the browser or tool
responses. The adapters do not change bucket access policies. Confirm anonymous
reads fail before enabling production writes.

The server validates a reviewed `CLOUD_BINDING_JSON` mapping before connecting,
then checks the actual database role's least-privilege grants with read-only SQL.
Preparation belongs in a separate owner session; runtime schema initialization
is rejected. See [the preparation and access boundary guide](../../../docs/cloud-access-boundary.md).
`initializeCloudSchema` remains an explicitly invoked test/maintenance helper,
not a server-startup operation. Backup source adapters support `readOnly: true`;
metadata commits and object uploads then fail before any write operation.

`commit` uses an atomic PostgreSQL transaction and generation compare-and-swap.
Generation zero means absent; stale writers receive `CHECKPOINT_CONFLICT`.
Do not silently retry with a newer generation: reload and reconcile the user's
operation. An unknown commit outcome must also be reconciled by reading the cloud
checkpoint, not by assuming a failure means the server did not commit.

The caller uploads every referenced binary before committing metadata and uses
`validateState` before reconstructing cache files. `validateState` rejects path
traversal, absolute paths, file/directory collisions and unsupported file kinds.
Every object read and upload verifies the byte count and SHA-256. Repeated uploads
of the same bytes share one immutable object. A corrupt existing hash key is a
hard error, not an invitation to overwrite it.

## Quotas and failure behavior

Defaults deliberately leave room below the current Neon Free allowance:

| Guard | Default |
| --- | --- |
| One checkpoint | 16 MiB |
| Metadata per repository namespace | 250 MiB |
| Stored binary reservations per object-store namespace | 4 GiB |
| One binary object | 64 MiB |
| Binary object count | 10,000 |

Quotas use conservative application accounting, not provider billing telemetry.
Only use dedicated stores, include all other namespaces/backups when budgeting,
and monitor the provider's actual database/index/history and transfer usage.
The byte budget is protected by a PostgreSQL transaction lock across processes.
Unknown/failed uploads retain their reservations: the server may have accepted
the bytes before the connection failed. Retrying the same hash reuses that
reservation. No automatic pruning, object deletion, plan upgrade or paid
overflow exists in these modules. Free-provider availability/transfer quotas
remain external limits and may cause requests to fail.

## Backup and restore

```js
await backupWorkspace({
  sourceRepository: repository, sourceObjects: objects,
  backupRepository, backupObjects, workspaceId: 'goncalo', backupId: 'before-change-001'
});
await restoreWorkspace({
  backupRepository, backupObjects, targetRepository, targetObjects,
  backupId: 'before-change-001', targetWorkspaceId: 'restore-check-001'
});
```

Use separately credentialed backup metadata and object destinations. A separate
Neon project/root lineage isolates credentials better than a descendant branch;
a second provider additionally protects against loss of the first account or
provider. Distinct JS adapter instances alone do **not** prove infrastructure or
credential isolation. Provisioning/integration must verify the actual endpoints,
project IDs, prefixes and scopes. Keep backup-management credentials out of the
live application where possible.

Backup copies the actual object bytes, verifies the copies, and only then commits
an immutable manifest with the complete checkpoint, source generation, checksum
and object references. PostgreSQL backups alone do not establish an audio backup.
The application does not rely on S3 versioning, lifecycle or replication features.

Restore refuses an existing target checkpoint, checks the manifest, rechecks every
source and restored object, and commits only after all required bytes exist. It
uses one object at a time to bound memory. A failed restore can leave unreferenced
objects and conservative quota reservations, but never a checkpoint pointing to
unverified bytes. A concurrent creation of the target makes the final CAS fail.
Restoration never overwrites an existing workspace or removes its data.

## Validation and deployment gate

`node --test server/test/cloud-repository.test.js` runs transport/failure tests
without external services. They demonstrate algorithm behavior, not a live cloud
backup. An optional integration test uses real PostgreSQL and S3 containers on
the test runner's loopback interface only. It refuses remote provider endpoints
before opening any client. These environment variables must also be supplied:

- `GM_TEST_CLOUD_ALLOW_WRITE=true`
- `GM_TEST_PG_URL`
- `GM_TEST_S3_ENDPOINT`, `GM_TEST_S3_BUCKET`
- `GM_TEST_S3_ACCESS_KEY_ID`, `GM_TEST_S3_SECRET_ACCESS_KEY`
- Optional `GM_TEST_S3_REGION` (default `us-east-2`)

That isolated test creates additive tables and random `gmtest-…` namespaces, uploads only
synthetic bytes, backs up, restores, reloads with a fresh repository, races CAS
writes, and cleans up its own rows and objects. Never point it at valuable or
unapproved data. Missing settings produce an explicit skip. This cleanup test
cannot be used for a Neon validation: provider checks require a separately
authorized, non-destructive procedure.

Before any production migration, additionally prove authenticated/private access,
successful provider writes and recovery after loss of the Render cache, repeat
after a Render restart/redeploy, and open the restored synthetic project in the
DAW. Do not call that cloud persistence validated based only on the fake tests.
