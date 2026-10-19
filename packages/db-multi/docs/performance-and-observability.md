# Performance and measurement

This document covers how the hot path (a request's placement read + tenant query) is kept cheap, the pool and deadline behavior, which steps can be measured with `onSpan`, the benchmark commands, and results measured on local Docker.

## Hot path

### Placement cache

- `withTenant` and the middleware keep the placement in the process for `placementCacheMs` (default 5 s, at most `PLACEMENT_CACHE_MAX_MS` = 25 s). Only `active` records are stored; a hit returns **synchronously** (no Promise). At most 10,000 entries per process.
- After the placement becomes `migrating`/`maintenance`, a move and a demo reset wait `placementCacheWaitMs` (default 30 s) before touching the data: a stale cached record cannot make any process write to the old database of the tenant being moved.
- To invalidate immediately, `db.invalidatePlacement(id)` (e.g. when a Redis broadcast is received). A platform read that started before the invalidation and resolves after it is not written to the cache (a per-tenant counter; at most 10,000 entries, and an entry that overflows also rejects older reads).
- If you already know the placement, `db.withTenant.forPlacement(placement, work)` skips the read entirely. In a multi-process setup, the `@0furkancolak/pgcells-redis` placement cache does this ([placement-cache.md](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/placement-cache.md)).
- `createTenantAuth` in `@0furkancolak/pgcells/auth` reads the placement from the runtime's in-process cache; auth routes make no additional platform query.

### Pool

- There is one bounded pool per database (not per tenant); its size is `poolMax`.
- **Every statement on a dedicated connection:** even a single query reserves a connection; this way the connection of a statement whose deadline has expired can be discarded and is not given to another request together with the running statement. A connection is waited for with the `statementTimeoutMs` deadline (`DATABASE_TIMEOUT`). In a single query, waiting for a connection and the answer share the same deadline record (the record is extended to the answer time once the connection arrives).
- **Per-query extra work is almost nil:** the bound SQL text is stored per query by schema (at most 256 schemas; the schema name is validated on first binding), a parameter array without `Date` is not copied, the driver's result array is not copied, and the `pg` driver adds the connection error listener once per connection, not per borrow. With a fake (networkless) driver, `withTenant.forPlacement` + a single query dropped from 908 ns to 486 ns per call; a raw `pool.query` is 25–28 ns.
- **Pending-work limit:** at runtime 64 pending jobs per database; if exceeded, `DATABASE_BUSY` immediately (the queue does not grow without bound).
- A transaction always reserves a connection and adds `BEGIN … COMMIT`; do not open a transaction for a single query.

### Response deadline

When PgBouncer is left without a server (the database behind it is down), the server `statement_timeout` does not operate and the response does not come until PgBouncer's `query_wait_timeout`. At runtime, if a statement (including `BEGIN` and `COMMIT`) is not answered within `statementTimeoutMs + 1 s`, it is cancelled, the answer is awaited for at most 0.5 s, its connection is discarded and it gives `DATABASE_TIMEOUT` ([details](configuration.md#timeouts-and-cancellation)). There is no per-statement timer: the connection acquisition and answer deadlines share a single timer per database; the timer is set for the record that will expire earliest and under heavy traffic fires at most once per deadline. `db.ready()` returns with the same limit in the identity/record check; the pooler check also carries its own `statementTimeoutMs + 1 s` limit (stored if the result is successful), and with a database that is down the worst case is the sum of these two limits. To reduce connection errors of PgBouncer such as `08P01` to the single `DATABASE_UNAVAILABLE` (503) code, use `databaseUnavailable(error)` (`@0furkancolak/pgcells`).

### Single pool

`dbMiddleware({ database: db, rootDomain })` uses the application's `createDatabase` instance; `ready()`, Better Auth, the placement cache and shutdown all go through the same pool. Giving the middleware a `driver` and also opening a `createDatabase` doubles the database connections.

## Spans (`onSpan`)

```ts
import { createDatabase, type Span } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement } from "@0furkancolak/pgcells/management";

const onSpan = (span: Span) => {
  // { name, startTime, ms, error?, databaseId?, tenantId?, detail? }
  if (span.ms > 50 || span.error) console.log(JSON.stringify(span));
};
const db = createDatabase({ driver: bunDriver, onSpan });
const management = createManagement({ driver: bunDriver, onSpan });
```

If `onSpan` is not given there is no extra cost (not even an additional `await` on the hot path); an error thrown by the handler is ignored. Ready-made handlers for OpenTelemetry and Sentry: [telemetry.md](telemetry.md).

| Span | Where | Meaning |
|---|---|---|
| `placement.read` | runtime | The placement was read from the platform database |
| `placement.cache` | runtime | An in-process cache hit (`ms` = 0) |
| `placement.stale` | runtime | An expired `active` placement served because the directory was unreachable (`staleIfErrorMs`) |
| `db.acquire` | runtime, management | Waiting for a connection from the pool |
| `db.query` | runtime | A single query outside a transaction |
| `db.transaction` | runtime, management | `BEGIN … COMMIT` |
| `tenant.lock` | management | Taking the tenant lock in the platform database |
| `tenant.session` | management | The management session and lock in the tenant database |
| `provision.pick`, `provision.claim`, `provision.schema`, `provision.activate` | management | Provision steps: placement selection, placement record, schema creation, activation |
| `migration` | management | A migration (`detail` = migration ID) |
| `seed` | management | A seed (`detail` = seed ID) |
| `move.maintenance`, `move.copying`, `move.validated`, `move.cutover`, `move.fenced` | management | Move phases (`move.maintenance` includes waiting for the placement cache) |
| `backup.tenant` | management | A tenant's backup (`detail` = `written` / `unchanged`) |

## Benchmark commands

All are for local measurement and CI does not run them. `bench:hotpath` and `bench:spans` use the package's local compose stack (`docker compose up -d --wait`, direct ports 5540/5541, PgBouncer 5543).

```sh
bun run bench:hotpath bun 3 32 7       # <driver> [seconds] [concurrency] [rounds] [query|tx]: raw driver vs withTenant vs forPlacement, median of the rounds
bun run bench:hotpath pg 3 32 7 tx     # tx: BEGIN + point read + COMMIT (raw: reserve + the same three statements)
bun run bench:spans postgres           # [driver]: real operations with onSpan; results/spans-<timestamp>.json
bun run bench:compare                  # ~10 min, low RAM: package vs direct driver, management durations, k6 HTTP
BENCH_RAW_DIR=/tmp/bench-raw bun run bench --phase setup,matrix,repeat,extra,soak   # 10,000 tenants; driver x tier ladders
BENCH_RAW_DIR=/tmp/bench-raw bun run bench:scale --phase tenants                    # migrateAll/seedAll/demo/move (after setup)
BENCH_RAW_DIR=/tmp/bench-raw bun run bench:scale --phase big --sizes 1000000,10000000,100000000
bun run bench:scale --phase big --sizes 1000000000 --tiers T4 --load-tiers T4 --storage /Volumes/<disk>/repo-db-bench-1b
```

- `bench:spans` also takes its URLs from the `DIRECT_URLS` (management) and `DATABASE_URLS` (runtime, PgBouncer) environment variables.
- `bench:hotpath` opens 4 tenants (`hot-a` … `hot-d`) and deletes the platform records and schemas at the end.
- `bench:compare`: 100 tenants + a tenant with 1M rows; durations of the management steps, in-process ms per operation (placement read, first tenant access, direct driver vs package for a read and an insert in a transaction), and with k6 the peak rps over HTTP and the latency at 200 rps. The result is `results/compare-<timestamp>.json`.
- `bench` / `bench:scale`: PostgreSQL (T1 0.25 CPU/256 MB … T4 2 CPU/1.5 GB; `db0` and `db1` in a single container), PgBouncer and the harness run with `docker run --cpus --memory`, and k6 runs on the host. SLO: p95 < 50 ms, errors < 1%. Summaries are `results/<run>-load.json` and `<run>-scale.json` (resume where it left off with `--run <id>`); raw k6 summaries, `docker stats` and PgBouncer samples stay under `BENCH_RAW_DIR`.
- Row generation (`INSERT … SELECT generate_series`) is done server-side with psql and bypasses the package; the provision, query, migration, seed and move jobs that are measured go through the package. Migrations/seeds specific to the benchmark are produced in a temporary copy of the package and are not written to `src/migrations`/`src/seeds`.
- Containers are stopped with `docker stop -t 60`; the volumes are `repo-db-bench-load`, `repo-db-bench-scale` (delete with `docker volume rm`).

The result files are under `results/` in the package's benchmark folder.

## Measured results

### Hot path (`bench:hotpath`)

2026-09-15; 32 concurrent loops in the process x 4 s, point reads through PgBouncer transaction pooling (2 x PostgreSQL 16 + PgBouncer, local Docker), 4 tenants x 1000 rows, `poolMax` 10; the second of two rounds. "Before": every `withTenant` read the placement from the platform database and every single query reserved a connection with a deadline timer. "After": the in-process placement cache and a direct pool query when a connection is idle.

| Driver | Route | Before rps | After rps | After p50 / p99 ms | Ratio to raw driver (before → after) |
|---|---|---:|---:|---:|---:|
| bun | raw driver | 30651 | 30862 | 1.01 / 2.26 | — |
| bun | `withTenant` | 12439 | 28262 | 1.06 / 2.52 | 41% → 92% |
| bun | `forPlacement` | 29026 | 29723 | 1.05 / 2.20 | 95% → 96% |
| postgres | raw driver | 16512 | 16750 | 1.87 / 3.54 | — |
| postgres | `withTenant` | 6999 | 16207 | 1.95 / 3.70 | 42% → 97% |
| postgres | `forPlacement` | 16140 | 16318 | 1.94 / 3.57 | 98% → 97% |
| pg | raw driver | 27019 | 29773 | 1.04 / 2.24 | — |
| pg | `withTenant` | 9850 | 28740 | 1.08 / 2.39 | 36% → 97% |
| pg | `forPlacement` | 23275 | 28577 | 1.08 / 2.37 | 86% → 96% |

Summary: `withTenant` went from 36–42% of the raw driver before the cache to 92–97% after; when the placement is supplied ready-made (`forPlacement`), 96–97%.

**After statement cancellation (current code).** Under the same conditions, the second of two rounds. The direct pool path of the "After" column in the table was removed: even a single query reserves a connection, so that the connection of a statement whose deadline has expired can be discarded ([Timeouts and cancellation](configuration.md#timeouts-and-cancellation)).

| Driver | Raw driver rps | `withTenant` rps (ratio) | `forPlacement` rps (ratio) | `withTenant` p50 / p99 ms |
|---|---:|---:|---:|---:|
| bun | 31593 | 29314 (93%) | 29824 (94%) | 1.04 / 2.53 |
| postgres | 17488 | 16634 (95%) | 16024 (92%) | 1.89 / 3.54 |
| pg | 30193 | 26730 (89%) | 26998 (89%) | 1.14 / 2.74 |

The ratio to the raw driver is in the same range as the previous measurement for bun and postgres; for pg it fell from 96–97% to 89% (`pool.connect` + `release` on every query).

**After the hot path simplification (current code, 2026-09-16).** The same stack and data; 32 concurrent loops x 3 s, the routes in order in every round, 7 rounds. The ratio is the median of the ratios to the raw driver in the same round (fluctuation on the machine affects both routes together; the raw driver itself varied between 18,000 and 31,000 rps from run to run). "Before": measured in the same session with the changes reverted. The changes: a single shared deadline timer (no `setTimeout` per statement), a combined connection + answer deadline in a single query, fewer intermediate Promises in the context, the bound SQL cache, copy-free parameter and result arrays, a per-connection error listener on `pg`.

| Driver | `withTenant` / raw (before) | `withTenant` / raw (after) | After: raw rps | After: `withTenant` rps | After: `withTenant` p50 / p99 ms |
|---|---:|---:|---:|---:|---:|
| bun | 91% | 95% | 28075 | 26188 | 1.15 / 3.03 |
| postgres | 92% | 100% | 13995 | 14337 | 2.20 / 4.44 |
| pg | 91% | 100% | 30978 | 30060 | 1.00 / 2.68 |

`forPlacement` after is 93–97%. The remaining difference is at the level of measurement noise. On bun the ceiling is Bun SQL itself: under the same conditions a raw `sql.reserve()` + query is 95% of a raw pool query (to be able to discard a connection whose deadline has expired, the package runs every statement on a dedicated connection; since Bun offers no reliable cancellation, switching to a pool query would break this guarantee).

**Over HTTP (k6, `compare-2026-09-16T12-11-03Z`, T3, 64 VU x 15 s, a single run).** The package / raw driver ratio of peak rps; in parentheses the 2026-09-15 run (old code). The same raw driver route also rose by 16–138% between the two runs, so +/-10% of a single run is noise (like pg's cached read coming out at 117%).

| Driver | Point read | Cached read | Insert |
|---|---:|---:|---:|
| bun | 96% (60%) | 98% (86%) | 99% (72%) |
| postgres | 98% (66%) | 99% (77%) | 77% (70%) |
| pg | 89% (59%) | 117% (79%) | 99% (70%) |

**Transaction (`tx`, 2026-09-16, 7 rounds).** `withTenant` is 94% of the raw driver on bun, 92% on postgres, and 95–96% on pg (an A/A trial on pg, i.e. comparing the raw route against itself, came out at 100%; the difference is real and varies +/-3% from round to round). With a fake driver the extra work per call is ~1.1 µs; ~370 ns of it is the per-statement answer deadline (three statements). This wrapper ensures that the answer arrives within a bounded time when PgBouncer is left without a server; removing it would tie the guarantee to the drivers' connection-closing behavior, so it is kept. A direct Promise chain instead of `withReserved` was tried and gave no measurable difference.

### Research: driver-level gains (not applied)

2026-09-16, local stack, 32 concurrent loops, `prep_probe.users` (1000 rows) point read; a separate PgBouncer 1.24 instance with `max_prepared_statements = 500`. Values are rps.

| Scenario | bun | postgres | pg |
|---|---:|---:|---:|
| Dedicated connection, unnamed statement (the package's current path) | ~26,000 | ~14,500 | ~27,000 |
| Dedicated connection, named prepared statement | ~26,500 (+0–5%) | ~29,000 (**2x**) | ~28,700 (+5%) |
| Pool query (no reservation), unnamed | ~25,000 | ~14,500 | ~26,500 |
| Pool query, named prepared (pipelining on the connection) | ~59,000 (2.4x) | ~41,500 (2.9x) | ~28,700 |

- **postgres.js `prepare: false` makes two round trips for every parameterized query** (first Parse + Describe + Sync, then Bind + Execute; `postgres/src/connection.js` `describeFirst`). This is why the postgres driver stays at half the speed of bun and pg. A named statement removes this round trip.
- **The big gain on a pool query comes from pipelining:** with named statements, bun and postgres.js write concurrent queries to the same connection one after another. The package runs every statement on a dedicated connection (so that a connection whose deadline has expired can be discarded), so this gain can be had only by giving up that guarantee. A stuck statement also holds up the pipeline behind it.
- **Why it is not the default:** PgBouncer needs `max_prepared_statements > 0` (the current setup is 0). Because the SQL text contains the tenant schema, the number of statements becomes *query x tenant* (`search_path` is not used). PgBouncer's LRU bounds the server side, but the postgres.js and Bun client-side cache grows without bound as long as the connection lives. The application uses `pgDriver`; the gain on pg is ~5% and pg does not pipeline.
- **Sending `BEGIN` together with the first statement (pipelining):** in the raw measurement transactions/s rose by 25–60% on postgres.js, with no measurable difference on bun. pg does not support concurrent queries (8.x warns). This would break the guarantee (a unit test) that "if `BEGIN` is not answered, the transaction body never runs", so it was not applied.

### Span timeline (`bench:spans`, latest run)

`spans-2026-09-15T11-08-05Z`, driver `bun`, local compose stack (p50 ms).

| Scenario | Total | Notable steps |
|---|---:|---|
| Request, cold placement (point read) | 0.64 | `placement.read` 0.23; `db.query` 0.42 |
| Request, cached placement (point read) | 0.16 | `placement.cache` 0; `db.query` 0.15 |
| Request, insert transaction | 2.03 | `db.acquire` ~0; `db.transaction` 2.0 |
| Provision (6 tenants) | 58.9 (p95 90.7) | `tenant.lock` 4.0; `provision.pick` 4.4; `tenant.session` 3.7; `provision.claim` 2.2; `migration …_better_auth` 13.5; `migration …_initial` 6.9 |
| Provision, demo | 116 | `seed …_demo_login` 54.8 (password hash) |
| `migrateAll`, nothing pending | 13.1 | no lock/session per tenant |
| `seedAll`, nothing pending (173 tenants) | 583 | `tenant.lock` 7.5; `tenant.session` 7.6 |
| Full backup (6 tenants) | 280 | `backup.tenant` 88 |
| Incremental backup (6 tenants, unchanged) | 11,188 | an 11 s statistics wait + `backup.tenant` 18.8 |
| Move | 30,389 | `move.maintenance` 30,012 (cache wait); `move.copying` 127; `move.validated` 192; `move.cutover` 7.9 |

Almost all of the move time is the safety wait (`placementCacheWaitMs`); data copying and validation take 0.3 s for this small tenant.

Latencies measured on the end-to-end stack (PgBouncer + Redis + HTTP): [`@0furkancolak/pgcells-e2e` results](https://github.com/0furkancolak/pgcells/blob/main/packages/e2e/docs/results.md).
