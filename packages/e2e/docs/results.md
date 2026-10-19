# Results

Every end-to-end run writes its measurements to `results/e2e-latest.json` and the summary of the k6 load test to `results/k6-summary.json`. This document describes the fields of the two files, the results measured on the test stack, and the findings that came out of the runs.

## `results/e2e-latest.json`

Written by the `afterAll` step of the test file; it overwrites the previous run.

```json
{ "finishedAt": "…", "results": { "<scenario>": { … } }, "containers": { "stats": [], "state": [], "lockWaits": [] } }
```

Durations are in milliseconds. CLI durations include `docker compose run` + Bun startup (an empty `status` command ≈ 0.5 s).

| Key | Fields |
|---|---|
| `stack` | `readyMs` — time until `/ready` returns 200 at the start of the test |
| `provision` | `kadikoyMs`, `modaMs`, `sisliMs` (CLI), `databases` (output of the `databases` command) |
| `auth` | `signUpMs`, `signInMs` |
| `queue` | `queueToRowMs` (enqueue → row visible in the app), `cronMs` (the cron record reaching the expected counts), `cronTickMs` (duration of one worker loop) |
| `usersImport` | `firstMs`, `againMs` (CLI) |
| `appMigrate` | `splitMs`, `dryRunMs`, `migrateMs`, `rerunMs` (CLI) |
| `backup` | `fullMs`, `incrementalUnchangedMs`, `incrementalChangedMs`, `exportMs`, `restoreMs` (CLI; in the current code the incremental set includes an 11 s wait for the PostgreSQL statistics counters), `restoredRows`, `notFoundAfterLossMs` (the app falling to 404 after the schema is dropped — placement cache), `servedAfterRestoreMs` |
| `readiness` | `downDetectedMs`, `readyCalls` (status, duration and error code of every `/ready` call), `db0TenantStatus`, `db1TenantStatus`, `db1TenantError`, `db1FirstRequestMs`, `db1SecondRequestMs`, `readyAfterStartMs`, `db1TenantRecoveredMs` |
| `move` | `moveResult` (the move record: `status`, `phase`, `fingerprint` …), `cliBaselineMs` (empty CLI command), `moveCliMs`, `refreshAfterMoveMs` (the app switching to db1 after the CLI finishes), `placementCacheWaitMs`, `cacheBoundMs` (the documented staleness upper bound `localTtlMs + ttlSeconds`), `rowsBeforeMove`, `rowsAfterMove`, `readsDuringMove` (HTTP status → count), `sinceMoveMs` |
| `restart` | `pgbouncerRecoveryMs`, `failedRequestsDuringPgbouncerRestart`, `redisDownWarmMs`, `redisDownColdMs`, `redisDownInsertMs`, `queueRecoveredAfterRedisStartMs` |
| `k6` | `exitCode`, `requests`, `failedRate`, `p50Ms`, `p95Ms`, `p99Ms`, `maxMs` for `read` and `insert`; `inserted`, `droppedIterations`; `skipped` if k6 is missing |
| `containers.stats` | `docker stats` snapshot at the end of the test: memory / limit and CPU per container |
| `containers.state` | `oomKilled` and `restarts`; both must be `false`/`0` |
| `containers.lockWaits` | Lines in the PostgreSQL logs for lock waits longer than 200 ms (`log_lock_waits`); must be empty |

When reading: `moveCliMs` must be ≥ `placementCacheWaitMs` (the move includes the cache wait); `refreshAfterMoveMs` is expected to be ≤ `cacheBoundMs`; `readsDuringMove` must contain only `200` and `503`.

The `results/e2e-latest.json` in the repository is an 11/11 passing run taken with the current code (including the placement cache wait, the response deadline, the clean-code refactor and telemetry).

## `results/k6-summary.json`

The output of `k6 run --summary-export`. The test reads these metrics (`<route>` = `read` or `insert`):

| Metric | Field | Meaning |
|---|---|---|
| `iterations{route:<route>}` | `count` | Requests sent |
| `http_req_failed{route:<route>}` | `value` | Error rate (0–1); threshold `rate<0.01` |
| `http_req_duration{route:<route>}` | `med`, `p(95)`, `p(99)`, `max` | Latency (ms); the `p(95)<1000` threshold is informational |
| `inserted` | `count` | Number of inserts that returned 201; compared with the row increase in moda |
| `dropped_iterations` | `count` | Requests k6 could not keep up with (if any, there are not enough VUs) |

