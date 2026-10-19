# Error codes

The package throws errors as `AppError`: `error.code` is stable, `error.message` is for humans and contains no URL or password. Driver and PostgreSQL errors are not `AppError`; `errorCode(error)` reduces all of them to a single code. This document lists when the codes occur and what should be done. Mapping to HTTP status is the application's job ([middleware-and-jobs.md](middleware-and-jobs.md#http-status-mapping-example)).

## Reading the code

```ts
import { AppError, databaseUnavailable, errorCode } from "@0furkancolak/pgcells";
import { createPasswordUser } from "@0furkancolak/pgcells/queries/tenant/auth";

try {
  await db.withTenant(tenantId, (tenant) => tenant.query(createPasswordUser, [name, email, passwordHash]));
} catch (error) {
  errorCode(error);          // AppError → code; PostgreSQL → SQLSTATE ("23505"); connection → "ECONNREFUSED", "CONNECTION_CLOSED" …; unknown → "OPERATION_FAILED"
  databaseUnavailable(error); // SQLSTATE 08xxx, 53xxx, 57P0x or a driver/socket connection error → true
  error instanceof AppError; // whether it is the package's own error
}
```

The CLI writes the error to stderr as `{"error": "<code>", "message": "…"}` and returns exit code 1. The message of errors that are not `AppError` is not written because it may contain credentials ("Operation failed; inspect PostgreSQL availability").

## Common PostgreSQL codes

