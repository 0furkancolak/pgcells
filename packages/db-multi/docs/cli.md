# CLI reference

`bun run cli <command>` and `bun run tools <command>` run the same entry point; it wraps the management and tool functions and writes the result as JSON. There are also short `db:*` scripts for everyday migration/seed work ([Package scripts](#package-scripts-db)). This document lists the common rules and, for every command, its arguments, options, code equivalent and exit code.

## Common rules

```sh
bun run cli <command> [arguments] [options] [--driver=bun|postgres|pg]
bun run cli help            # or --help, -h; --help after a command also prints help
```

- **Working folder:** `packages/db-multi` (from the root: `bun run db cli <command>`). Bun reads `.env` from this folder.
- **Environment:** `DATABASE_URLS` — direct or session pooling URLs ([configuration.md](configuration.md)). Local commands that produce files do not connect to the database and do not require `DATABASE_URLS`.
- **Driver:** `--driver=` only in the `=` form, once; the default is `bun`.
- **Option format:** `--name value` or `--name=value`. Positional arguments can be written before or after the options (`migration create --scope platform name` = `migration create name --scope platform`); for a valued option that the command accepts, the next argument is its value. An option the command does not accept, a repeated one (except `--rename`, `--exclude`, `--merge`, `--drop-column`), an option without a value, and extra positional arguments are `USAGE`.
- **Number limits:** `--concurrency` ≤ 128, `--per-db-concurrency` ≤ 64, `--steps` ≤ 10000, `--size` ≤ 100, `--capacity` ≤ 1000000, `--keep` ≤ 1000, `--batch-size` ≤ 10000; all ≥ 1.
- **`--db`:** comma-separated unique database identities (`db0,db1`).
- **Output:** the result goes to stdout as JSON. Progress events (`report`) are written before the result as separate JSON documents; the last top-level JSON is the result.
- **Error:** `{"error":"<code>","message":"…"}` to stderr, exit code 1. The message of errors that are not `AppError` is not written (it may contain credentials). Codes: [errors.md](errors.md).
- **Cancellation:** "cancellable" commands stop taking new work on SIGINT/SIGTERM and cancel the running work after `shutdownGraceMs` (10 s); exit code 1. Running the same command again is safe.
- **Exit code:** 0 on success; 1 on error, cancellation or the "incomplete work" cases stated below. An unknown command is 1.

Bulk options (`migrate`, `migrate-all`, `seed-all`): `--dry-run`, `--db db0,db1`, `--concurrency N` (total), `--per-db-concurrency N`, `--continue-on-error`.

The `neon …` commands and `migrate-all --safety-point neon` ask for the Neon API key through **hidden input** (it is not written to argv or env; if there is no terminal, the first line of stdin). `--org` lists projects in a Neon organization if the credential is tied to one.

## Setup and tenants

| Command | Function | Note |
|---|---|---|
| `bootstrap [--mark-applied id,id --from-schema schema]` | `bootstrap(m, { markApplied, fromSchema })` (`@0furkancolak/pgcells/management`) | Platform/node migrations, database identities, runtime settings (`statement_timeout`, `lock_timeout`, `client_connection_check_interval`). The output is `{"ready":true,"applied":{…}}`. Can be run on every deploy. `--mark-applied`: the platform migration produced by `pull` is written to the ledger without being run when its turn comes (an existing database whose objects came by another route; `markedApplied` in the output). An ID that is not in this code or does not carry the `pull` marker is `MIGRATION_NOT_PENDING`; without `--from-schema`, `USAGE`; if the structure of this schema in db0 differs from the migration's structure digest, `SCHEMA_DRIFT` (nothing is written) |
| `status <tenant>` | `m.platform.get(tenant)` | The placement record |
| `provision <tenant> [dbN] [--size 1-100] [--demo] [--tenant JSON]` | `provisionTenant(m, tenant, dbN, { size, demo, tenant })` | Placement selection + schema + migration + seed + activation. Cancellable. `--tenant '{"name":"…","display_name":"…","owner_email":"…"}'`: the application's `platform.tenants` columns, written to the new record in the same statement ([tenants.md](tenants.md#application-fields-on-the-tenant-record)). If it is not a JSON object, `USAGE`; an unknown column or one of the package's columns is `INVALID_CONFIG`; a missing required column is `23502` |
| `reserve <id,id> [--reason text]` | `reserveTenantIds(m, ids, reason)` (`@0furkancolak/pgcells/tools`) | The default reason is `manual` |
| `unreserve <id,id>` | `releaseTenantIds(m, ids)` | `{"released":[…]}` |
| `reserved` | `listReservedTenantIds(m)` | |
| `databases` | `listDatabases(m)` | `status`, `capacity`, `tenants`, `load`, `configured` per database |
| `database set <dbN> [--status active\|draining] [--capacity N]` | `setDatabase(m, dbN, { status, capacity })` | At least one option |

## Migrations and seeds

| Command | Function | Note |
|---|---|---|
| `migration create <name> [--scope tenant\|platform\|node]` | — (CLI only) | Local; an empty `--up`/`--down` file and the scope list |
| `migration-status <tenant>` | `migrationStatus(m, tenant)` | |
| `migrate <tenant> [bulk options]` | `migrateTenant(m, tenant, options)` | Cancellable |
| `migrate-all [bulk options] [--safety-point neon\|supabase] [--org ID]` | `migrateAll(m, options)` | Cancellable. Exit code 1 if `failed > 0` or `incomplete`. `--safety-point` takes a safety point at the provider before the migration and writes the result; if it cannot be taken, the migration does not start ([providers.md](providers.md#provider-tools)) |
| `migrate-down <tenant> [--steps N \| --to <id>] [--dry-run]` | `rollbackTenant(m, tenant, { steps, to, dryRun })` | Cancellable; the default is the last 1 |
| `migration-recover` | `recoverMigrations(m)` | Clears a leftover runner record |
| `migration baseline <tenant> <migrationId> [--db dbN]` | `markMigrationApplied(m, tenant, id, { databaseId })` | Cancellable; `--db` a single database |
| `seed <tenant> [--profile install\|demo] [--dry-run]` | `seedTenant(m, tenant, { profile, dryRun })` | Cancellable; the default is `install` |
| `seed-all [--profile install\|demo] [bulk options]` | `seedAll(m, options)` | Cancellable. Exit code 1 if `failed > 0` or `incomplete` |
| `seed create <name> --profile install\|demo [--ts]` | — (CLI only) | Local; an empty SQL or TS seed file |
| `demo-reset <tenant>` | `resetDemoTenant(m, tenant)` | Cancellable; demo tenants only; takes ≥ 30 s |
| `pull <schema> [--db dbN] [--scope tenant\|platform] [--name init] [--exclude table …]` | — (CLI only) | Only reads the database (default db0). Writes a single initial migration from the structure of an existing schema (`src/migrations/<scope>/<timestamp>_<name>.sql`, the list is updated); the structure digest in the header, `--down` empty. `_migrations`, `_seeds` and `drizzle_migrations` are always left out; `--exclude` adds to them. Objects that cannot be expressed are `PULL_UNSUPPORTED` (all are listed, no file is written); if the schema does not exist, `SOURCE_SCHEMA_MISSING` ([migrations-and-seeds.md](migrations-and-seeds.md#initial-migration-from-an-existing-database-pull)) |
| `auth generate <optionsModule> [--name name]` | — (CLI only) | A tenant migration from the Better Auth difference; if there is no difference, `{"created":false}` ([auth.md](auth.md#schema-change)) |

Details: [migrations-and-seeds.md](migrations-and-seeds.md).

## Operations

| Command | Function | Note |
|---|---|---|
| `replicas` | `replicaReport(m)` | The status and lag of the replicas in `DATABASE_REPLICA_URLS`; exit code 1 if a replica is down or over the threshold ([replicas.md](replicas.md)) |
| `doctor [--pgbouncer-url] [--pooled-urls]` | — (CLI only) | A read-only check; exit code 1 if `ok: false`. `--pgbouncer-url` and `--pooled-urls` take no value: the console URL / runtime URLs (comma-separated, in `DATABASE_URLS` order) are asked through hidden input (not written to argv); if there is no terminal, the first line of stdin is read |
| `move <tenant> <dbN> --writers-drained` | `startMove(m, tenant, dbN, true, onStarted)` | First `{"moveId":"…"}`, then the move record. Takes ≥ 30 s |
| `move-status <moveId>` | `getMove(m, moveId)` | |
| `resume-move <moveId> --writers-drained` | `resumeMove(m, moveId, true)` | |
| `rollback-move <moveId> --writers-drained` | `rollbackMove(m, moveId, true)` | The output is `{"rolledBack":true}` |
| `backup <folder> [--full] [--tenants a,b] [--concurrency N] [--from-replica]` | `backupAll(m, dir, { full, tenants, concurrency, replicaUrls })` | `--from-replica` takes no value: the direct replica URLs (`db0=postgres://…`, comma-separated) are asked through hidden input; the data is from the replica, always a full set ([replicas.md](replicas.md)). Cancellable; the default concurrency is 2. Exit code 1 if there is a tenant error (`failed > 0`) |
| `backup prune <folder> --keep N` | `pruneBackups(dir, keep)` | Local; `{"kept":[…],"removed":[…]}` |
| `neon export-tenant <tenant> <folder> --at TIME [--org ID]` | `exportTenantAt` (`tools/neon`) | Cancellable; writes the export of the tenant at the `--at` moment from temporary Neon branches (does not touch live data). `--at` must be RFC 3339 with a UTC offset (`…Z` or `…+03:00`) and in the past; a time without an offset is not converted to local time, it is rejected |
| `neon stage-copy [--org ID]` | `stageCopy` (`tools/neon`) | Opens a branch from each source branch for a migration trial; the branch id and host are written |
| `export <tenant> <folder> [--from-replica]` | `exportTenant(m, tenant, dir, { replicaUrls })` | Cancellable; for `--from-replica` see the note above; `{"tenantId","dir","tables","rows"}` |
| `restore <tenant> <folder> [dbN] [--set ID] [--size 1-100]` | `restoreTenant(m, tenant, dir, { databaseId, set, size })` | Cancellable; only a missing tenant |

Details: [operations.md](operations.md).

## Adopting existing schemas

| Command | Function | Note |
|---|---|---|
| `adopt plan <rows.jsonl> [--baseline <migrationId>]` | `planAdoption(m, rows, { baseline })` | Read-only. Row: `{"tenantId","schema","databaseId","kind"?,"size"?,"tenant"?}`; the `tenant` object is validated against the real columns with the same rules as `--tenant` (a bad field rejects the whole input with `INVALID_CONFIG` and the row number) and appears in the plan with column names. Each row is `ready`, `alreadyAdopted` or `blocked` with issue codes; a schema containing tables without a baseline is `BASELINE_REQUIRED`. If the baseline was produced by `pull`, each schema to be adopted is read in the same way and if the structure digest differs (or cannot be read) `SCHEMA_DRIFT`. Exit code 1 if there is `blocked` |
| `adopt apply <rows.jsonl> [--baseline <migrationId>] [--manifest <file>]` | `adoptSchemas(m, rows, { baseline })` | Cancellable. Placement `provisioning` (the row's `tenant` fields are written to the new `platform.tenants` record; a missing required column makes the row `failed`/`23502`) → `ALTER SCHEMA … RENAME` → (baseline) → `active`; the checks (including the structure digest) are repeated under the lock; running again is safe. `--manifest` writes the rollback record (overwriting). Exit code 1 if there is a row other than `adopted`/`alreadyAdopted` |
| `adopt rollback <manifest.json>` | `rollbackAdoption(m, manifest)` | Cancellable. The schema goes back to its old name and the placement is deleted; a moved tenant is `ROLLBACK_NOT_ALLOWED`. Exit code 1 if there is an error |


## Data import

| Command | Function | Note |
|---|---|---|
| `users import <tenant> --source name (--file x.jsonl \| --from-url --query SQL) [--on-conflict skip\|link\|fail] [--auth-runtime bun\|workers] [--dry-run] [--batch-size N]` | `importUsers(m, tenant, rows, options)` | Cancellable. `--from-url` takes no value: the source database URL is asked through hidden input (not written to argv); if there is no terminal, the first line of stdin is read |
| `dump split <backup.sql> <folder>` | `splitSqlDump(file, dir)` | Local |
| `dump fetch <output.sql.gz> [--schema name ...]` | — (CLI only) | Local, cancellable; a plain-text backup of a remote PostgreSQL (e.g. staging). The URL is asked through hidden input (no option or environment variable); pg_dump runs in Docker with the server's major version (`--no-owner --no-privileges`), the database is only read. An existing target file or `.partial` is `USAGE` (neither is deleted; the target is created atomically only if absent); a connection or pg_dump error is `DUMP_FETCH_FAILED` (the password is hidden, this run's partial file is deleted). Details: [data-import.md](data-import.md#downloading-a-backup-from-a-remote-database-dump-fetch) |
| `dump scaffold <folder> --name name --source source [--out file.ts]` | — (CLI only) | Local; the default target is `src/app-migrations/<name>.ts`, an existing file is not overwritten |
| `app-migrate <tenant> <folder\|backup.sql> --file <module.ts> [--auth-runtime bun\|workers] [--dry-run] [--batch-size N]` | The module's default `defineAppMigration` function | Cancellable |

Details: [data-import.md](data-import.md).

`migration create`, `seed create`, `pull`, `auth generate`, `dump fetch`, `dump scaffold` and `doctor` are offered only as the CLI; they are not exported as functions from the package entry points. The other functions in the table are in the `@0furkancolak/pgcells/management` (setup, migration, seed) or `@0furkancolak/pgcells/tools` (reservation, database settings, move, backup, import, adoption) entry points and take a `createManagement` instance (`m`) as the first argument.

## Package scripts (`db:*`)

The same names exist in the `package.json` at the root and in `packages/db-multi`; the script at the root runs the one in `packages/db-multi`. Arguments written after the script are appended to the end of the command: `bun run db:generate:tenant add_user_phone`.

| Script | Command it runs |
|---|---|
| `db:pull <schema> [--scope platform] [--name name] [--db dbN] [--exclude table]` | `pull` |
| `db:codegen` | `codegen` (migration/seed lists, query and table types) |
| `db:generate:tenant <name>` · `db:generate:platform <name>` · `db:generate:node <name>` | `migration create --scope tenant\|platform\|node` |
| `db:generate:seed <name> [--ts]` · `db:generate:seed:demo <name> [--ts]` | `seed create --profile install\|demo` |
| `db:generate:auth <optionsModule> [--name name]` | `auth generate` |
| `db:migrate:platform [--mark-applied id --from-schema schema]` | `bootstrap` |
| `db:migrate:tenant <tenant> [bulk options]` | `migrate` |
| `db:migrate:all [bulk options]` | `bootstrap`, then `migrate-all`. The arguments go only to `migrate-all`: `--dry-run` does not prevent bootstrap from running (bootstrap is idempotent); for the plan only, `bun run cli migrate-all --dry-run` |
| `db:rollback:tenant <tenant> [--steps N \| --to id]` | `migrate-down` |
| `db:status:tenant <tenant>` | `migration-status` |
| `db:seed:tenant <tenant> [--profile demo]` | `seed` |
| `db:seed:all [--profile demo] [bulk options]` | `seed-all` |

A typical flow: `db:generate:tenant <name>` → write the SQL → `db:codegen` → `db:migrate:all`; for seeds `db:generate:seed <name>` → DML → `db:codegen` → `db:seed:all`.

## Other scripts

| Script | Job |
|---|---|
| `bun run codegen [--check]` | Query modules, migration/seed lists, table types; `--check` checks without writing (exit code 1 on stale/hand-edited output) |
| `bun run test` | Unit tests (no database) |
| `bun run test:integration` | `RUN_INTEGRATION=1`; `DB_DRIVER=bun\|postgres\|pg\|neon` (default `bun`; `neon` uses the local `wsproxy` service, and Bun SQL for management in the CLI tests), `TEST_POOLED_URLS` (default local PgBouncer). Only on throwaway databases (uses and deletes the `acme`, `globex`, `demo-auth` tenants). The tests delete their own tenants, move records and schemas; `leak-guard.ts` compares the start and end of the run, lists every leftover object and counts the run as failed. |
| `bun run verify:provider [--driver bun\|postgres\|pg\|neon]` | On managed Postgres (Neon, Supabase), measures the pooler check, `ALTER DATABASE SET`, privileges and the server behavior after the deadline; management URLs are `DATABASE_URLS`, runtime URLs through hidden input. It prints only JSON. [providers.md](providers.md) |
| `bun run typecheck`, `lint`, `format` | `tsc --noEmit`, `eslint .`, `eslint . --fix` (except `*.gen.ts`; no separate formatter) |
| `bun run build`, `build:workers` | Bun bundle and Workers dry-run bundling |
| `bun run bench…` | [performance-and-observability.md](performance-and-observability.md#benchmark-commands) |

On every push/PR, CI runs in `packages/db-multi`, in order: `codegen --check`, `typecheck`, `lint`, `test`, `build`, `build:workers`; `docker compose up`, `bootstrap` twice, `doctor` (with the PgBouncer URL and with the postgres.js/pg drivers), demo tenant provision + `seed --dry-run` + `demo-reset` with the CLI, Better Auth drift (`auth generate` → `created: false`), `test:integration` per driver, then the `@0furkancolak/pgcells-redis` tests. CI does not verify Hyperdrive, TLS, real PgBouncer overrides or deployment health; these are in the `externalChecks` list in the `doctor` output.
