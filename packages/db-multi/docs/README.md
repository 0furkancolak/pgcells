# @0furkancolak/pgcells documentation

This folder explains how to use the `@0furkancolak/pgcells` package. The [README](../README.md) at the package root gives only a short summary and a quick start; all the details are here. The imports in the code examples use only the package's public entry points (`package.json` `exports`).

## Reading order

If you are setting up for the first time, read 1–5 in order; the others are reference documents to consult when needed.

1. [getting-started.md](getting-started.md) — copying into a monorepo, local database, bootstrap, first migration, first query, first tenant and a working Hono application.
2. [configuration.md](configuration.md) — `DATABASE_URLS` rules, runtime and management options (defaults and limits), drivers, PgBouncer/Hyperdrive and direct connections, timeouts, deployment notes.
3. [tenants.md](tenants.md) — tenant ID rules, `tenantFromHost`, schema names, reserved IDs, placement by size/capacity/draining, `db.ready()` errors, the limits of isolation.
4. [queries.md](queries.md) — writing tenant/node/platform SQL, codegen, `withTenant`/`withNode`/`withPlatform`, transactions, scopes, zod table types.
5. [middleware-and-jobs.md](middleware-and-jobs.md) — `dbMiddleware` (including the `database` option), `perRequest` on Workers, cron/queue/Worker `scheduled` with `createDbScope`, the placement cache option.
6. [migrations-and-seeds.md](migrations-and-seeds.md) — creating migrations, the `--up`/`--down` format, migrate/rollback/baseline/recover, install and demo seeds, `pull` from an existing database.
7. [auth.md](auth.md) — Better Auth in tenant schemas, multi-type (user/student/teacher) auth tables (`authTables`, `twoFactorTables`), `createTenantAuth`, `importedPasswords`, schema drift, Workers notes.
8. [operations.md](operations.md) — `doctor`, `move --writers-drained` and waiting for the placement cache, adding and draining databases, backup/export/restore/prune, reserved ID commands, lock and CAS guarantees.
9. [providers.md](providers.md) — Neon, Supabase and Hyperdrive: URL type → role matrix, verifying with `verify:provider`, decisions based on the result, and limits.
10. [replicas.md](replicas.md) — reading from a replica: `withTenantRead`/`tenantRead`, the `readOnly` flag, read after write, fallback policy, lag measurement and limits.
11. [data-import.md](data-import.md) — `users import` (JSONL and SQL sources), `dump split` → `dump scaffold` → `app-migrate` and `defineAppMigration`.
12. [telemetry.md](telemetry.md) — `@0furkancolak/pgcells/telemetry`: OpenTelemetry and Sentry setup (Bun server and Workers), span names and attributes.
13. [performance-and-observability.md](performance-and-observability.md) — the placement cache, dedicated connection and statement cancellation, response deadline, `onSpan`, benchmark commands and measured results.
14. [errors.md](errors.md) — error code → when → what to do table.
15. [cli.md](cli.md) — every command, its arguments, options, function equivalent and exit code.

## Related packages

- [`@0furkancolak/pgcells-redis`](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/README.md) — placement cache, application cache and BullMQ queues in a multi-process setup.
- [`@0furkancolak/pgcells-e2e`](https://github.com/0furkancolak/pgcells/blob/main/packages/e2e/docs/README.md) — end-to-end verification of the packages in a production-like stack in Docker.