Tagged sub-metrics only appear in the summary when a threshold is defined for them; that is why `k6/load.js` defines a threshold for each route. Under `thresholds` in the summary, `false` means "threshold not crossed". Under `checks` are the pass/fail counts for `read 200` and `insert 201`.

## Measurement with the current code

2026-09-15 12:24 UTC, same machine; a single full run, 11/11 passed.

| Measurement | Result |
|---|---|
| Tenant provision (CLI) | 0.58–0.65 s |
| Queue → row visible in the app | 106 ms |
| Better Auth sign-up / sign-in | 88 ms / 40 ms |
| users import / app-migrate (CLI) | ≈ 0.5 s |
| backup full / incremental unchanged / incremental changed / export / restore | 0.66 / 11.6 / 11.6 / 0.52 / 0.64 s (the incremental sets include the 11 s statistics wait) |
| App falling to 404 in the disaster simulation | 208 ms |
| db1 down: `/ready` | 503 `DATABASE_UNAVAILABLE`, 1 ms (PgBouncer refused the connection immediately); if PgBouncer waits, the response deadline ≈ 6 s |
| db1 down: request to a db1 tenant | 503 `08P01`, 0–1 ms; db0 tenant 200. In the evening runs of 2026-09-15 PgBouncer waited to connect: `/ready` 503 in 6.08 s, tenant request 504 `DATABASE_TIMEOUT` in 6.07 s |
| `/ready` 200 after db1 comes back | 15.2 s |
| `move` (3,517 rows) CLI duration | 30.7 s (30 s `placementCacheWaitMs` + ≈ 0.2 s move; empty CLI 0.52 s) |
| App switching to db1 after the move | 2 ms |
| Reads during the move | 95 x 200, 472 x 503 (`TENANT_UNAVAILABLE`); no other status, no row loss |
| First successful request after a PgBouncer restart | 11 ms, 0 failed requests |
| Redis down: read from local cache / read after the cache expired / insert | 2 ms / 509 ms / 13 ms; queue job 1.05 s after Redis comes back |
| k6 read 200 rps x 10 s | 2001 requests, 0% errors, p50 1.47 ms, p95 4.19 ms, p99 5.19 ms |
| k6 insert 200 rps x 10 s | 2001 requests, 0% errors, p50 2.70 ms, p95 4.83 ms, p99 6.17 ms; 2001 rows verified |
| Memory (snapshot at the end of the test) | app 131 MiB / 256, worker 69 MiB / 128, postgres 20–22 MiB, pgbouncer 7.5 MiB, redis 12 MiB; no OOM and no restarts |

In the first run with the current code, the `readiness` test failed on the old `< 4 s` expectation for `/ready` (PgBouncer waited and returned 503 at the response deadline of ≈ 6 s), and because `postgres-1` was not restarted, the next three scenarios failed in a chain. The expectation was corrected to follow the deadline (6.5 s), and the database is now restarted in `finally`.

In two runs after the switch to the auth tables, the same scenario got 504 where it expected 503 for the db1 tenant. The code had not changed (only a route name); this time PgBouncer waited to connect instead of refusing the stopped server, and the request hit the package's response deadline. In the third run the second request got 503 `ERR_POSTGRES_CONNECTION_CLOSED` at 4.07 s. The expectation therefore accepts every answer in the "database down" class (503 — `08P01`, connection closed … — or 504 `DATABASE_TIMEOUT`); the answer must arrive within 6.5 s and the db0 tenants must return 200.

## Earlier measurements

2026-09-15, macOS (10 cores, 16 GB), Docker VM 6 CPU / 2.9 GB; containers of other projects were also running in the same VM. Three full runs (11/11 passed); the table gives ranges. These measurements were taken before the placement cache wait during a move (`placementCacheWaitMs`) and the single-query response deadline were added; the rows affected by those two changes are marked.

