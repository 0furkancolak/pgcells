# @0furkancolak/pgcells-e2e — end-to-end tests in Docker

Proves that `@0furkancolak/pgcells` and `@0furkancolak/pgcells-redis` behave as they would in production: two PostgreSQL instances, PgBouncer (transaction pooling), Redis, a Bun HTTP application, a queue worker and a one-shot migrate service are brought up with Docker Compose; the tests drive the stack from the host with `docker compose` commands and HTTP. The application processes point `DATABASE_URLS` at PgBouncer, while management (the CLI) goes straight to PostgreSQL.

## Quick start

Requires Docker Compose, Bun 1.3.14+ and (optionally) k6. Run the commands in this directory:

```sh
bun run test:e2e     # up --build --wait → RUN_E2E=1 bun test src/e2e.test.ts → down -v in every case
bun run up           # stack only: app at http://127.0.0.1:18080, Host: <tenant>.e2e.test
bun run down         # containers and volumes are removed
bun run typecheck && bun run lint
```

Without `RUN_E2E=1` the tests are skipped. Measurements go to `results/e2e-latest.json`, the k6 summary to `results/k6-summary.json`.

## Documentation

- [docs/README.md](docs/README.md) — table of contents
- [Running](docs/running.md) — commands, requirements, stack, memory limits, ports, manual testing
- [Scenarios](docs/scenarios.md) — what each test proves and how it checks it
- [Results](docs/results.md) — reading `results/*.json` and the k6 summary, measured results, findings
