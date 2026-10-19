# Scenarios

This document describes the application in the test stack and every scenario in `src/e2e.test.ts`: what it proves, its steps and what it checks. The scenarios run in this order and on the same stack state.

## The application under test

### `src/app.ts`

Hono + `dbMiddleware({ database: db, rootDomain: "e2e.test", placement: placements.loadPlacement })`. A single `createDatabase` pool is shared by the middleware, `ready()`, the Redis placement cache and Better Auth; on SIGTERM the server, the queue, the database and Redis are closed in that order. Bun `idleTimeout: 30`.

| Route | Job |
|---|---|
| `GET /health` | `ok` (compose health check) |
| `GET /ready` | `db.ready()`; on error → `{ ready: false, error: <code> }`: `DATABASE_TIMEOUT` 504, everything else 503 (connection errors are `DATABASE_UNAVAILABLE`) |
| `GET /where` | Node query (`getNodeIdentity`): the database the tenant resolves to |
| `GET /users`, `POST /users`, `GET /users/count`, `GET /users/:id` | Queries on the `users` table compiled at startup with `prepareQuery` (`src/shared.ts`); the `POST` body is `{ name, id?, email? }`, and the email is derived from the id if not given |
| `POST /jobs/users` | `placements.loadPlacement` (unknown tenant 404) → `createTenantQueue(...).add` |
| `/api/auth/*`, `GET /me` | `createTenantAuth` (shared secret, cookie prefix is the tenant ID) + `authTables("user")` (`users`/`session`/`account`/`verification`, uuid identifiers) + `importedPasswords`; the request is rewritten to `https://<tenant>.e2e.test` |

Error code → HTTP: `BAD_REQUEST`/`INVALID_TENANT_ID` 400, `TENANT_NOT_FOUND`/`NOT_FOUND` 404, `23505` 409, `TENANT_UNAVAILABLE`/`DATABASE_UNAVAILABLE`/`DATABASE_BUSY` 503, `DATABASE_TIMEOUT` 504, everything else 500. Other connection errors (`databaseUnavailable`, e.g. PgBouncer `08P01`, `ERR_POSTGRES_CONNECTION_CLOSED`) collapse into the single `DATABASE_UNAVAILABLE` code in the body.

### `src/worker.ts`

- `createTenantWorker("users", …)` writes the user to the tenant schema; `23505` (already written on a retry) counts as success.
- The cron loop (`CRON_INTERVAL_MS`, 3 s): lists the tenants with `createDbScope(db, "").platform`, counts the `users` rows in every `active` tenant with `createDbScope(db, id, placements.loadPlacement).tenant`, and writes the result to Redis (`g:e2e:cron`, 300 s TTL).

### `src/app-migrations/legacy.ts`

`defineAppMigration` for `fixtures/legacy.sql` (pg_dump, COPY): `uyeler` → Better Auth users (a row without an email is skipped), `ogrenciler` → `users` (`into` + `map`: deterministic ID, email derived from the old ID). `dersler` and `kayitlar` have no counterpart and are not migrated.

## Scenario table

