# CLI reference

`bun run cli <command>` wraps the management and tool functions and writes the result as JSON. For everyday migration/seed work there are short `db:*` scripts ([below](#package-scripts-db)). `bun run cli --help` (or `help`, `-h`, `--help` after a command) prints the command list. `docs.test.ts` checks that the table below matches exactly the commands the CLI knows.

## Commands

| Command | Usage | What it does |
|---|---|---|
| `migrate` | `[--dry-run] [--schema name] [--statement-timeout-ms N] [--safety-point neon\|supabase] [--org ID]` | Applies pending migrations; creates the schema if it does not exist, writes the runtime timeouts as DB defaults. If migrations are pending, `--safety-point` first takes a rollback point at the provider ([providers.md](providers.md)) |
| `migrate-down` | `[--steps N \| --to ID] [--dry-run] [--schema name] [--statement-timeout-ms N]` | Rolls back the latest migrations (default 1) |
| `migration-status` | `[--schema name]` | Applied count and pending ones (read-only) |
| `migration create` | `<name>` | Empty `--up`/`--down` file `src/migrations/<UTC time>_<name>.sql` and the list; does not connect to the DB |
| `migration baseline` | `<migrationId> [--schema name]` | Marks pending migrations up to the ID as applied without running them |
| `seed` | `[--dry-run] [--schema name] [--statement-timeout-ms N]` | Applies pending seeds (migrations must be up to date) |
| `seed create` | `<name> [--ts]` | Empty SQL (or, with `--ts`, TypeScript) seed file and the list; does not connect to the DB |
| `pull` | `[schema] [--name init] [--exclude table ...]` | Writes a single initial migration from an existing schema (default `public`); then `migration baseline` |
| `export` | `<dir> [--from-replica] [--schema name]` | Writes all data of the schema to a new directory |
| `backup` | `<dir> [--keep N] [--from-replica] [--schema name]` | Writes a full set under `<dir>/<UTC time>`; `--keep N` deletes older ones (for a directory named `prune`, write `./prune`) |
| `backup prune` | `<dir> --keep N` | Keeps the latest N completed sets and deletes older ones (does not touch partial sets); does not connect to the DB |
| `restore` | `<dir> [--set ID] [--schema name] [--statement-timeout-ms N]` | Builds the schema from a backup root or an export directory; the target schema must not exist or must be empty |
| `auth generate` | `<optionsModule> [--name better_auth]` | Writes a migration for the difference in the Better Auth tables (writes nothing if there is no difference) |
| `neon stage-copy` | `[--org ID]` | Neon: creates a branch from the source branch to rehearse a migration |
| `neon export` | `<dir> --at TIME [--org ID] [--schema name]` | Neon: writes the schema as of a past moment to a directory (use `restore` to apply it) |
| `replicas` | | Status and lag of the `DATABASE_REPLICA_URLS` replicas; exit code 1 if one is down or behind |
| `doctor` | `[--pgbouncer-url] [--pooled-url] [--schema name]` | Checks for connection, timeouts, schema, migrations and replicas; exit code 1 if a check fails |

Details: [migrations-and-seeds.md](migrations-and-seeds.md), [operations.md](operations.md), [providers.md](providers.md), [replicas.md](replicas.md), [auth.md](auth.md).

## Common rules

```sh
bun run cli <command> [arguments] [options] [--driver=bun|postgres|pg]
```

- **Working directory:** `packages/db-single` (from the root, `bun run single cli <command>`); Bun reads `.env` from there, and commands that produce files write them under `src/` there.
- **Environment:** `DATABASE_URLS` (direct or session pooling, [configuration.md](configuration.md#direct-and-pooler-url)); `migration create`, `seed create` and `backup prune` do not connect to the DB.
- **Driver:** `--driver=` only in the `=` form and only once; the default is `bun`; the Neon driver is not available in the CLI.
- **Options:** `--name value` or `--name=value`; positional arguments can be written before or after the options. An option the command does not accept, a repeated one (except `--exclude`), an option without a value, or an extra positional argument gives `USAGE`; the message prints only the option name (`Unknown option: --x`) and does not echo the value or the positional argument. `--steps` ≤ 10000, `--keep` ≤ 1000, both ≥ 1; `--statement-timeout-ms` 1000–3600000 (only `migrate`, `migrate-down`, `seed`, `restore`; default 30000, `INVALID_CONFIG` when out of range): the upper time limit of management statements; raise it for long statements such as `CREATE INDEX CONCURRENTLY` on a large table.
- **`--schema`:** the target schema (default `public`), validated without looking at the DB (`x"; DROP`, uppercase, `pg_*` → `INVALID_SCHEMA`). `pull` takes the source schema as a positional argument; `auth generate` does not take `--schema` (the difference is always computed in a temporary schema).
- **Output:** the result goes to stdout as JSON; progress events (`migrate`, `migrate-down`, `seed`, `restore`) are separate JSON documents before the result, and the last top-level document is the result.
- **Errors:** `{"error": "<code>", "message": "..."}` to stderr, exit code 1; only `AppError` messages are written (others may contain credentials: “Operation failed; inspect PostgreSQL availability”). For an unknown command, `Unknown command` and the help go to stderr (without echoing the name), exit code 1. Exit code 1: every error, a failed `doctor` check, `replicas` with `ok: false`, a cancelled run. Codes: [errors.md](errors.md).
- **Cancellation:** `migrate`, `migrate-down`, `migration baseline`, `seed`, `export`, `backup`, `restore`, `neon export`, `auth generate` take no new step on SIGINT/SIGTERM and cancel the running work; after `MIGRATION_CANCELLED`/`LOCK_LOST`, run the same command again.

### Hidden inputs

Secrets never go into argv, the environment or a file, and are never written to the output; these options only mean “ask for the value through hidden input”: `--from-replica` (a single direct replica URL), `--pooled-url` (the application’s runtime URL), `--pgbouncer-url` (the PgBouncer console URL `postgres://.../pgbouncer`) and the Neon API key (`neon stage-copy`, `neon export`, `migrate --safety-point neon`). Ctrl+C/Ctrl+D cancels (`USAGE`); with redirected input the first line is read; a malformed URL error does not contain the value.

## Package scripts (`db:*`)

`db:migrate` (`migrate`), `db:rollback` (`migrate-down`), `db:status` (`migration-status`), `db:seed` (`seed`), `db:generate <name>` (`migration create`), `db:generate:seed <name> [--ts]` (`seed create`), `db:generate:auth <module>` (`auth generate`), `db:pull [schema]` (`pull`), `db:codegen` (`bun src/core/sql/codegen.ts`, `--check` for CI), `verify:provider` ([providers.md](providers.md#verifyprovider)). Extra arguments are passed through (`bun run db:rollback --steps 2`). From the root: `single:migrate`, `single:rollback`, `single:status`, `single:seed`, `single:generate`, `single:codegen`, `single:pull`; `bun run single <script>` runs any package script, and `bun run single cli <command>` runs any command.