| Code | When | What to do |
|---|---|---|
| `23505` | UNIQUE violation (the same ID/email) | 409; in a queue retry it can be counted as success |
| `23503` | Foreign key violation | Fix the input or the order of the import steps |
| `23502` | NOT NULL violation; in provision/adoption/restore, a required column that the application added to `platform.tenants` was not supplied (the package message names the column) | The `tenant` option, `--tenant`, or the `tenant` object of the adoption row ([tenants.md](tenants.md#application-fields-on-the-tenant-record)) |
| `42P01` | Table missing (schema deleted, migration missing) | `migrate`; for a lost schema, [restore](operations.md#backup-export-and-restore) |
| `08P01` | PgBouncer could not find a server (the database behind it is down) | 503; in the application reduce it to the single `DATABASE_UNAVAILABLE` code with `databaseUnavailable(error)` ([example](middleware-and-jobs.md#http-status-mapping-example)) |
| `57014` | Server statement timeout | The package gives it as `DATABASE_TIMEOUT` |

## Configuration and usage

| Code | When | What to do |
|---|---|---|
| `INVALID_CONFIG` | Invalid `DATABASE_URLS` (empty, >100, duplicate, `options`/`search_path` parameter), invalid `DATABASE_REPLICA_URLS` (unknown database, duplicate/wrong URL, more than 8 replicas, `--pooled-urls` count); an option out of range; a wrong `dbMiddleware` combination (`database`/`driver`, `rootDomain`/`tenant`); a Better Auth secret < 32 characters or an invalid `rootDomain`; `--db` an unknown database or the tenant outside the selected databases; an invalid PgBouncer admin URL; tenant fields (`tenant`, `--tenant`, adoption row): an unknown/generated column, a package column like `tenant_id` or `created_at`, two keys for the same column, a non-plain value ([tenants.md](tenants.md#application-fields-on-the-tenant-record)); in `@0furkancolak/pgcells-redis`, no `REDIS_URL` or a placement cache duration > 25 s | Fix the field in the message ([configuration.md](configuration.md)) |
| `USAGE` | A CLI argument missing/extra/repeated/unknown; `bootstrap --mark-applied` without `--from-schema`; a file name that is not snake_case; an invalid seed profile, `onConflict`, source name, `reason`; `database set` without options; `--steps`/`--to` invalid; the scaffold target file exists | See the command's usage ([cli.md](cli.md)) |
| `INVALID_TENANT_ID` | The ID does not follow the rules; `Host` is not `<id>.<root>` | 400; [tenants.md](tenants.md#tenant-id-rules) |
| `INVALID_SCHEMA`, `INVALID_IDENTIFIER` | Schema/identifier validation (normally from corrupt stored data) | Inspect the platform record |
| `INVALID_DATABASE_STATE` | A record in the platform table does not fit the schema | A server error; run `doctor` and inspect the record |

## Database and readiness

| Code | When | What to do |
|---|---|---|
| `DATABASE_UNAVAILABLE` | `ready()`, provision, restore, backup: a database cannot be reached | Fix the database/network; 503 |
| `DATABASE_ORDER_CHANGED` | The `DATABASE_URLS` order changed, a registered database dropped from the list, or a position points at a new/empty database | Restore the order; the list only grows at the end |
| `DATABASE_NOT_CONFIGURED` | A registered database has no URL | Add the URL back in its old position |
| `POOLER_REQUIRED` | `ready()`: a database is connected to without a transaction pooler (directly); the message contains only `dbN` | Point `DATABASE_URLS` at a transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive); in an environment that cannot be tested deliberately use `pooler: "assumed"`; 503 |
| `PROVIDER_API_ERROR` | `neon …` commands and `migrate-all --safety-point neon`: the Neon API gave an error or could not be reached; the message carries the status code and Neon's message (the API key is in no message). If it happened after several branches were opened, the message lists the opened branches by name (they are not deleted) | Fix the cause in the message (key, branch limit, history retention period); delete the opened branches from the Neon console |
| `PROVIDER_NODE_NOT_FOUND` | `neon …` commands: a node's host did not match any endpoint in the API key's account; the message contains only `dbN` | Verify that the key belongs to the account hosting the nodes; if it is an organization account, pass `--org <id>` |
| `DATABASE_NOT_REGISTERED` | A database that has not been bootstrapped | `bun run cli bootstrap` |
| `DATABASE_NOT_FOUND` | `dbN` is not in the config or, for `database set`, is not registered | Fix the database identity |
| `DATABASE_CLOSED` | Use after `close()` | Fix the shutdown order |
| `DATABASE_TIMEOUT` | A connection could not be acquired within `statementTimeoutMs`, a statement (`BEGIN`, query, `COMMIT`/`ROLLBACK`, `exec`) was not answered within `statementTimeoutMs + 1 s` (the statement was cancelled, the connection discarded; [details](configuration.md#timeouts-and-cancellation)), or the server timeout | 504; `poolMax`, slow queries, database health |
| `QUERY_NOT_READ_ONLY` | `withTenantRead`/`tenantRead`: a query that is not `readOnly` (a write, `FOR UPDATE`, a data-modifying CTE) was run in the read context; rejected without going to the database | Run the write with `tenant`/`withTenant` ([replicas.md](replicas.md)) |
| `REPLICA_UNAVAILABLE` | With `replicaOnUnavailable: "error"`, there is no healthy replica (down, lag threshold exceeded, or none configured); the message contains only `dbN` | Fix the replica or set the policy to `"primary"`; 503 |
| `REPLICA_CONFLICT` | `--from-replica`: the replica cancelled a long snapshot (recovery conflict: the standby's conflict counter increased) | Try again or take it from the primary; `max_standby_streaming_delay`/`hot_standby_feedback` at the provider ([replicas.md](replicas.md)) |
| `REPLICA_LAG_EXCEEDED` | `--from-replica`: the replica lag exceeded `replicaMaxLagMs` at startup or is unknown, or before a tenant was read the replica could not catch up to the primary's position in that time | Try again when the replica has caught up, or raise the threshold |
| `DATABASE_BUSY` | The pending-work limit per database is full | 503; reduce the load or increase `poolMax` |
| `DIRECT_CONNECTION_REQUIRED` | Management connected through a transaction pooler | Direct URLs in management ([configuration.md](configuration.md#direct-connection-and-pooler)) |
| `CONNECTION_CLOSED`, `OPERATION_FAILED` | `errorCode` fallback codes: connection closed / unrecognized error | Look at the log; a connection error is mostly transient |

## Tenant and placement

| Code | When | What to do |
|---|---|---|
| `TENANT_NOT_FOUND` | No placement | 404 |
| `TENANT_UNAVAILABLE` | The placement is not `active` (provisioning, maintenance, migrating, failed); import/backup/move on a tenant that is not active | 503; try again when the operation finishes, or complete the half-finished operation |
| `TENANT_RESERVED` | provision/restore on a reserved ID | Another ID; or `unreserve` |
| `TENANT_EXISTS` | Reserving an existing tenant; restore onto an active tenant | Restore only builds a missing tenant |
| `TENANT_CONFLICT` | provision again with the same ID but a different database or kind (`--demo`) | Try again with the arguments of the first command |
| `TENANT_BUSY` | Another management operation is in progress on the tenant | Wait for it to finish and try again |
| `SCHEMA_EXISTS` | The ID's schema already exists in a database | Inspect the schema in the database named in the message; an ID has a single schema across all databases |
| `NO_CAPACITY` | No `active` database fits | `database set <dbN> --capacity N`, add a new database, or reduce `--size` |
| `PLACEMENT_CONFLICT` | The placement changed concurrently (CAS) or the tenant was moved after it was targeted | Run the command again |
| `DEMO_TENANT_REQUIRED` | A demo seed or `demo-reset` on a real tenant | Only on tenants created with `--demo` |

## Queries

| Code | When | What to do |
|---|---|---|
| `QUERY_SCOPE` | A query of another scope in this context | The right context ([queries.md](queries.md#scopes)) |
| `INVALID_QUERY` | An object that is not a compiled query | A generated query or `prepareQuery` |
| `TRANSACTION_REQUIRED` | A row lock (`FOR UPDATE`) outside a transaction | `transaction(async (tx) => …)` |
| `NESTED_TRANSACTION` | `transaction` inside a transaction | Use a single transaction |
| `TRANSACTION_CLOSED` | The context was used after `work` finished | Do not carry the context out of `work` |
| `SQL_UNSUPPORTED` | SQL the compiler does not support (codegen or `prepareQuery`) | Simplify the SQL |
| `UNSUPPORTED` | A streaming query or transaction setting in the Better Auth dialect | Change the Better Auth configuration |

## Migrations and seeds

| Code | When | What to do |
|---|---|---|
| `MIGRATION_INVALID` | The file name/section format is broken; a non-DML statement in a seed; the ID order; a seed ID in two profiles | Fix the file ([migrations-and-seeds.md](migrations-and-seeds.md#file-format)) |
| `MIGRATION_DRIFT` | The ledger is not a prefix of the registry (a changed/unknown/gapped history); the concurrent index definition differs; the backup was taken with newer code | Revert the applied file; write a new migration; current code for a restore |
| `SEED_DRIFT` | An applied seed changed or is unknown | Write a new seed; `codegen` after a TS seed |
| `MIGRATION_IRREVERSIBLE` | The selection contains a migration whose `--down` is empty | Cannot be rolled back; a corrective migration going forward |
| `MIGRATION_NOT_APPLIED` | `--to` is an ID that is not applied | Give an applied ID |
| `MIGRATION_NOT_PENDING` | The baseline ID is not a pending migration | Choose the ID with `migration-status` |
| `SCHEMA_MISMATCH` | Baseline: a folded table/column/enum is not in the live schema | Match the schema, then again |
| `MIGRATIONS_PENDING` | A seed requires up-to-date migrations | `migrate` first |
| `MIGRATION_INDEX_INVALID` | The concurrent index is still invalid after being rebuilt | Inspect the index by hand (conflicting data) |
| `MIGRATION_RUNNER_BUSY` | Another migration runner is running | Wait for it to finish |
| `MIGRATION_RECOVERY_REQUIRED` | The previous runner did not shut down cleanly / its sessions are still alive | Stop the competitors → `migration-recover` → again |
| `MIGRATION_CANCELLED` | The operation was cancelled (signal, grace period) | Run the same command again |
| `LOCK_LOST` | The management session dropped/stopped responding or the record ownership changed | Run the same command again |

## Move

| Code | When | What to do |
|---|---|---|
| `MAINTENANCE_REQUIRED` | `--writers-drained` was not given | Stop the writers and try again with the flag |
| `MOVE_UNFINISHED` | The tenant has an unfinished move | `resume-move` or `rollback-move` |
| `MOVE_NOT_FOUND` | The move ID does not exist | Take the ID from the `move` output |
| `MOVE_TERMINAL` | An attempt to resume a rolled-back move | Start a new `move` |
| `SAME_DATABASE` | The tenant is already on the target database | — |
| `TARGET_EXISTS` | The target has a schema of the same name (e.g. a copy left from an old move) | Inspect; run the `DROP SCHEMA … CASCADE` in the message on that database and try again |
| `TARGET_RESERVED` | The target schema is reserved for another move | Complete/roll back that move |
| `ROLLBACK_NOT_ALLOWED` | The database switch has happened or there is no failed move to roll back | `resume-move` |
| `COPY_MISMATCH` | The copy's fingerprint did not match the source's | Verify the writers are stopped and `resume-move` |
| `COPY_FAILED` | Sequence or server information could not be read | Check database access and try again |
| `UNSUPPORTED_MOVE` | The schema has objects other than ordinary tables and sequences | The mover does not support these objects |
| `EMPTY_SCHEMA` | The source schema has no data table | Inspect the schema |
| `VERSION_MISMATCH`, `COLLATION_MISMATCH`, `EXTENSION_MISMATCH` | The source/target (or backup/target) PostgreSQL major version, encoding/locale/collation or extension versions differ | Match the target |

## Adoption and platform move

`adopt plan` reports issues per row as `problems[].code` (it does not throw); `adopt apply` repeats the same check under the lock and marks the row `failed` with the code of the first issue. Fix the reported problems and run `adopt plan` again.

| Code | When | What to do |
|---|---|---|
| `INVALID_TENANT_ID`, `TENANT_RESERVED`, `DUPLICATE_TENANT_ID` | The row's tenant ID does not follow the rules, is reserved, or is repeated in the input | A domain/ID decision, fix the row |
| `DUPLICATE_SOURCE_SCHEMA` | A schema in the same database is in two rows | Fix one of the rows |
| `INVALID_SOURCE_SCHEMA` | The source is not a plain identifier; a system schema, `platform`, `public` or another tenant's schema | Rename to a plain name first |
| `DATABASE_NOT_CONFIGURED` | The row's database is not in `DATABASE_URLS` | Fix the row or the environment |
| `SOURCE_SCHEMA_MISSING` | The source schema does not exist | Check the name |
| `TARGET_SCHEMA_EXISTS` | `tenant_<id>`/`demo_<id>` already exists in a database | Inspect the schema |
| `TENANT_EXISTS` | The tenant has a placement with another schema/database | `status <id>` |
| `SCHEMA_REFERENCED_BY_NAME` | The old schema name appears in a function body/setting, view, default, policy or rule text | Rewrite the listed objects so that the name does not appear |
| `BASELINE_REQUIRED` | The schema to be adopted contains tables/views/sequences and `--baseline` was not given (a tenant activated without a baseline collides with the tables that exist in the package migrations) | Give, with `--baseline`, the tenant migration that corresponds to the live DDL |
| `SCHEMA_DRIFT` | `--baseline` was produced by `pull` and the schema's structure digest differs from the one in the baseline header (or the structure could not be read: `PULL_UNSUPPORTED` in the message); in `bootstrap --mark-applied`, the structure digest of the `--from-schema` schema in db0 differs from the migration's (nothing is written) | Make the schema equal (missing index/column), or accept the difference deliberately and `pull` the baseline again from that schema; to see the difference, `pull` the two schemas into separate folders and compare them |
| `TENANT_EXISTS` | `provision`/adoption: the ID belongs to a `platform.tenants` record without a placement | Do not give the ID to another tenant, or delete the record deliberately |
| `ROLLBACK_NOT_ALLOWED` | `adopt rollback`: the tenant was moved, the placement changed, it has an unfinished move, or the old name is in another schema | Return from a backup, or inspect the conflicting schema |

## Backup

| Code | When | What to do |
|---|---|---|
| `BACKUP_EXISTS` | The `export` target folder exists; a set could not be taken three times in the same second | Another folder; try again after a second |
| `BACKUP_NOT_FOUND` | No completed set / `--set` is missing or incomplete / the tenant is not in the set | Inspect the set list and the manifest |
| `BACKUP_INVALID` | The `tenant.json` format/tenant ID does not match, a table file or the migration ledger is missing | Inspect the backup |
| `RESTORE_MISMATCH` | The restored row count differs from the one in the backup | The transaction was rolled back; inspect the backup and try again |

## Import and auth

| Code | When | What to do |
|---|---|---|
| `IMPORT_CONFLICT` | `onConflict: "fail"` and the email belongs to another user | `skip`/`link` or fix the data |
| `IMPORT_INVALID` | A table that is not in the dump; a target table/column that is not in the tenant | Fix the import module |
| `DUMP_FETCH_FAILED` | `dump fetch`: could not connect to the source database (while reading the server version; including a password with an invalid percent escape) or pg_dump exited with a non-zero code (the last 2000 characters of stderr are in the message). The password is hidden in the message in every case | Check the URL (percent-encoding if the password has a `%`), network/VPN access and Docker; this run's partial file has been deleted, run it again |
| `DUMP_INVALID` | The SQL backup could not be parsed; an old `analysis.json` format | Check the dump; `dump split` again |
| `PULL_UNSUPPORTED` | `pull`: the schema has an object the initial migration cannot express (view, function, trigger, policy/RLS, a standalone sequence, a generated column, a domain/range type, an invalid index, collation, a reference to another schema …; all are listed in the message) | Remove the object, or write it by hand in a separate migration after the pull; if it is a table of the old application, `--exclude table` |
| `UNSUPPORTED_PASSWORD_HASH` | A login with an argon2 hash outside Bun | Do the import with `--auth-runtime workers`; the user resets the password |

## `@0furkancolak/pgcells-redis`

| Code | When | What to do |
|---|---|---|
| `INVALID_QUEUE_NAME` | The queue name is not `[a-z0-9-]` | Fix the name |
| `INVALID_CONFIG` | No `REDIS_URL`; in the placement cache, `ttlSeconds*1000 + localTtlMs > 25000` | [`@0furkancolak/pgcells-redis` documentation](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/README.md) |