| # | Test | What it proves | How it checks |
|---:|---|---|---|
| 1 | provision | Size-based placement and rejection of reserved IDs | CLI `provision kadikoy --size 20` → db0; `moda --size 10` → db1; `sisli` → db1 (lowest `(load + size) / capacity`); `databases` loads db0 = 20 (1 tenant), db1 = 11 (2 tenants); `provision www` exits with code 1 and `TENANT_RESERVED`; kadikoy `/users` 200 |
| 2 | isolation | Tenant data is separate; host validation | The same UUID returns 201 in two tenants and is read back with each tenant's own name, 404 in sisli; a repeat in the same tenant 409; `yok.e2e.test` and the reserved `www.e2e.test` 404 `TENANT_NOT_FOUND`; a different root (`kadikoy.other.test`) and a multi-label host (`a.kadikoy.e2e.test`) 400 `INVALID_TENANT_ID` |
| 3 | Better Auth | Sessions do not cross tenants | Sign-up and sign-in 200 in kadikoy; the cookie is prefixed `kadikoy.session_token=` (tenant ID); `/me` 200 in kadikoy, 401 in moda with the same cookie; sign-in with the same email/password in moda 401 |
| 4 | queue + cron | A queue job writes to the right tenant; `createDbScope` outside HTTP | The job is enqueued (202) → wait until the row shows up in kadikoy, 404 in moda; a job for an unknown tenant 404; the `g:e2e:cron` record was written after the test started and the counts are `{ kadikoy: <HTTP count>, moda: 1, sisli: 0 }` |
| 5 | users import | JSONL import, re-run, sign-in with an imported bcrypt hash | 3 rows (with a bcrypt hash, without a hash, invalid email) → `read 3, invalid 1, created 2`; second run `created 0, updated 0, unchanged 2`; sign-in with the old password 200, wrong password 401, in another tenant 401 |
| 6 | dump + app-migrate | Import from an SQL backup into tenant tables | `dump split` table row counts (2/2/3/4); `--dry-run` writes nothing (the user count does not change); the real run gives `uyeler 1` (the row without an email is skipped: `read 2, skipped 1`), `ogrenciler 3` and the user count +4; a re-run gives all 0; the imported names (including a quoted name) show up in `/users`; sign-in with the bcrypt hash from the dump 200 |
| 7 | backup | Full/incremental set, export, restore rules and disaster recovery | Wait 11 s → `backup --full`: 3 tenants written; incremental set right away: 0 written / 3 unchanged; 3 rows into moda + 11 s → the incremental set writes only moda, the manifest points kadikoy at the full set, the moda row count has grown; `export kadikoy` rows > 0; `restore` onto an active tenant → `TENANT_EXISTS`. Disaster simulation (with psql, not the package API): 5 rows into sisli, `--full --tenants sisli`, the schema and platform records are dropped → wait until the app falls to 404 → `restore sisli /work/backups` placement `active`, the row count comes back exactly |
| 8 | readiness | While one database is down, the other database's tenants keep working | `stop postgres-1` → until `/ready` is 503 `DATABASE_UNAVAILABLE`, every call is only 503 `DATABASE_UNAVAILABLE` or 504 `DATABASE_TIMEOUT` and < 7 s (response deadline: `statementTimeoutMs` 5 s + 1 s margin + scan interval + 0.5 s cancel wait); the db0 tenant (kadikoy) 200, the db1 tenant (moda) gets one of the same two answers on both attempts, < 7 s: 503 `DATABASE_UNAVAILABLE` (PgBouncer refuses or closes the connection: `08P01`, `ERR_POSTGRES_CONNECTION_CLOSED` …, collapsed into this code in the app) or 504 `DATABASE_TIMEOUT` (PgBouncer waits to connect, response deadline); `TENANT_UNAVAILABLE`, `DATABASE_BUSY` or any 503 with a different code is a failure; `start postgres-1` → `/ready` 200 and moda 200. Even if an assertion fails, `postgres-1` is restarted in `finally` so later scenarios do not fail in a chain |
| 9 | move | No data loss when moving under traffic | The writer loop writes for 3 s and stops; while the read loop continues, CLI `move kadikoy db1 --writers-drained` → `status: completed`, duration ≥ 30 s (`placementCacheWaitMs`); wait until the app's `/where` shows db1; reads during the move are only 200 or 503; the writer writes for 3 more seconds with no errors; count = before + everything written, and every ID returns 200 individually; the source schema is **renamed** (fencing): `tenant_kadikoy` no longer exists in db0, a `tenant_kadikoy__moved_<id>` copy holds the row count at the moment of the move, and a raw `INSERT` into the old name fails with `undefined_table` (a stale writer cannot write to the abandoned copy); after the move a queue job also writes to the new database |
| 10 | restart | Resilience to a PgBouncer restart and a Redis outage | `restart pgbouncer` → until requests return to 200, failed requests are counted, then 20 requests 200; `stop redis` → a cached read 200, after 2.5 s (the local placement entry has expired) a read 200 (from the database), an insert 201; `start redis` → enqueue 202 and the job row appears |
| 11 | k6 | Error rate and write correctness under a short load | Skipped if k6 is not installed. 200 rps x 10 s of reads (kadikoy) and inserts (moda); error rate < 1% on both routes; the row increase in moda = k6's successful-insert counter (`inserted`) |

Each scenario accumulates its measurements with `record(...)`; at the end of the test they are written to `results/e2e-latest.json` ([results.md](results.md)).

## What this stack does not verify

Hyperdrive, TLS, real multi-region network latency (the region model is tested against simulated latency in `@0furkancolak/pgcells`, see its regions guide), PgBouncer database/user overrides, Redis Cluster and multi-region Redis, the health checks of a real deployment, and long-running (soak) load. Redis Cluster, multi-region Redis and the soak run are **not done**; they stay on this list until someone runs them. For measurements with large data and many tenants, see the [`@0furkancolak/pgcells` benchmarks](../../db-multi/docs/performance-and-observability.md#benchmark-commands).
