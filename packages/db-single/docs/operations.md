# Operations

Running in production: deploy order, what `migrate` writes to the DB, `doctor`, export/backup/restore and their limits, shutdown. Connection types and timeouts are in [configuration.md](configuration.md), and provider tools in [providers.md](providers.md).

## Deploy order

1. In the deploy step, `bun run db:migrate` with the direct URL (safe on every deploy; `--dry-run` shows the pending ones).
2. Start the application (pooler URL); call `db.ready()` at startup and in `/ready`.
3. On shutdown, `await db.close()`; management code is closed with `management.close()`. The CLI closes by itself; a cancelled run stops before the next step and exits with code 1.

Only one `migrate`/`migrate-down`/`seed`/`migration baseline`/`restore` runs at a time; the second immediately gets `MIGRATION_RUNNER_BUSY` without waiting.

## What `migrate` writes to the database

In addition to the migrations, `migrate` (except `--dry-run`) writes the runtime settings as **DB defaults**:

```sql
ALTER DATABASE <current database> SET statement_timeout = 5000;
ALTER DATABASE <current database> SET lock_timeout = 1000;
ALTER DATABASE <current database> SET client_connection_check_interval = 1000;
```

- **You must be the database owner (or a superuser).** On managed services, run `migrate` with the role that owns the DB; an unprivileged role fails with `42501` (insufficient privilege) before any migration runs, and the runtime timeouts are not written. For the same reason **`restore` also needs the owner role** (below).
- The settings apply to **every** new session of this DB (psql and other applications included; use `SET statement_timeout = 0` for long manual jobs). Backends the pooler opened beforehand keep the old value until they reconnect (`RECONNECT`). `doctor` checks this with `runtime_timeouts`.

## `doctor`

```sh
bun run cli doctor [--pooled-url] [--pgbouncer-url]
```

Read-only; writes `{ ok, checks: [{ target, check, ok, detail }], externalChecks }`, with exit code 1 if any check fails. The `database` target’s checks: `direct_connection`, `string_literals` (`standard_conforming_strings` is on), `runtime_timeouts`, `schema` (exists), `migrations` (the ledger matches the list and nothing is pending; `MIGRATION_DRIFT` is reported as a failure), `pooled_runtime` (`--pooled-url`: the application’s URL goes through a transaction pooler). The `replica_*` checks are in [replicas.md](replicas.md); `global_pool_mode` (`--pgbouncer-url`, target `pgbouncer`) looks for the global `pool_mode` to be `transaction`. A check that cannot be run becomes `inspection` (`ok: false`, the error code only; driver errors may carry credentials). `externalChecks` lists as `unverified` what SQL cannot prove (`pooled_runtime` — shown when `--pooled-url` is given —, PgBouncer’s effective mode, Hyperdrive caching, the deploy environment); verify those by hand.

## Export, backup and restore

```sh
bun run cli export ./export-2026-10-05        # exactly this directory (must not exist)
bun run cli backup ./backups --keep 7         # ./backups/<UTC yyyyMMddHHmmss>; sets older than the latest 7 are deleted
bun run cli restore ./backups                 # the newest completed set (another one with --set <id>); an export directory also works
bun run cli restore ./export-2026-10-05 --schema restored
```

Each run writes a **full** set: `backup.json` (schema shape, server information, table files and row counts; written last, so if it exists the set is complete) and one `<n>.jsonl.gz` per table. `pg_dump` is not needed, and it works on all four drivers; data is read with `row_to_json` from a single `REPEATABLE READ READ ONLY` snapshot. There are no incremental sets. Outputs: `export` `{ dir, tables, rows }`, `backup` `{ id, dir, tables, rows, pruned }`, `restore` `{ restoredFrom, migrationsApplied, rows }`.

### What it covers, what it rejects

It covers **a single schema** (`--schema`, default `public`) (a missing or empty schema gives `UNSUPPORTED_SCHEMA`: “Schema is missing or empty”): ordinary persistent tables and their data, sequences and their state, the schema’s enum types (in label order; enum and enum-array columns, and enum casts in defaults/CHECKs/indexes, are bound to the target schema), column definitions, PK/unique/check/FK/NOT NULL constraints, indexes. It does not cover other schemas, roles, privileges, ownership, comments or the extensions themselves; objects owned by extensions (PostGIS tables, `pg_stat_statements` views) are not counted as application data and are skipped, and on restore the same extensions must be installed on the target (`EXTENSION_MISMATCH`).

A backup is either restored exactly or not taken at all: if there is something it cannot reproduce exactly, `export`/`backup` stops with `UNSUPPORTED_SCHEMA`, **leaves no files** (the temporary directory is deleted) and names the object where it can (the message contains no URL). Rejected:

- relations other than ordinary persistent tables and sequences: views, materialized views, partitioned/foreign/unlogged tables; row level security, storage parameters, inheritance, triggers, rules;
- **user-defined types other than enums (domain, range, composite)**, columns that use an enum from another schema, and functions in the schema (the message names the type/function and the `table.column` that uses it); custom operators, operator classes and collations; custom routines in defaults/constraints/indexes; casts in an index expression/predicate to anything other than built-in types and the copied enums (to an enum of another schema or of an extension) (the index is named);
- column types outside the portable built-in list; cross-schema FKs or sequence ownership; invalid indexes (repair them first);

### Restore

- The target schema must **not exist or must be empty** (a leftover enum/domain type also counts as non-empty; objects owned by extensions do not count); otherwise `SCHEMA_NOT_EMPTY`, and nothing is deleted or overwritten. To restore over existing data, load under another name with `--schema` or drop the old one yourself.
- The schema and data are built **in a single transaction** (an interrupted restore leaves nothing and can be retried); row counts are verified (`RESTORE_MISMATCH`). Definitions are bound to the new schema name. The migration lock is taken.
- The backup’s migration ledger must be a prefix of this code’s list (`MIGRATION_DRIFT`: a backup taken with newer code requires newer code); if the backup is older, the pending migrations are applied after the restore.
- **Restore runs `migrate` after the data transaction commits**, and `migrate` always writes `ALTER DATABASE`: with a role that is not the owner the data is restored but the command exits with code 1 and `42501`; running `restore` again gives `SCHEMA_NOT_EMPTY`. Fix: run `migrate` with the owner role.
- The PostgreSQL major version, encoding/locale/collation and extensions must match (`VERSION_MISMATCH`, `COLLATION_MISMATCH`, `EXTENSION_MISMATCH`). If there is no completed set, `BACKUP_NOT_FOUND`; if a table file or the ledger is missing, `BACKUP_INVALID`.

### Leftover `.partial` directories

Each run writes into `<target>.partial` and renames it when finished; a failed run deletes it itself. A run that is **killed** (SIGKILL, power loss, OOM) cannot delete it, and the leftover now blocks that exact target: the next run to the same target gives `BACKUP_EXISTS` until you delete `<target>.partial` (the message does not write the target name and tells you to delete the `.partial` directory; if the target itself exists it just says “already exists”). For `export <dir>` the target is the directory you chose; for `backup <root>` it is `<root>/<UTC second>`: later runs are not blocked (if a set or leftover exists in that second, the next second is tried, at most three attempts) but the leftover stays, and `--keep` does not delete it (it cannot be told apart from a set being written), so delete it by hand. A second run writing to the same target at the same time gets the same error. A trailing `/` does not change the target. `--keep` does not delete the set written by the same run, even if the clock was set back and it looks the oldest.
