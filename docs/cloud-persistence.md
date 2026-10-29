# GM AI WORKER: private cloud persistence

This branch adds opt-in cloud persistence to the single-user studio. The live
single-user release remains on `main`. Do not switch an existing studio to cloud
mode until its migration, independent backup, restore and restart checks pass.
The upstream GreanTeaDawy repository is unchanged.

## Architecture

PostgreSQL owns a versioned JSONB checkpoint containing the studio's structured
metadata: owner identity and token hashes, projects, instruments, MIDI notes,
patterns, arrangements, effects, named versions, Undo, operation receipts, sample
catalogue/folders, plugin metadata and UI/recorder preferences. It stores references
to private immutable SHA-256 objects for sample audio, exports and plugin binaries.

The local Render directory is a disposable working cache reconstructed from the
checkpoint. It is never a fallback authority. Missing cloud configuration,
unavailable metadata, corruption and an uninitialized workspace fail closed.
An explicitly initialized **new isolated** workspace may start empty. Remove
initialization flags after provisioning; they are not recovery settings.

For this personal single-user workload, requests and WebSocket messages are
serialized. The server prepares files, verifies new object bytes, flushes pending
metadata, then commits a generation compare-and-swap in PostgreSQL. Only after
that commit does it release HTTP/MCP responses and live notifications. Stale
overlapping Render processes stop instead of overwriting one another. An
uncertain commit stops the process; restart reconstructs the authoritative state.
Operation IDs permit retrying edits whose acknowledgements were lost.

This checkpoint design trades simplicity for write amplification: a changed
checkpoint rewrites its metadata. It is suitable for this bounded private studio,
not a high-volume multi-user service. Preferences use revision checks between
tabs, and the toolbar shows unsaved preferences until the server confirms them.
The browser can still display optimistic musical edits while a request is pending;
an open socket alone is not proof that an edit has been stored.

## Free provider and bounds

Provider terms checked on 2026-10-29:

