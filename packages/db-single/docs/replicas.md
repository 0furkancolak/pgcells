# Replica reads

A replica takes read load off the primary. Writes always go to the primary, and the package **does not route queries automatically**: reading from a replica is an explicit call (`db.read.query`), because a replica can be stale.

## Configuration

URLs are given with `DATABASE_REPLICA_URLS` (or the second argument of `createConfig`): a comma-separated plain list, at most 8, unique, different from the primary; `INVALID_CONFIG` if malformed. Behavior is set with three plain options (`createDb`, `dbMiddleware`; no new environment variables): `replicaMaxLagMs` (5000; a replica whose lag exceeds this is not used), `replicaStatusMs` (5000; status cache duration), `replicaOnUnavailable` (`"primary"` | `"error"`) — the limits are in [configuration.md](configuration.md#runtime-options-createdb). Replica connections are opened lazily; `ready()` does not wait for the replica and does not fail because of it. Each replica opens its own pool of size `poolMax`: the total is `poolMax × (1 + number of replicas)`.

## Usage

```ts
import { findUsers } from "@0furkancolak/pgcells-single/repositories/users";

await findUsers(db.read, 20);            // On Db: picks a replica on every call; give db.read to the repository function
await findUsers(c.get("db").read, 20);   // in a request scope (middleware, createDbScope)
```

- The read context has only `query`; there is no `transaction` on a replica (a long transaction risks a recovery conflict).
- In a request scope, reads are **pinned to the replica chosen by the first read** (two reads do not see views of different staleness); if the replica fails with a connection error, the pin is lifted. The round-robin order is at module level (just a counter).
- **The `readOnly` flag:** codegen writes `readOnly` onto every query from the SQL’s AST (no SQL is parsed at runtime). A query that is not `readOnly` (`INSERT`/`UPDATE`/`DELETE`, `FOR UPDATE/SHARE`, a data-modifying CTE) becomes `QUERY_NOT_READ_ONLY` in the read context without going to the DB. Functions with side effects (`nextval`) cannot be told apart statically: a replica rejects the write itself, but a read on the primary (no replica, or after a write) is a single statement and does not block it; do not put side-effecting functions in a read query.
- **Read after write:** if a write ran in the same request scope (including inside a transaction), later `read.query` calls go to the primary (a single statement); read-only queries do not set the marker. Consistency that carries over to another request is not guaranteed; if you need it, do that read with `db.query`/`db`.

## Degradation policy

If there is no healthy replica (none configured, down, not `in_recovery`, lag threshold exceeded): `"primary"` (the default) runs the read on the primary as a single statement (in a `READ ONLY` transaction if a replica is configured but unavailable: the same meaning as a replica read, with an extra `BEGIN`/`COMMIT` round trip); `"error"` gives `REPLICA_UNAVAILABLE` (also when no replica is configured; no silent fallback). Read after write is not affected by this. If a replica query fails with a connection error, the error surfaces as is and the replica is not used for `replicaStatusMs`; there is no hidden per-query retry.

## Lag measurement

The status is polled lazily (there is no background timer; it would not survive in Workers), cached for `replicaStatusMs`, and concurrent calls for the same replica share one poll. The poll reads `pg_current_wal_lsn()` from the primary and `pg_is_in_recovery()`, `pg_last_wal_replay_lsn()` and `pg_last_xact_replay_timestamp()` from the replica: if the replica has reached the primary’s position the lag is **0**, otherwise it is the time since the last replayed commit; if `in_recovery` is false the URL is not a replica and is not used. While WAL without commits is flowing (autovacuum, checkpoint), the lag can briefly look too high; the error direction is safe (falling back to the primary).

## Tools

**`replicas`** (`bun run cli replicas`): polls every replica in `DATABASE_REPLICA_URLS` without the cache and writes `{ ok, maxLagMs, replicas: [{ replica, up, inRecovery, lagMs, usable, error? }] }` (`replica` is a 1-based number in config order; **no output contains a URL, host, user or password**). If a replica is down, is not a replica, or its lag exceeds the threshold, `ok: false` and exit code 1. In code, `replicaReport(m)` (`@0furkancolak/pgcells-single/tools`); in the application, `db.replicas()`.

**`doctor` replica checks** (target `replica#1`…; all read-only): `replica_reachable` (if it cannot connect, the others are skipped), `replica_in_recovery` (giving the primary as a replica), `replica_lag`, `replica_runtime_timeouts` (the DB defaults did not come with the replica: `migrate` on the primary).

**`--from-replica`** (`export`, `backup`): data is read from the replica instead of the primary. The command asks for **a single direct replica URL through hidden input** (not written to argv/the environment; `DATABASE_REPLICA_URLS` is not read). It validates without writing anything: a single plain URL different from the primary (`INVALID_CONFIG`), not a transaction pooler (`DIRECT_CONNECTION_REQUIRED`; the backup uses a multi-step REPEATABLE READ snapshot and cursors), really a replica (`INVALID_CONFIG`), lag below the threshold at start (`REPLICA_LAG_EXCEEDED`).

- Before reading, it waits until the replica has replayed the primary’s current WAL position (at most `replicaMaxLagMs`, then `REPLICA_LAG_EXCEEDED`); `backup.json` carries `source: "replica"` and the data’s `replayLsn`.
- **Recovery conflict:** the standby can cancel a long snapshot after `max_standby_streaming_delay`; drivers surface this as a generic connection error. At the start of each transaction the tool reads the standby’s conflict counter (`pg_stat_database_conflicts`); if the counter increased during a connection-class error, it reports `REPLICA_CONFLICT`. Retry, or take it from the primary; look at the provider’s `hot_standby_feedback` and `max_standby_streaming_delay` settings ([providers.md](providers.md)).
- It never falls back to the primary silently. Restoring is the same `restore` command.
