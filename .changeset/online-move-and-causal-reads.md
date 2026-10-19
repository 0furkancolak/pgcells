---
"@0furkancolak/pgcells": minor
---

Zero-downtime move, causal reads, promotion plan and capacity model.

- `move --online` (`startMove(…, { online: { sourceUrlForTarget } })`): the tenant keeps taking writes while its schema is copied by logical replication (PostgreSQL 15+, `wal_level=logical`); writes pause only for the final catch-up, which locks the tables, waits for a heartbeat to reach the target, copies sequences, optionally compares row counts (`verify: auto|counts|none`), renames the source schema and commits. Resumable and roll-backable like the offline move; the platform `moves` table gets an `online` column (additive migration). Measured at 113 MB and 1.1 GB; 10–50 GB is not measured.
- Write tokens: `RequestDb.lastWriteToken()` and `tenantRead.query(query, values, { after })` / `withTenantRead(id, work, { after })` make a read wait (at most `causalWaitMs`, default 200) for a replica to replay your write, then the primary answers.
- `cell promote <dbN> --to K` / `promotePlan()`: a read-only checked plan for promoting a replica; it promotes nothing.
- `capacity plan` / `capacityPlan()`: instances, cells and replicas for a target load from throughput you measured.
- New error codes `ONLINE_SOURCE_URL_REQUIRED`, `ONLINE_REPLICATION_FAILED`, `ONLINE_TIMEOUT`.