- [Neon Free](https://neon.com/pricing): no card or time-limited trial; currently
  1 GB PostgreSQL and 5 GB object storage per project, 100 CU-hours and 5 GB public
  transfer per month. Keep the organization on **Free**, never Launch/Scale.
- [Free quota behavior](https://neon.com/faqs/free-plan-limits-and-quotas): limits
  block or suspend service rather than adding paid overages. They affect
  availability; free service is not a promise of infinite capacity or an SLA.
- [Object storage](https://neon.com/docs/storage/overview) is available in Frankfurt.
  Buckets must remain private. The app does not rely on S3 versioning or lifecycle
  because these are not enforced by [Neon's S3 subset](https://neon.com/docs/storage/s3-compatibility).

Application defaults leave room below those limits: 32 MiB per checkpoint,
250 MiB logical metadata per repository, 2 GiB reserved objects, 64 MiB per object,
50 MiB HTTP uploads, and 10,000 immutable objects. Failed/ambiguous uploads keep
their quota reservations. There is no automatic deletion, paid overflow or plan
upgrade. Use dedicated projects/buckets, account for backup and history usage,
and check actual provider usage. Transfer and compute exhaustion can temporarily
prevent access even while stored data remains intact. No free provider guarantees
indefinite unchanged terms or availability.

## Server configuration

Keep all existing single-user protection settings. Add these only to the private
server environment; never to a client build, public repository, screenshot or log:

```text
STORAGE_MODE=cloud
CLOUD_WORKSPACE_ID=goncalo
CLOUD_BINDING_JSON=<reviewed non-secret project/branch and endpoint mapping>
CLOUD_DATABASE_URL=<private PostgreSQL URI>
CLOUD_OBJECT_ENDPOINT=<private branch S3 HTTPS endpoint>
CLOUD_OBJECT_BUCKET=<private bucket>
CLOUD_OBJECT_ACCESS_KEY_ID=<scoped storage credential ID>
CLOUD_OBJECT_SECRET_ACCESS_KEY=<scoped storage secret>
CLOUD_OBJECT_REGION=eu-central-1
```

Schema provisioning is a separate manual owner operation, using
`server/src/persistence/schema.sql` and `runtime-grants.sql`.
Runtime rejects `CLOUD_INITIALIZE_SCHEMA=true` and receives only limited table
permissions. Follow [the access boundary guide](cloud-access-boundary.md) for
role preparation, the required binding mapping and the read-only startup check.
`CLOUD_INITIALIZE_EMPTY=true` permits first setup of an empty **test** workspace.
After first setup, disable empty initialization. Production should use a verified restored
checkpoint rather than empty initialization. Preserve `PRIVATE_ACCESS_KEY` across
restarts so the passwordless private-browser cookie remains valid.

Use separate scoped storage credentials per project. Writers require explicit
`storage:read` **and** `storage:write`, with a verified live GET/PUT round trip.
A synthetic provider probe found that write-only allowed PUT but denied GET with
403, despite documentation describing write as including read. The explicit
two-scope credential passed the subsequent synthetic round trip and recovery
from a fresh connection/cache; anonymous object access returned HTTP 403.
This is not evidence of an independent backup or a Render redeploy.
`OBJECT_ACCESS_DENIED` stops the operation;
it never authorizes an upload fallback or a success response.
Neon documents that storage-write also permits object deletion; the application
sends only Get/Put, which does not remove the credential's broader provider-side
rights. Keep independent backups. See [the access boundary guide](cloud-access-boundary.md).
Do not enable Neon Auth, AI Gateway, paid snapshots or paid Render disks.

## Backup and restore

Use a separate private backup project/root with separate credentials. A child
branch under the primary is not sufficient credential isolation. Backups copy
the actual object bytes, verify size and SHA-256, then atomically save an immutable
manifest including the complete checkpoint checksum. They are not just lists of
links to primary objects. This protects against primary-object loss; two projects
in one account do not protect against loss of the whole provider/account.

An online maintenance runner can execute:

```sh
node server/src/cli/cloud-backup.js backup goncalo before-migration-001
node server/src/cli/cloud-backup.js restore restore-check-001 before-migration-001
```

Provide primary settings as `CLOUD_*` and the independent backup settings as
`BACKUP_*`. On restore, `CLOUD_*` identifies the new target. Restore refuses an
existing target, verifies every source and destination object, and only then
commits the restored checkpoint. The CLI prints only IDs, hashes, counts and
verified status. No automatic backup schedule is configured by this branch;
repeat a verified backup before migrations and risky changes, and establish an
online backup schedule before relying on it for ongoing creative work.

## Evidence required before switching the live studio

1. Record the current live project/sample/export inventory and preserve all
   existing data. No empty bootstrap over an existing studio.
2. Verify the actual provider account is Free and bucket access is private;
   unauthorized object reads must fail.
3. Run synthetic uploads, metadata changes, named versions, preferences and MIDI
   export; confirm acknowledged changes from a newly constructed server cache.
4. Back up to the independent destination, restore into an empty target, compare
   all object hashes and project structure, then open the restored project in
   the DAW.
5. Restart and redeploy a dedicated validation service; verify the same IDs,
   revisions, preferences, objects and Undo remain. Recheck private access.
6. Present the results and remaining limitations before a live migration.

Unit tests use explicit doubles. The `cloud-storage` CI job also runs PostgreSQL
and MinIO on a standard GitHub-hosted runner with synthetic data only. It proves
the real database/object protocols and restoration algorithm, **not** durable
Neon service configuration or successful production migration. No user music,
provider secrets or private backup content is uploaded as a CI artifact.

## Musical control boundary

Cloud persistence is priority one. Controlled MCP write permissions, a user pause
switch and the synthetic Portuguese-command House/Tech House 126 BPM validation
remain a separate gate. Existing full-power tokens must not be described as
permission-controlled until that work is complete. Do not import Safe From Harm.

The upstream audio renderer runs Web Audio in the user's browser. Cloud mode
blocks the server's heavy browser jobs and the normal offline renderer; this
does not implement a cloud audio worker. MIDI/metadata editing is lightweight,
but entirely cloud-based audio production/export is not yet validated. Keep
heavy audio tests on online runners, not the personal Mac.
