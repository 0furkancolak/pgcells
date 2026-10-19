# @0furkancolak/pgcells-single documentation

The package root [README](../README.md) gives a short summary and a quick start; the details are here. Imports in the examples use only the package’s public entry points (`package.json` `exports`); `src/__tests__/unit/docs.test.ts` checks the links, the CLI table, the error table and the import paths.

1. [getting-started.md](getting-started.md) — copying, local DB, first migration, first query, a working Hono application.
2. [configuration.md](configuration.md) — `DATABASE_URLS`, `createDb`/`createManagement` options, direct and pooler URLs, timeouts, drivers, deploy.
3. [queries.md](queries.md) — SQL files, codegen, running queries, transactions, the queries/repositories layers, zod tables.
4. [migrations-and-seeds.md](migrations-and-seeds.md) — file format, rollback, baseline, seeds, `pull` from an existing DB.
5. [middleware-and-jobs.md](middleware-and-jobs.md) — `dbMiddleware`, Workers, `createDbScope`, cron/queue.
6. [replicas.md](replicas.md) — replica reads, the degradation policy, `replicas` and `--from-replica`.
7. [auth.md](auth.md) — Better Auth, `auth generate`, imported passwords.
8. [cli.md](cli.md) — every command, options, exit codes, hidden inputs.
9. [operations.md](operations.md) — deploy order, what `migrate` writes, `doctor`, backup/restore.
10. [providers.md](providers.md) — Neon, Supabase, RDS and provider tools.
11. [errors.md](errors.md) — error code → when → what to do.
12. [telemetry.md](telemetry.md) — `onSpan`, OpenTelemetry, Sentry.
13. [from-multi.md](from-multi.md) — the relationship with `db-multi`, what is not here and why.
