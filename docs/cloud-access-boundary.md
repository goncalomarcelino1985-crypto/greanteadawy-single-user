# Private cloud access boundary

This is an implementation and manual preparation guide, not confirmation that a
provider account, role, bucket or deployment has been configured. It contains no
real project/branch endpoints or credentials. Do not run the preparation steps
until the dedicated Free project and branch have been reviewed and authorized.
The application needs no Neon account API key, OAuth session or management token.

## Separate preparation from runtime

Use the database owner only in a private maintenance session in the dedicated
application database. Never install owner credentials in Render or CI secrets.

1. Review and execute `server/src/persistence/schema.sql` in that database.
2. In the same private SQL session, set the non-secret target and role names:

   ```sql
   SELECT set_config('gm.provision_database', 'REVIEWED_DATABASE_NAME', false);
   SELECT set_config('gm.runtime_role', 'gm_worker_runtime', false);
   SELECT set_config('gm.reader_role', 'gm_worker_reader', false);
   ```

3. Review and execute `server/src/persistence/runtime-grants.sql`. It refuses a
   mismatched database, an existing privileged role, memberships, and ownership.
   It creates passwordless roles without management privileges; use a secure
   SQL client to set fresh passwords privately afterwards. It does
   not print, store, rotate or obtain passwords.
4. Record the binding below and verify its project/branch mapping against the
   provider's existing metadata. The database's `ep-*` hostname does **not** by
   itself prove the project or branch ID.

The grants script intentionally revokes PUBLIC schema creation, database creation
and temporary-table privileges **inside this dedicated database**. It does not
belong in a shared database. It preserves the separate owner role and grants no
membership in `neon_superuser`, no `CREATEROLE`, no `CREATEDB`, no ownership, and no
privilege to grant privileges onwards. No runtime DDL path exists;
`CLOUD_INITIALIZE_SCHEMA=true` is now rejected before any connection.
Create these roles with the reviewed SQL script: Neon Console/CLI/API role
creation grants membership in `neon_superuser`, which runtime must not receive.
[Neon role creation](https://neon.com/docs/manage/roles)

| Access | Checkpoints | Object quota ledger |
| --- | --- | --- |
| Runtime | SELECT, INSERT; UPDATE of generation/state/state_bytes/updated_at | SELECT, INSERT |
| Backup source reader | SELECT | SELECT |
| Neither role | DELETE, TRUNCATE, schema/table creation or alteration | UPDATE, DELETE, TRUNCATE |

Removing an application file changes the checkpoint manifest; it does not require
SQL DELETE or object DELETE. The ledger's conservative reservations are retained.
A runtime credential can still replace authorized checkpoint contents through
UPDATE; this is why independent backups remain necessary.

At connection time, a read-only PostgreSQL privilege inspection checks the actual
role, database, memberships, ownership, required reads/writes and forbidden
DDL/destructive grants. Missing tables, excessive grants and unverified access
fail closed. The application fixes `search_path` to `pg_catalog,public`; URL
parameters cannot override the host, role, database or session options, and
certificate verification remains mandatory. This check is not a security audit
of arbitrary extra objects in a shared database; use the dedicated database.

## Reviewed binding without secrets

Set `CLOUD_BINDING_JSON` to a compact JSON representation of this reviewed mapping.
Replace every placeholder; these values are intentionally not a live destination:

```json
{
  "projectId": "PROJECT_ID",
  "branchId": "PROJECT_BRANCH_ID",
  "database": {
    "host": "REVIEWED_DATABASE_HOST",
    "name": "REVIEWED_DATABASE_NAME",
    "role": "gm_worker_runtime"
  },
  "objects": {
    "endpoint": "https://REVIEWED_BRANCH_OBJECT_ENDPOINT",
    "bucket": "REVIEWED_PRIVATE_BUCKET",
    "region": "eu-central-1"
  }
}
```

Keep `CLOUD_DATABASE_URL`, `CLOUD_OBJECT_ENDPOINT`, `CLOUD_OBJECT_BUCKET`,
`CLOUD_OBJECT_REGION`, `CLOUD_OBJECT_ACCESS_KEY_ID` and
`CLOUD_OBJECT_SECRET_ACCESS_KEY` in the private server environment. The connection
host, database, role, complete object endpoint, bucket and region must match the
reviewed mapping exactly. The mapping is an operator-reviewed allowlist, not
cryptographic proof of provider identity; it cannot independently inspect a Neon
project or credentials' real scopes. Changes of endpoint/role/branch require a
new reviewed binding. Do not copy obsolete bindings or credentials.

`CLOUD_INITIALIZE_EMPTY=true` remains an explicit, separate switch only for a
reviewed empty synthetic workspace. It grants no database privileges and creates
no schema. Normal runtime should load a previously verified checkpoint.

## Object permissions and their limit

The adapter sends only authenticated `GetObject` and `PutObject` requests to its
configured bucket/prefix. It does not send deletion, bucket-creation, ACL,
management, lifecycle or versioning requests. Reader adapters reject uploads
before any quota reservation or SDK call. Private bucket access must still be
verified against the provider before live use.

Neon's documented `storage:write` scope includes read and **DeleteObject**, and
credentials apply to their anchor branch and descendants. The documented scopes
do not provide a Put-only, no-delete credential or a bucket/prefix restriction.
The application's Get/Put-only behavior therefore does not revoke the credential's
provider-side deletion rights. Do not describe this as deletion-proof storage.
Use a credential anchored at the intended branch, a dedicated private project,
server-side secrets and a separately credentialed backup project. No additional
scope or management access is required by this adapter. [Neon authentication](https://neon.com/docs/storage/authentication)

Neon does not enforce stored versioning/lifecycle settings and does not support
S3 ACL/policy writes, so these are not substitutes for independent verified
copies. [Neon S3 compatibility](https://neon.com/docs/storage/s3-compatibility)

## Backup connection roles

`cloud-backup.js` uses the same configuration parser for `CLOUD_*` and `BACKUP_*`,
including each `BINDING_JSON`. For backup, `CLOUD_*` must use the SELECT-only reader
role plus a storage-read credential; `BACKUP_*` uses the destination writer role
and storage-write credential. For restore, `BACKUP_*` is the reader and `CLOUD_*`
is the new target writer. Each binding must name the role actually in that URI.
Keep backup-management credentials out of the running studio.

Both bindings are validated before any connection. The command rejects the same
project or branch ID, the same database host, or the same object endpoint even
when password/role strings differ. Different claimed project IDs alone are not
proof of isolation: review the provider mapping and use genuinely separate
projects/root lineages. A descendant branch is not an independent credential
boundary. The backup command never installs schema or modifies grants.

## Test evidence and remaining gate

Local unit tests use doubles and synthetic values to check endpoint pinning,
TLS/search-path override refusal, privilege rejection, absence of runtime DDL,
secret-safe failures and reader write refusal. The opt-in `cloud-access.test.js`
is restricted to loopback CI PostgreSQL; it creates its own synthetic database
and roles, exercises real CAS/ledger operations and expects permission errors
for DELETE, TRUNCATE, DDL and ledger edits. It cannot target Neon or another remote
service. These tests do not establish any permissions or durability in a user's
cloud project. A separate authorized, non-destructive provider validation is
still required before deployment or migration.

PostgreSQL ownership and PUBLIC/membership grants accumulate independently of
application intent; the prepared role and connection preflight account for those
sources. [PostgreSQL grants](https://www.postgresql.org/docs/current/sql-grant.html),
[PostgreSQL schema security](https://www.postgresql.org/docs/current/ddl-schemas.html)
