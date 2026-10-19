# Running

This document covers what is needed to run the end-to-end tests, the commands, the services in the stack and their resource limits, the ports exposed to the host, and ways to try the stack by hand.

## Requirements

- Docker Compose (at least ≈ 1.5 GB of free memory in the Docker VM; the services' combined memory limit is 1.25 GB).
- Bun 1.3.14+.
- k6 (optional): if it is missing, the load scenario is skipped and `skipped` is written to the results.
- `127.0.0.1:18080` must be free on the host.

## Commands

In `packages/e2e`:

| Command | Job |
|---|---|
| `bun run test:e2e` | `up` → `RUN_E2E=1 bun test --timeout 900000 src/e2e.test.ts` → `down` **in every case**; returns the test exit code |
| `bun run up` | `docker compose -p repo-e2e up -d --build --wait --wait-timeout 300` |
| `bun run down` | `docker compose -p repo-e2e down -v --remove-orphans` (all data is deleted, volumes included) |
| `bun run typecheck`, `bun run lint` | Type and lint checks |

- A full run takes a few minutes (excluding the image build): the backup scenario waits 11 s twice for the PostgreSQL statistics counters, and the move scenario waits at least 30 s for the placement cache.
- Without `RUN_E2E=1` the tests are skipped.
- The tests run **in order on the same stack state** (tenants provisioned earlier are used by later scenarios). To run a single test, first run `bun run down && bun run up`, then run it together with the scenarios that precede it.
- To re-run the tests while the stack is up: `RUN_E2E=1 bun test --timeout 900000 src/e2e.test.ts` (running `down` + `up` first is recommended; the same tenants are provisioned again).

## Stack

| Service | Image | Memory | Role |
|---|---|---:|---|
| `postgres-0` | postgres:16.15-alpine | 256m | platform database + tenant database `db0` (`shared_buffers=48MB`, `max_connections=60`, `log_lock_waits=on`, `deadlock_timeout=200ms`) |
| `postgres-1` | postgres:16.15-alpine | 256m | tenant database `db1` |
| `pgbouncer` | the local PgBouncer image and config of `@0furkancolak/pgcells` | 32m | `pool_mode = transaction`, `max_prepared_statements = 0` |
| `redis` | redis:7.4-alpine | 64m | no persistence, `maxmemory 48mb`, `noeviction` (BullMQ) |
| `migrate` | `Dockerfile` (oven/bun:1.3.14-slim) | 256m | `bun run --cwd packages/db-multi cli bootstrap` (direct URLs); the tests run CLI commands through this service |
| `app` | same image | 256m | `src/app.ts`, exposed to the host only at `127.0.0.1:18080` |
| `worker` | same image | 128m | `src/worker.ts` |

- The image is built from the repository root (`bun install --frozen-lockfile --production`); `packages/db-multi`, `packages/redis` and `packages/e2e/src` are copied in.
- `app` and `worker` start once `migrate` has finished successfully and PgBouncer and Redis are healthy. The `app` health check is `/health`.
- Folders: `fixtures/` is mounted into the `migrate` service read-only as `/fixtures`, and `.work/` is mounted writable as `/work`. The tests clear `.work/` at the start; the backups, exports and dump parts written by the CLI end up there (not tracked by git).

## Environment variables

| Variable | Service | Value | Meaning |
|---|---|---|---|
| `DATABASE_URLS` | app, worker | `pgbouncer:5432/db0,db1` | Runtime goes through PgBouncer |
| `DATABASE_URLS` | migrate | `postgres-0:5432/app,postgres-1:5432/app` | Management goes direct (session advisory lock) |
| `REDIS_URL` | app, worker | `redis://redis:6379` | |
| `BETTER_AUTH_SECRET` | app, worker | fixed, for tests only | ≥ 32 characters |
| `PLACEMENT_LOCAL_TTL_MS`, `PLACEMENT_TTL_SECONDS` | app, worker | `2000`, `5` | Placement cache; staleness upper bound after a move ≈ 7 s |
| `CRON_INTERVAL_MS` | worker | `3000` | Cron loop interval |
| `POOL_MAX`, `PORT` | app | defaults `5`, `8080` | |

The passwords are for this local stack only.

## Trying the stack by hand

```sh
bun run up

# management command (direct URLs, compose network)
docker compose -p repo-e2e run --rm --no-deps -T migrate bun run --cwd packages/db-multi cli provision kadikoy --size 20
docker compose -p repo-e2e run --rm --no-deps -T migrate bun run --cwd packages/db-multi cli databases

# HTTP (tenant = Host header)
curl -s http://127.0.0.1:18080/ready
curl -s -H 'Host: kadikoy.e2e.test' http://127.0.0.1:18080/users
curl -s -X POST -H 'Host: kadikoy.e2e.test' -H 'content-type: application/json' -d '{"name":"Ada","email":"ada@kadikoy.example"}' http://127.0.0.1:18080/users
curl -s -H 'Host: kadikoy.e2e.test' http://127.0.0.1:18080/where         # the database the tenant resolves to

# database and Redis
docker compose -p repo-e2e exec -T postgres-0 psql -U admin -d app -Atc 'SELECT tenant_id, database_id, status FROM platform.placements'
docker compose -p repo-e2e exec -T redis redis-cli GET g:e2e:cron
docker compose -p repo-e2e logs app worker

# load (if k6 is installed)
k6 run --summary-export results/k6-summary.json k6/load.js   # BASE_URL, READ_TENANT, INSERT_TENANT, RATE, DURATION_SECONDS

bun run down
```

`k6/load.js`: with `constant-arrival-rate`, first `GET /users?limit=20` (`READ_TENANT`, default kadikoy), a 2 s gap, then `POST /users` (`INSERT_TENANT`, default moda; the email is derived from the id); each at `RATE` (default 200) requests/s x `DURATION_SECONDS` (default 10) s.

## Common failures

- **`up` times out / `migrate` fails** — `docker compose -p repo-e2e logs migrate`; usually a previous stack was left running (`bun run down`) or Docker has too little memory.
- **Port 18080 in use** — another process or a previous stack; `bun run down`.
- **Tests fail one by one** — the scenarios depend on the state left by earlier scenarios; run the whole file on a clean stack.
- **Container OOM** — `oomKilled=true` in the `containers.state` field of `results/e2e-latest.json`; increase the Docker VM memory.