| Measurement | Result |
|---|---|
| Tenant provision (CLI) | 0.6–0.9 s |
| Queue → row visible in the app | 106–108 ms |
| Better Auth sign-up / sign-in | 82–111 ms / 42–47 ms |
| users import (3 rows), app-migrate (10 rows) | ≈ 0.5 s (CLI) |
| backup full / incremental unchanged / incremental changed / restore (*) | 0.67–0.91 / 0.54–0.59 / 0.63–1.43 / 0.69–2.0 s; in the current code an 11 s statistics wait is added to the incremental sets |
| App falling to 404 in the disaster simulation (placement cache) | 2.0–4.3 s |
| db1 down: first `/ready` (*) | `READY_TIMEOUT` at the app's 3 s limit (3 times), `DATABASE_UNAVAILABLE` after ≈ 10.2 s |
| db1 down: first / next request to a db1 tenant (*) | 10.3 s (PgBouncer `query_wait_timeout`) / 4–8 ms, 503 `08P01` |
| `/ready` 200 after db1 comes back | 1.0–3.0 s |
| `move` (≈ 1,300–3,500 rows) CLI duration (*) | 0.71–0.77 s; 8.8 s in one run (not reproduced; no lock waits with `log_lock_waits` on). In the current code at least `placementCacheWaitMs` (30 s) is added. |
| App switching to db1 after the move | 0.41–1.9 s (upper bound ≈ 7 s) |
| Reads during the move | all 200 (the stale placement reads from the source; consistent because the writers were stopped) |
| First successful request after a PgBouncer restart | 10–30 ms, 0 failed requests |
| Redis down: read from local cache / read after the cache expired / insert | 1–2 ms / 512–518 ms (`commandTimeout` 500) / 10–34 ms |
| Queue job done after Redis comes back | 0.8–1.0 s |
| k6 read 200 rps x 10 s | 2001 requests, 0% errors, p50 1.2–1.7 ms, p95 4.2–4.6 ms, p99 5.9–9.8 ms |
| k6 insert 200 rps x 10 s | 2001 requests, 0% errors, p50 2.6–2.8 ms, p95 4.8–5.4 ms, p99 6.2–60.7 ms; 2001 rows verified |
| Memory (snapshot at the end of the test) | app 108–141 MiB / 256, worker 69–91 MiB / 128, postgres 21–28 MiB, pgbouncer 2–7 MiB, redis 8–12 MiB; no OOM and no restarts |

(*) Behavior that changed afterwards: `@0furkancolak/pgcells` now applies a `statementTimeoutMs + 1 s` response deadline to a single query (with the default settings, `db.ready()` and tenant queries against a down database return within ≈ 6 s), `move` waits 30 s before copying data, and the incremental backup waits 11 s before reading the change markers.

## Findings

Findings from the first runs and their current status:

| Finding | Status |
|---|---|
| `db.ready()` had no time limit; against a down database behind PgBouncer, the first call and tenant queries waited up to `query_wait_timeout` (10 s), and Bun's default `idleTimeout` (10 s) cut the request off with no response | Fixed: the runtime applies a `statementTimeoutMs + 1 s` response deadline to a single query and to `ready()`. The app still uses `idleTimeout: 30`. |
| `databaseUnavailable` was not exported from the `@0furkancolak/pgcells` entry; the pattern was copied to turn the PgBouncer `08P01` error into a 503 | Fixed: it is exported from `@0furkancolak/pgcells` and the app uses it. |
| `dbMiddleware` did not expose its pool; `ready()`, the placement cache and Better Auth needed a separate pool | Fixed: `dbMiddleware({ database })` uses the application's pool, so the app runs on a single pool. |
| Stale placement: during the move's maintenance phase too, reads come from the source schema via the cached `active` placement; if the writers are not stopped, writes go to the old schema. In the disaster simulation, requests got `42P01` (500) for the duration of the cache | Expected behavior. The move requires the writers to be stopped and now waits longer than the cache duration; the CLI has no `onPlacementChange` hook, and the staleness upper bound is `localTtlMs + ttlSeconds`. |

## 2026-09-15 evening: after statement cancellation and error code normalization

The stack was built from scratch (`bun run test:e2e`), 11/11 scenarios passed (158 s), k6 included.

| Measurement | Result |
|---|---|
| db1 down: `/ready` | 503 `DATABASE_UNAVAILABLE`, 6.59 s (PgBouncer waited to connect; response deadline + cancel wait, limit 7 s) |
| db1 down: two requests to a db1 tenant | 504 `DATABASE_TIMEOUT`, 6.58 / 6.59 s; db0 tenant 200 |
| After db1 comes back | `/ready` 200 in 0.5 s, db1 tenant in 0.5 s |
| PgBouncer restart | recovered in 9 ms, no failed requests |
| Redis down | local hit 1 ms, request with an expired local entry 513 ms, insert 11 ms; queue 1.03 s after Redis comes back |
| k6 200 rps x 10 s | read p50/p95/p99 1.44 / 3.76 / 4.51 ms, insert 2.54 / 4.85 / 8.41 ms; error rate 0, 2000 inserts counted |

Readiness now accepts only 503 `DATABASE_UNAVAILABLE` or 504 `DATABASE_TIMEOUT`; `TENANT_UNAVAILABLE`, `DATABASE_BUSY` or a 503 without a code fails the scenario.
