---
"@0furkancolak/pgcells": minor
---

Connection management.

- `pgcells pooler plan` computes the connection budget (client connections, server connections, statement flow) and exits 1 on a violation; `connectionBudget()` is exported from `/tools`. `doctor` gains `timeout_alignment` and, given `--instances --pool-max --poolers`, `connection_budget` read from the pooler's and PostgreSQL's real limits.
- `pgcells pooler generate` writes a deterministic `pgbouncer.ini` and a `userlist.txt` skeleton from `DATABASE_URLS`/`DATABASE_REPLICA_URLS`; `--check dir` detects drift.
- `db.stats()` returns pool counters (in use, waiting, acquisition percentiles, discarded connections, refused jobs) and context counts; `poolGauges()` in `/telemetry` publishes them as OpenTelemetry gauges.
- `db.close({ drain: true, timeoutMs })` refuses new work, waits for started contexts and then closes; `ready()` fails at once while draining; `dbMiddleware(...).shutdown()` does the same for the shared database.
- New runtime option `tenantMaxInflight` (off by default): a per-tenant limit on concurrent contexts, failing fast with `DATABASE_BUSY`.
- `failoverClass()` and `retryable()` classify failover errors. A `DATABASE_TIMEOUT` raised before the statement was sent (no connection in time) is now an instance of `DeadlineError` with `workStarted: false` and classifies as retryable `unreachable`.
- `db.close()` now resolves to `{ drained, remaining }` instead of `void`.
