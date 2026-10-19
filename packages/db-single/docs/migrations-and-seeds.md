# Migrations and seeds

Table structure is managed with migration files and initial data with seed files; the ledgers of both (`_migrations`, `_seeds`) live in the application schema. The package ships a single migration: `src/migrations/<time>_auth.sql` (the Better Auth tables, [auth.md](auth.md#tables-and-mappings)); it ships no seeds.

## File format

`src/migrations/<yyyyMMddHHmmss>_<snake_name>.sql` (UTC); ID = the name without `.sql`, order = ID order. **Do not name files by hand** (no made-up round timestamps): `bun run db:generate <name>` writes the real UTC time, updates the `index.gen.ts` list, and refuses to create a file whose prefix is not greater than the last file’s (`MIGRATION_INVALID`; at least 1 s between two files). The name must be snake_case (`USAGE`). The content is a `--up` line + SQL, then a `--down` line + SQL:

```sql
--up
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'));
--down
ALTER TABLE users DROP COLUMN status;
```

- Both markers are required, in this order and once each; content before `--up` (comments included) and any other `--word` line give `MIGRATION_INVALID`. Comments are `-- ` (with a space).
- An empty or comment-only `--down` = irreversible: `migrate-down` gives `MIGRATION_IRREVERSIBLE` without running any DDL.
- The checksum covers the whole file; do not change an applied file or its name (`MIGRATION_DRIFT`), write a new migration.
- `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` must be the **only** statement of its section; it runs outside a transaction, and on retry the existing index is inspected (a different table/uniqueness gives `MIGRATION_DRIFT`, an invalid one is rebuilt, and if it is still invalid, `MIGRATION_INDEX_INVALID`).
- Enum types and data statements are supported; unsupported SQL gives `SQL_UNSUPPORTED` in codegen. Table names are written without a schema.
- `migration create` writes an empty template (`--up\n\n--down\n`); until SQL is written, `codegen` and the DB commands fail (fill it in, or delete the file and run `bun run db:codegen`). `migration create`, `seed create` and `auth generate` exist only in the CLI (they are not exported as functions); `pull` is also available as `pullSchema` in `@0furkancolak/pgcells-single/tools`.

## Applying, rolling back, baseline

```sh
bun run db:status                        # {"schema","applied","pending":[{"id","transactional"}]}
bun run db:migrate --dry-run             # only reads the ledger: no lock, no writes
bun run db:migrate                       # progress events, then {"dryRun": false, "migrations": [...]}
bun run db:rollback [--steps 2 | --to <id>] [--dry-run]   # default: the last 1; --to leaves this ID as the last applied one
bun run cli migration baseline <id>      # marks as applied without running
```

- `migrate` takes the single advisory lock, creates the schema if it does not exist (no privilege is needed for an existing schema, `public` included), writes the runtime timeouts as DB defaults (requires DB ownership; [operations.md](operations.md#what-migrate-writes-to-the-database)), opens the ledger and applies pending migrations in order; each migration’s DDL and its ledger row commit together.
- Management statements are limited to 30 s by default; so that a long statement such as `CREATE INDEX CONCURRENTLY` on a large table does not leave `LOCK_LOST` and an invalid index, pass `--statement-timeout-ms N` (1000–3600000) (`migrate`, `migrate-down`, `seed`, `restore`).
- Only one runner works at a time and it does not wait: a second `migrate`, `migrate-down`, `seed`, `migration baseline` or `restore` immediately gets `MIGRATION_RUNNER_BUSY`. Cancellation (SIGINT/SIGTERM) stops before the next step. **There is no recovery command and no persistent marker:** every step can be retried; after `LOCK_LOST` or `MIGRATION_CANCELLED`, run the same command again.
- The ledger must be a prefix of the package’s list; an unknown, changed, repeated or gapped history is `MIGRATION_DRIFT`.
- Rollback goes from the end of the applied prefix back to older ones; `MIGRATION_NOT_APPLIED` if `--to` is not applied, `USAGE` if `--steps` and `--to` are given together or `--steps` is greater than the applied count; an out-of-range number (`0`, `10001`) is `INVALID_CONFIG`. The `--down` and the deletion of the ledger row commit together.
- **Baseline** writes the pending migrations up to the given ID (inclusive) to the ledger under the lock; `MIGRATION_NOT_PENDING` if the ID is not pending. First it checks that every folded table, column and enum exists in the live schema (`SCHEMA_MISMATCH` if one is missing, nothing is written); it does not compare indexes and constraints.

## Seeds

`src/seeds/<yyyyMMddHHmmss>_<name>.sql` or `.ts`; IDs follow the same rule as migrations.

```sh
bun run db:generate:seed support_user     # empty SQL template;  --ts: a TypeScript seed
bun run db:codegen
bun run db:seed [--dry-run]
```

- A **SQL seed** contains only `INSERT`/`UPDATE`/`DELETE` (otherwise `MIGRATION_INVALID`); a **TS seed** is a default async function that receives `SeedContext = { schema, query, transaction }` (`query` is bound to the schema and takes generated queries; a seed is already in a single transaction).

  ```ts
  import type { SeedContext } from "../management";
  import { createUser } from "../queries/users.gen";

  export default async function supportUser({ query }: SeedContext): Promise<void> {
    await query(createUser, ["Support", "support@example.com"]);
  }
  ```

- Each seed and its ledger row commit in their own transaction; an applied seed does not run again. A changed, unknown or out-of-order applied seed is `SEED_DRIFT`. The checksum of a SQL seed is computed at runtime, that of a TS seed in codegen: **run `bun run db:codegen` after changing a TS seed**.
- A seed requires up-to-date migrations (`MIGRATIONS_PENDING`) and takes the same lock as `migrate`.

## Initial migration from an existing database: `pull`

When moving to a DB that was set up with another tool (e.g. Drizzle), the migration history is not converted: the structure of the live schema is read and a **single** initial migration is written; every later change is a normal migration.

```sh
bun run db:pull                                   # public → src/migrations/<time>_init.sql  (the source schema is a positional argument; there is no --schema)
bun run db:pull legacy --name legacy_init --exclude audit_log
bun run db:codegen
bun run cli migration baseline <init id> --schema legacy   # marks it as applied instead of running it on the existing DB
```

- It only reads the DB (`pg_catalog`). Output: `{ id, path, schema, enums, tables, constraints, indexes, structure, exclude, next }`; `next` tells the baseline command.
- Definitions are PostgreSQL’s `pg_get_constraintdef`/`pg_get_indexdef`/`pg_get_expr` output; schema qualifiers are stripped and long type names are canonicalized (`character varying` → `varchar`). Do not change the file, put changes in a new migration (`structure` in the output is a structure digest: the same structure gives the same digest). `--down` is empty (a rollback would drop all the tables).
- Always left out: `_migrations`, `_seeds`, `drizzle_migrations`; `--exclude table` adds more (repeatable/comma-separated; uppercase or hyphenated names also work).
- **`init` must be the first migration.** The `auth` migration that ships with the package creates `users`, `session` and other tables: if they already exist in the pulled schema, delete `src/migrations/*_auth.sql` before the baseline and run `bun run db:codegen` (the pulled `init` replaces it); if the `users` table differs, also adapt `src/queries/users.sql` and `src/repositories/users/` (`codegen` fails on a column that does not exist). Otherwise the baseline also covers `auth` and gives `SCHEMA_MISMATCH` if its tables are missing. On an empty DB, `init` runs as a normal migration.
- **Unsupported objects** are listed in a single error and no file is written (`PULL_UNSUPPORTED`): views/materialized views, functions, triggers, policies and RLS, orphan sequences, generated columns, composite/domain/range types, partitioned/inherited/foreign/unlogged tables and storage parameters, invalid indexes, exclusion constraints, column collations. Remove the object or write it by hand in a separate migration after the pull; if it is a table of the old application, use `--exclude`. Objects owned by an extension (functions, types, tables) are not written and do not block the pull: install the extension on the target. Enum labels are written as `E'…'`; an enum without labels is not written. Comments, privileges and ownership are not read. If the schema does not exist, `SOURCE_SCHEMA_MISSING`.
