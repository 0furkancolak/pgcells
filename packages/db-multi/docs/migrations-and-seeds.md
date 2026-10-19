# Migrations and seeds

The table structure is managed with migration files, and the installation and demo data with seed files. This document covers:
- the three migration scopes, the file format and its rules;
- the commands and functions for applying, rolling back, baselining and recovering migrations;
- the install and demo seed profiles, and demo tenant reset;
- producing an initial migration from an existing database (`pull`).

The tenant migrations that ship with the package are `20260915155444_auth.sql` (the Better Auth tables, [auth.md](auth.md#tables)), `20260915155445_user_imports.sql` and `20260916092603_auth_rate_limits.sql` (the database rate limit tables per auth type). At platform scope, in addition to the package's own tables, the panel Better Auth tables are included (`20260916092603_panel_auth.sql`); the only seed is `demo_login` in the demo profile.

## Scopes

The three scopes use the same file format, SQL dialect and drift rule. Files write table names without a schema; the schema is added at compile time.

| Folder (`src/migrations/`) | Where / ledger | Applied by |
|---|---|---|
| `tenant/` | each tenant schema, `<schema>._migrations` | `provisionTenant`, `migrateTenant`, `migrateAll`; rollback `rollbackTenant` |
| `platform/` | db0, `platform._migrations` | `bootstrap` |
| `node/` | every database including db0, `platform._node_migrations` | `bootstrap` |

## File format

The name is `<yyyyMMddHHmmss>_<snake_name>.sql` (UTC); ID = the name without `.sql`; execution order = ID order. Do not name files by hand (no made-up round timestamps like `20260901000000_…`): `bun run db:generate:tenant|platform|node <name>`, `db:generate:seed|seed:demo <name>` for seeds, and `db:pull` write the real UTC time of the moment of creation, update the folder list, and reject it if the prefix is not greater than the last file's (at least 1 s between two files in the same folder). The content is an `--up` line + SQL, then a `--down` line + SQL:

```sql
--up
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'inactive'));

--down
-- The CHECK constraint is dropped together with the column.
ALTER TABLE users DROP COLUMN status;
```

Rules:

- Both markers are required, in this order and once each. Content before `--up` (comments included) and other `--word` lines are rejected (`MIGRATION_INVALID`). Comments are written with `-- ` (with a space).
- A `--down` that is only empty or comments = irreversible: `migrate-down` rejects every selection containing this migration with `MIGRATION_IRREVERSIBLE`, without running any DDL.
- The checksum covers the whole file; do not change an applied file or its name (`MIGRATION_DRIFT`). Write a new migration for a change.
- `CREATE INDEX CONCURRENTLY` (up) and `DROP INDEX CONCURRENTLY` (down) are accepted only at tenant scope and as the **only** statement of the section; the compiler detects it from the statement, there is no manual metadata. It runs outside a transaction; on retry the index of the same name is inspected (`MIGRATION_DRIFT` if it is not the same table and uniqueness, rebuilt if invalid, `MIGRATION_INDEX_INVALID` if still invalid).
- Platform and node migrations run in a single transaction per database.
- Enum types (`CREATE TYPE … AS ENUM`, `DROP TYPE`) and data statements (`INSERT`/`UPDATE`/`DELETE`) are supported. Unsupported SQL gives `SQL_UNSUPPORTED` in codegen.

## Creating and discovery

```sh
bun run db:generate:tenant add_user_phone                       # src/migrations/tenant/<timestamp>_add_user_phone.sql
bun run db:generate:node add_node_setting                       # for platform/node: db:generate:platform, db:generate:node
# write the --up and --down SQL
bun run db:codegen                                              # migration list + src/tables types
```

- The scripts run CLI commands: `db:generate:<scope> <name>` = `bun run cli migration create <name> --scope <scope>`, `db:codegen` = `bun run codegen` (full list: [cli.md](cli.md#package-scripts-db)).
- `migration create` writes the empty template (`--up\n\n--down\n`) and refreshes only that scope's list. It rejects, with `MIGRATION_INVALID`, a creation whose prefix is not greater than the last file's (same second, clock set back). The name must be snake_case (`USAGE`).
- Until SQL is written, the empty template leaves the registry (and the database commands) uncompilable.
- `bun run codegen` writes the `src/migrations/<scope>/index.gen.ts` list for each scope; bundlers and Bun see the same file. `codegen --check` rejects a missing/stale list, a name that does not fit the format, section errors and SQL that cannot be compiled, without needing Docker.
- Commands that produce files (`migration create`, `seed create`, `pull`) are not exported as functions from the package entry points; use them through the CLI. Apart from `pull`, they do not connect to the database.

## Applying

```sh
bun run db:migrate:all                                           # bootstrap (platform/node) + migrate-all
bun run cli bootstrap                                            # platform/node: {"ready":true,"applied":{…}}
bun run cli migration-status kadikoy                             # {"tenantId","databaseId","pending":[{"id","transactional"}]}
bun run cli migrate kadikoy --dry-run                            # {"tenantId","dryRun":true,"migrations":[…]}
bun run cli migrate kadikoy
bun run cli migrate-all                                          # {"succeeded","failed","skipped","incomplete"}
bun run cli migrate-all --db db0,db1 --concurrency 8 --per-db-concurrency 4 --continue-on-error --driver=postgres
```

- `migrateAll` reads tenants in pages per database; if `schema_version` equals the registry length, **no lock, session or query is opened**. Tenants that are not active count as `skipped`.
- By default no new work is taken after the first error; `--continue-on-error` continues with the other tenants. If `failed > 0` or `incomplete: true`, the CLI exit code is 1.
- `--dry-run` only reads the placement and the ledger; no lock, session or write. `db:migrate:all --dry-run` still runs bootstrap (the arguments go to `migrate-all`); for the plan only, use `bun run cli migrate-all --dry-run`.
- Cancellation (SIGINT/SIGTERM in the CLI, `signal` in code) stops taking new work; after `shutdownGraceMs` (10 s) the running jobs are cancelled.
- Transactional DDL and the ledger are committed in the same transaction; `schema_version` advances after the DDL and ledger.
- Only one migration runner runs at a time (`MIGRATION_RUNNER_BUSY`); if there is another operation on the same tenant, `TENANT_BUSY`.
- The ledger must be a prefix of the registry: an unknown, changed, repeated or gapped history gives `MIGRATION_DRIFT`.

## Rolling back

```sh
bun run cli migrate-down kadikoy                    # the last 1 migration (script: bun run db:rollback:tenant kadikoy)
bun run cli migrate-down kadikoy --steps 2
bun run cli migrate-down kadikoy --to 20260915155445_user_imports   # this ID stays as the last applied migration
bun run cli migrate-down kadikoy --steps 2 --dry-run
```

- It runs with the same runner as `migrate`, under the tenant locks and the placement CAS. The selection is the end of the applied prefix and runs newest to oldest. If `--to` is an ID that is not applied, `MIGRATION_NOT_APPLIED`.
- Each `--down` and the deletion of its ledger row are committed in the same transaction. `DROP INDEX CONCURRENTLY` is outside a transaction; if the index no longer exists, on retry only the ledger row is deleted.
- Before any DDL, `schema_version` drops to the number of applied migrations that will remain: a half-finished rollback does not leave the version larger than the ledger, `migrateAll`'s zero-query skip stays correct, and the next migrate raises the version back to the registry length.
- There is no rollback command for the platform and node scopes (the `--down` in those files is documentary).

## Recovering

After a crash a `platform.migration_runner` record may remain; the next migration gives `MIGRATION_RECOVERY_REQUIRED`.

1. Stop competing migration commands.
2. `bun run cli migration-recover` → `{"recovered": true, "next": "Rerun migration; …"}`. It refuses if the previous runner's sessions are still open or a database cannot be reached.
3. Run the migration again; each schema's ledger and concurrent indexes are inspected.

After `LOCK_LOST` (the management connection dropped or stopped responding) and `MIGRATION_CANCELLED` (cancelled), running the same command again is also safe.

## Baseline: marking as applied without running

Used when taking over an existing schema built with another tool. The baseline is usually the `init` migration produced by [`pull`](#initial-migration-from-an-existing-database-pull); for many schemas, [`adopt apply --baseline`](cli.md#adopting-existing-schemas) does the same marking.

```sh
bun run cli migration baseline legacy 20260915180427_init --db db1
```

- Under the migrate locks, it writes the pending migrations up to `migrationId` into the ledger without running them. If the ID is not a pending migration, `MIGRATION_NOT_PENDING`.
- First it looks up every folded table, column and enum in the live schema; if any is missing it stops with `SCHEMA_MISMATCH` without writing to the ledger. It does not compare indexes and constraints: with a baseline produced by `pull`, `adopt plan` compares the whole structure by its digest (`SCHEMA_DRIFT`).
- If there is no placement, it takes over the tenant schema on `--db` (default db0) (the placement is created as `provisioning`; if it does not match it stays that way and can be retried). If the schema does not exist either, `TENANT_NOT_FOUND`.
- At the end `schema_version` is written and the tenant becomes `active`.
- At platform scope: `bootstrap --mark-applied <id> --from-schema <schema>` writes the platform migration produced by `pull` without running it when its turn comes. First the current structure of the `--from-schema` schema in db0 is compared with the migration's structure digest; if different, `SCHEMA_DRIFT` (`SOURCE_SCHEMA_MISSING` if it does not exist), if `--from-schema` is not given `USAGE`, and nothing is written.

## From code

The CLI wraps these functions. The functions do not write to the console, do not use `process.exitCode`, and do not read argv; progress goes through the `report` callback and cancellation through an `AbortSignal`:

```ts
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import {
  bootstrap, createManagement, markMigrationApplied, migrateAll, migrateTenant, migrationStatus, provisionTenant,
  recoverMigrations, resetDemoTenant, rollbackTenant, seedAll, seedTenant,
} from "@0furkancolak/pgcells/management";

const m = createManagement({ driver: postgresDriver }); // DATABASE_URLS: direct URLs
const controller = new AbortController();

await bootstrap(m);                                           // { platform: string[], nodes: { db0: string[], … } }
await provisionTenant(m, "abc", undefined, { size: 20 });     // Placement: the least loaded active database by size; migrations + install seeds
await provisionTenant(m, "xyz", "db1");                       // choosing the database by hand (must be active and must fit)
await provisionTenant(m, "abc-demo", undefined, { demo: true }); // demo_abc_demo; install + demo seeds
await migrationStatus(m, "abc");                              // { tenantId, databaseId, pending: [{ id, transactional }] }
await migrateTenant(m, "abc", { dryRun: true });              // { tenantId, dryRun, migrations: string[] }
const summary = await migrateAll(m, { signal: controller.signal, report: (event) => console.log(JSON.stringify(event)) });
// { succeeded, failed, skipped, incomplete }
await rollbackTenant(m, "abc", { steps: 1 });                 // { tenantId, dryRun, migrations: string[] } (newest to oldest)
await markMigrationApplied(m, "legacy", "20260915180427_init", { databaseId: "db1" });
await recoverMigrations(m);                                   // { recovered: boolean }
await seedTenant(m, "abc", { profile: "install" });           // { tenantId, profile, dryRun, seeds: string[] }
await seedAll(m, { profile: "install" });                     // a summary like migrateAll
await resetDemoTenant(m, "abc-demo");                         // Placement; demo tenants only
await m.close();
```

| Function | Options |
|---|---|
| `bootstrap(m, …)` | `markApplied` (platform migration IDs produced by `pull`; `markedApplied` in the result) |
| `provisionTenant(m, id, dbN?, …)` | `size` (1–100, default 1), `demo`, `signal`, `report` |
| `migrateTenant`, `migrateAll` | `databaseIds`, `concurrency`, `perDatabaseConcurrency`, `continueOnError`, `dryRun`, `signal`, `report` |
| `rollbackTenant` | `steps` or `to`, `dryRun`, `signal`, `report` |
| `seedTenant` | `profile` (`install` default \| `demo`), `dryRun`, `signal`, `report` |
| `seedAll` | `profile` + the `migrateAll` options |
| `resetDemoTenant` | `signal`, `report` |
| `markMigrationApplied` | `databaseId`, `signal`, `report` |

`report` is called with a plain JSON object on every progress event; `signal` is an `AbortSignal`.

## Seeds

There are two profiles: `src/seeds/install/` is applied to every tenant (real and demo) at installation, and `src/seeds/demo/` only to demo tenants. The file name is the same as for migrations (`<yyyyMMddHHmmss>_<snake_name>.sql` or `.ts`); IDs are unique across both profiles, and the order is ID order.

- **A SQL seed** contains only `INSERT`/`UPDATE`/`DELETE` (any other statement is `MIGRATION_INVALID`); table names without a schema are bound to the tenant schema.

  ```sql
  -- Installation data: runs once in each tenant.
  INSERT INTO users (name, email, email_verified) VALUES ('Destek', 'destek@example.com', true) ON CONFLICT (email) DO NOTHING;
  ```

- **A TS seed** exports a default async function and receives `SeedContext`: `{ tenantId, databaseId, schema, query, transaction }`. `query(preparedQuery, values)` is bound to the tenant and accepts generated queries; since the seed already runs in a single transaction, `transaction(work)` works with the same context.

  ```ts
  // src/seeds/demo/20260915155445_demo_login.ts (relative imports in the package's own file)
  import type { SeedContext } from "@0furkancolak/pgcells/management";
  import { createPasswordUser } from "@0furkancolak/pgcells/queries/tenant/auth";

  export const DEMO_PASSWORD = "demo-password";

  export default async function demoLogin({ tenantId, query }: SeedContext): Promise<void> {
    const { hashPassword } = await import("better-auth/crypto");
    await query(createPasswordUser, ["Demo", `demo@${tenantId}.example.com`, await hashPassword(DEMO_PASSWORD)]);
  }
  ```

- **The ledger** is the `_seeds` table in each tenant schema. Each seed and its ledger row are committed in their own transaction; an applied seed does not run again. A changed checksum of an applied seed, or an unknown or out-of-order history, gives `SEED_DRIFT` (it is not re-run).
- The SQL checksum is computed at runtime from the file text, the TS checksum at codegen time: **after changing a TS seed, run `bun run codegen`** (`codegen --check` rejects a stale list).
- Seeds require up-to-date migrations (`MIGRATIONS_PENDING`) and take the same tenant locks as migrate (not the global runner).
- After the migrations, `provisionTenant` runs the install seeds (in a demo tenant, then the demo ones) and only then makes the tenant `active`; when a half-finished provision is retried, it completes the remaining seeds.
- The demo profile on a real tenant gives `DEMO_TENANT_REQUIRED` (`seed-all --profile demo` skips real tenants).

```sh
bun run db:generate:seed:demo demo_users --ts               # src/seeds/demo/<timestamp>_demo_users.ts
bun run db:generate:seed support_user                        # install profile; empty SQL template, codegen/the registry does not compile until DML is written
bun run db:codegen
bun run cli seed kadikoy --dry-run                           # --profile install|demo (default install); script: db:seed:tenant
bun run db:seed:all --profile install --db db0 --continue-on-error
```

## Demo tenants

- `provision <tenant> [dbN] --demo` / `provisionTenant(m, id, dbN?, { demo: true })`: placement `kind = "demo"`, schema `demo_…`, install + demo seeds.
- `demo-reset <tenant>` / `resetDemoTenant(m, id)` only on a demo tenant (`DEMO_TENANT_REQUIRED`), under the same locks and the placement CAS:
  1. the placement must be eligible for reset: the placement of a `migrating` or unfinished move (`move_operation_id`) gives `TENANT_UNAVAILABLE`;
  2. the placement becomes `maintenance` (requests get `TENANT_UNAVAILABLE`); if it is already `maintenance`, it is still invalidated (`onPlacementChange`);
  3. **on every call**, the whole of `placementCacheWaitMs` (default 30 s) is waited so that the placement caches expire;
  4. lock ownership is verified again, `schema_version` 0, ownership is verified again, `DROP SCHEMA … CASCADE` + `CREATE SCHEMA`;
  5. migrations, install + demo seeds, `active`.

  If it is interrupted, run the command again: the retry does not skip steps 2–3 (even if the placement stayed in `maintenance`).
- The example demo seed writes the user `demo@<tenant>.example.com` / `demo-password` to every demo tenant ([auth.md](auth.md#demo-login)).

## Initial migration from an existing database (`pull`)

When moving to a database built with another tool (e.g. Drizzle), the migration history is not converted. The structure of the live schema is read and **one** initial migration is written. Every later change is a normal migration; two migrations remain per scope: `init` and the migration of your changes.

```sh
bun run db:pull chitchat                                   # tenant: the chitchat schema in db0 → src/migrations/tenant/<timestamp>_init.sql
bun run db:pull panel --scope platform --name panel_init   # platform scope
bun run db:codegen
bun run db:generate:tenant repo_db                         # your changes: the second migration
```

- **Reading:** it only reads the database (`pg_catalog`); it does not use `search_path`. `--db dbN` (default db0) selects which database to read from. `init` must be the first migration of the scope: when existing schemas mark it, they also look for the tables of earlier migrations (`SCHEMA_MISMATCH`). The package's tenant migrations (`auth`, `user_imports`, `auth_rate_limits`) must not stay before `init`: if the source database has auth tables, `auth` is deleted, and `user_imports` and (if database rate limiting will be used) `auth_rate_limits` move to the second migration (the migration runbook of the adopting application).
- **Order:** enums → tables (column type, identity and sequence options, default, NOT NULL, PK/UNIQUE/CHECK) → foreign keys and `NOT VALID` constraints → other indexes. Each group is written in name order.
- **Definitions:** they are PostgreSQL's own `pg_get_constraintdef`, `pg_get_indexdef` and `pg_get_expr` output. Schema qualifiers are stripped in the compiler, and long type names are canonicalized (`character varying` → `varchar`, `timestamp(3) with time zone` → `timestamptz(3)`). The result goes through the same compiler and format check as a hand-written file.
- **Structure digest:** two schemas with the same structure give the same text. The `-- @0furkancolak/pgcells pull structure=<sha256> exclude=…` line in the header is the digest of this text. `adopt plan/apply --baseline <init>` reads each schema to be adopted in the same way; if the digest differs, it blocks that line with `SCHEMA_DRIFT` (for example a missing index or column difference between tenants). Do not change the header or the file; changes are written in a new migration.
- **Rollback:** `--down` is empty, because rolling back the initial migration would drop all the tables (`migrate-down` gives `MIGRATION_IRREVERSIBLE`).
- **Left out:** the package's ledgers (`_migrations`, `_seeds`) and the old Drizzle ledger (`drizzle_migrations`) are always left out. `--exclude table` adds to this list (repeatable or comma-separated).
- **Existing database:** `init` is not run, it is marked applied.
  - Tenant `init`: `adopt apply --baseline <init>`, `migration baseline` for a single tenant.
  - Platform `init`: `bootstrap --mark-applied <init> --from-schema <source schema>` (the source schema's structure must be the same as `init`'s structure digest).

  In a new tenant and in an empty installation it runs as a normal migration.
- **Unsupported objects:** all are listed in a single error and no file is written (`PULL_UNSUPPORTED`):
  - views and materialized views, functions, triggers;
  - policies and RLS;
  - sequences not owned by an identity (`serial`, `nextval`), `GENERATED … STORED` columns;
  - composite, domain and range types;
  - partitioned, inherited, foreign and unlogged tables, table storage parameters;
  - invalid indexes, exclusion constraints, column collations;
  - references to a type or table in another schema.

  Remove the object, or write it by hand in a separate migration after the pull; if it is a table of the old application, use `--exclude`. Comments (`COMMENT ON`), privileges and ownership are not read.
- **Output:** `{ id, path, schema, databaseId, enums, tables, constraints, indexes, structure, exclude, next }`. `next` gives the marking command for the existing database.

**Verification (PostgreSQL 16, application):**
1. The application's raw Drizzle migrations were applied to an empty database and read with `pull`.
2. The generated `init`, as the package compiles and binds it, was applied to another schema and read again.
3. The text of the two reads is exactly the same output; the `information_schema`/`pg_catalog` comparison is also equal: tenant 91 tables, 1,205 columns, 302 constraints, 447 indexes, 51 enums (671 statements); panel 19 tables, 260 columns, 42 constraints, 76 indexes, 17 enums (104 statements).

## Common errors

- **`MIGRATION_DRIFT`** — an applied migration file (or its name) was changed. Revert the change and write a new migration.
- **`MIGRATION_INVALID: Timestamp … is not after …`** — two files were created in the same second, or the clock is behind. Wait a second and run it again.
- **`SEED_DRIFT`** — an applied seed was changed, or a TS seed changed and `codegen` was not run. Add a new seed instead of changing an applied one.
- **`MIGRATIONS_PENDING`** — `migrate`/`migrate-all` before running seeds.
- **`MIGRATION_RECOVERY_REQUIRED`** — the previous runner did not shut down cleanly; [Recovering](#recovering).
- **`PULL_UNSUPPORTED`** — the schema has an object that the initial migration cannot express; the message lists all of them ([pull](#initial-migration-from-an-existing-database-pull)).
- **`SCHEMA_DRIFT`** — the schema to be adopted differs from the baseline produced by `pull`; fix the difference or regenerate `init` from the right source.
