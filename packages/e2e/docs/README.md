# @0furkancolak/pgcells-e2e documentation

This package is not a library but a test stack: it runs `@0furkancolak/pgcells` and `@0furkancolak/pgcells-redis` end to end in a production-like Docker Compose environment (PgBouncer transaction pooling, two PostgreSQL instances, Redis, separate app and worker processes, memory limits). It is also a reference application that uses the two packages together: `src/app.ts` (Hono + `dbMiddleware` + Redis placement cache + BullMQ + Better Auth) and `src/worker.ts` (tenant worker + a cron loop built on `createDbScope`).

## Reading order

1. [running.md](running.md) — requirements, commands, the services in the stack, memory limits, ports, environment variables, trying the stack by hand.
2. [scenarios.md](scenarios.md) — what each scenario proves and how it checks it; the app routes and the worker.
3. [results.md](results.md) — the fields of `results/e2e-latest.json` and `results/k6-summary.json`, measured results and findings.

## Related documentation

- [`@0furkancolak/pgcells` documentation](../../db-multi/docs/README.md)
- [`@0furkancolak/pgcells-redis` documentation](../../redis/docs/README.md)
