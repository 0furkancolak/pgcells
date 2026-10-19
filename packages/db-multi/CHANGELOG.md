# @0furkancolak/pgcells

## 0.2.0

### Minor Changes

- d55000f: Connection management.
  
  - `pgcells pooler plan` computes the connection budget (client connections, server connections, statement flow) and exits 1 on a violation; `connectionBudget()` is exported from `/tools`. `doctor` gains `timeout_alignment` and, given `--instances --pool-max --poolers`, `connection_budget` read from the pooler's and PostgreSQL's real limits.
  - `pgcells pooler generate` writes a deterministic `pgbouncer.ini` and a `userlist.txt` skeleton from `DATABASE_URLS`/`DATABASE_REPLICA_URLS`; `--check dir` detects drift.
  - `db.stats()` returns pool counters (in use, waiting, acquisition percentiles, discarded connections, refused jobs) and context counts; `poolGauges()` in `/telemetry` publishes them as OpenTelemetry gauges.
  - `db.close({ drain: true, timeoutMs })` refuses new work, waits for started contexts and then closes; `ready()` fails at once while draining; `dbMiddleware(...).shutdown()` does the same for the shared database.
  - New runtime option `tenantMaxInflight` (off by default): a per-tenant limit on concurrent contexts, failing fast with `DATABASE_BUSY`.
  - `failoverClass()` and `retryable()` classify failover errors. A `DATABASE_TIMEOUT` raised before the statement was sent (no connection in time) is now an instance of `DeadlineError` with `workStarted: false` and classifies as retryable `unreachable`.
  - `db.close()` now resolves to `{ drained, remaining }` instead of `void`.
- c49fb89: `DATABASE_URLS` accepts explicit node ids (`db0=url,db1=url`) in any order, in addition to the positional form. Mixed lists are rejected.
- 1746037: Fencing and directory resilience.
  
  - `move` now has a `fenced` phase after cutover: the source schema is renamed to `tenant_x__moved_<move id>`, so a process that still routes by the old placement fails with `undefined_table` instead of silently writing to the abandoned copy. Moving a tenant back no longer needs a manual `DROP SCHEMA`. `doctor` lists the retained copies (`retained_moved_copies`) and fails on old copies that kept the tenant's own name (`unfenced_moved_copies`).
  - `createManagement` rejects a `placementCacheWaitMs` below the longest placement cache (`25000`, plus `replicaMaxLagMs` when `db0` has replicas) with `INVALID_CONFIG`. `unsafePlacementCacheWait: true` opts out for throwaway environments.
  - With replicas of `db0`, placement lookups use them for `active` records and confirm everything else on the primary.
  - New runtime option `staleIfErrorMs` (off by default, at most 300000): while the directory is unreachable, an expired `active` placement is served for that long. New span `placement.stale`.
- 32acd2b: Zero-downtime move, causal reads, promotion plan and capacity model.
  
  - `move --online` (`startMove(…, { online: { sourceUrlForTarget } })`): the tenant keeps taking writes while its schema is copied by logical replication (PostgreSQL 15+, `wal_level=logical`); writes pause only for the final catch-up, which locks the tables, waits for a heartbeat to reach the target, copies sequences, optionally compares row counts (`verify: auto|counts|none`), renames the source schema and commits. Resumable and roll-backable like the offline move; the platform `moves` table gets an `online` column (additive migration). Measured at 113 MB and 1.1 GB; 10–50 GB is not measured.
  - Write tokens: `RequestDb.lastWriteToken()` and `tenantRead.query(query, values, { after })` / `withTenantRead(id, work, { after })` make a read wait (at most `causalWaitMs`, default 200) for a replica to replay your write, then the primary answers.
  - `cell promote <dbN> --to K` / `promotePlan()`: a read-only checked plan for promoting a replica; it promotes nothing.
  - `capacity plan` / `capacityPlan()`: instances, cells and replicas for a target load from throughput you measured.
  - New error codes `ONLINE_SOURCE_URL_REQUIRED`, `ONLINE_REPLICATION_FAILED`, `ONLINE_TIMEOUT`.
- 568dbe6: Region model.
  
  - Databases can carry a `region`, a `residency_zone` and labels (`tools database set db1 --region eu-west --zone eu --label tier=gold`); an additive platform migration adds the columns and a `replicas` table. Everything is optional: a database with none behaves as before. `Placement` gains `residencyZone` and `region`.
  - Placement requests: `provision`/`restore` take `--region`, `--zone`, `--label`; automatic choice narrows to matching databases (`NO_CAPACITY` names the request). A database labelled `dedicated=true` is skipped by automatic choice unless asked for.
  - Residency: a tenant is bound to a zone (requested, else its database's). `provision`, `restore`, `move` and `adopt` refuse a target outside it with `RESIDENCY_VIOLATION`, checked in the transaction that writes the placement; `database set --zone` refuses to strand a bound tenant; backups record the zone. A move to another region needs `--allow-cross-region` (`CROSS_REGION_MOVE`).
  - `createDatabase({ region, onWrongRegion })`: a tenant of another region is refused with `WRONG_REGION`; `regionGuard` answers 421 or 307 before the route runs; `RequestDb` exposes `placement()` and `region`.
  - Replica locality: a regional application reads only from replicas in its own region (`tools replica set db1#2 --region …`); the replica report shows each replica's region.
  - `doctor`: `directory_pii`, `app_region` (`--app-region`) and `replica_region`.
  - Test stack `compose.regions.yaml` (two simulated regions with injected latency) and a CI job for it.
- 1097980: Add `createRotatingDatabase`: a `Database` whose pools can be replaced with `rotate()` (new credentials or node list) without a restart; the candidate must pass `ready()` before it takes over.

### Patch Changes

- 4544687: Document supplying node URLs from code (secret managers, bindings) and why a single URL cannot route to several servers.
