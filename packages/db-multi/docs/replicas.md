# Reading from a replica

A replica takes the read load off the primary. Writes are always on the primary, and the package **does not route queries by itself**: reading from a replica is an explicit context (`withTenantRead`, `tenantRead`), because it is the package's principle that the target is explicit on every call, and a replica can be stale. This document covers configuration, usage, the fallback policy, lag measurement and limits.

## Configuration

Replica URLs are given with `DATABASE_REPLICA_URLS` (or the second argument of `createConfig`); the rules are in [configuration.md](configuration.md): `db0=urlA,db0=urlB,db1=urlC`, at most 8 per node. Behavior is set with three plain options (`createDatabase` and `dbMiddleware`; there is no new environment variable):

| Option | Default | Limit | Meaning |
|---|---|---|---|
| `replicaMaxLagMs` | 5000 | 3 600 000 | A replica whose lag exceeds this is not used |
| `replicaStatusMs` | 5000 | 60 000 | The replica status (health + lag) stays cached this long |
| `replicaOnUnavailable` | `"primary"` | `"primary"` \| `"error"` | What happens when there is no healthy replica ([Fallback policy](#fallback-policy)) |

An invalid value gives `INVALID_CONFIG`. Replica connections are opened lazily; `ready()` does not wait for the replica and does not fail because of it (the application should not stop being ready when a replica goes down).

## Usage

```ts
// A single query or a few reads: queries in the same call are pinned to the same replica (a consistent view).
const users = await db.withTenantRead("abc", (tenant) => tenant.query(listUsers, [20, 0]));

// In request scope (middleware, createDbScope): a single query.
const rows = await c.get("db").tenantRead.query(listUsers, [20, 0]);
```

- The context has only `query`; there is no `transaction` (a long transaction on a replica carries the risk of a recovery conflict).
- Only the `tenant` scope is read. `node` and `platform` reads stay on the primary (small and consistency-critical).
- The read context is also valid only for the duration of `work` (`TRANSACTION_CLOSED`).
- In request scope (`tenantRead`), the reads of the same request are **pinned to the replica chosen by the first read**: with two replicas, two reads of the same request do not see views of different staleness. If the pinned replica drops with a connection error, the pinning is lifted and the next read chooses again; reads after a write go to the primary. `db.withTenantRead` calls, on the other hand, choose every time (consistency within the call is enough).
- The round-robin order is at module level (only a number): on Workers, which builds a `Database` per request, not every request starts from the 1st replica.

## The `readOnly` flag

Every compiled query carries a `readOnly` flag; codegen writes it from the SQL's AST (SQL is not parsed at runtime). The read context rejects a query that is not `readOnly` with `QUERY_NOT_READ_ONLY`, **without going to any database**.

| `readOnly` | Not |
|---|---|
| top-level `SELECT`, `VALUES`, `UNION`, CTEs that only read | `INSERT`, `UPDATE`, `DELETE`, `FOR UPDATE/SHARE`, data-modifying CTEs |

Functions with side effects (like `nextval`) cannot be distinguished statically. The second safeguard: a replica is read-only (a query that tries to write gives an error) and falling back to the primary runs in a `READ ONLY` transaction. The flag is regenerated with `bun run codegen`; `codegen --check` rejects stale output.

## Read after write

If a write has run on the `tenant` context in the same request scope (`RequestDb`, `createDbScope`) (including inside a transaction), that request's later `tenantRead` calls go to the **primary**. Queries that only read and transactions that only read do not set the marker.

| Situation | What you read |
|---|---|
| You wrote in the same request, then `tenantRead` | primary: you see your write |
| Another request made the write | replica: may be stale by the lag |

Read-write consistency that carries over into another request is not guaranteed; if you need it, do that read with the `tenant` context.

## Fallback policy

If there is no healthy replica (none configured, down, not `in_recovery`, or the lag threshold exceeded):

- `replicaOnUnavailable: "primary"` (default): the read runs on the primary, each query in a `READ ONLY` transaction.
- `replicaOnUnavailable: "error"`: `REPLICA_UNAVAILABLE`. This error is also given if no replica is configured at all (there is no silent fallback to the primary). Read after write is not affected by this, it runs on the primary.

If a replica query drops with a connection error, the error comes out as is and the replica is not used for `replicaStatusMs`; there is no hidden per-query retry. The next call chooses another replica or the primary.

## Lag measurement

The status is polled lazily (there is no background timer; a timer does not survive on Workers) and stays cached for `replicaStatusMs`; concurrent calls for the same replica share a single poll. The poll reads `pg_current_wal_lsn()` from the primary, and `pg_is_in_recovery()`, `pg_last_wal_replay_lsn()` and `pg_last_xact_replay_timestamp()` from the replica:

- if the replica has reached the primary's position, the lag is **0** (no artificial lag appears on an idle primary);
- if it has not, the lag is the time since the last replayed commit;
- if `in_recovery` is false, that URL is not a replica and is not used.

Limit: while WAL without commits flows (autovacuum, checkpoint), the lag can briefly look larger than it is. The direction of the error is safe: the result is falling back to the primary. The status cache is at module level and holds only numbers; it survives even if the per-request pool is closed on Workers.

## Number of connections

Each replica opens its own pool and gets `poolMax` connections: per process a total of `poolMax x (1 + number of replicas)` (per database). Calculate the replica server's connection limit accordingly.

## Limits

- Read-write consistency that carries over into another request is not guaranteed.
- There is no transaction, `node`/`platform` read or write to a replica on a replica.
- There is no hidden per-query retry.
- Management (`migrate`, `bootstrap`, `provision`…) ignores `DATABASE_REPLICA_URLS`.

## Tools

### `replicas`

```sh
bun run cli replicas
```

It polls every replica in `DATABASE_REPLICA_URLS` without consulting the cache and writes a single JSON: `{ ok, maxLagMs, replicas: [{ databaseId, replica, up, inRecovery, lagMs, usable, error? }] }`. `replica` is a 1-based number by config order; **the URL, host, user and password are not in any output**. If a replica is down, is not a replica, or the lag exceeds `replicaMaxLagMs`, `ok: false` and the exit code is 1 (can be used as a health check). The function equivalent is `replicaReport(m)` (`@0furkancolak/pgcells/tools`); inside the application, `db.replicas()`.

### `doctor` checks

For each replica the target is a sequence number like `db0#1`; all are read-only:

| Check | If it fails |
|---|---|
| `replica_reachable` | Could not connect to the replica (error code in the detail); the other replica checks are skipped |
| `replica_in_recovery` | The URL does not go to a replica (giving the primary as a replica) |
| `replica_lag` | The lag is above `replicaMaxLagMs` or unknown |
| `replica_identity` | The replica is not a copy of its own primary (`platform.node_identity` points at another database) |
| `replica_runtime_timeouts` | The database default timeouts did not arrive with the replication; run `bootstrap` on the primary |
| `replica_pooled` | Information only, always `ok`: the detail says whether the replica runtime URL goes to a transaction-mode pooler (the runtime does not enforce it; a direct URL does not make doctor fail) |

### Backup and export from a replica (`--from-replica`)

```sh
bun run cli backup ./backups --from-replica
bun run cli export abc ./abc-export --from-replica
```

The data is read from the replica instead of the primary (to reduce the primary's load). The direct replica URLs are asked in the form `db0=postgres://…,db1=…` through **hidden input** (not written to argv or the environment). The URL must be **direct**: the backup uses a multi-step REPEATABLE READ snapshot and a cursor, and a transaction-mode pooler breaks this. The tool verifies the following and fails without writing anything: it is not a pooler (`DIRECT_CONNECTION_REQUIRED`), it really is a replica, a single URL per node, the replica's identity (`platform.node_identity`) is that node's (`INVALID_CONFIG`; this catches mistakes like writing db1's replica in place of `db0`, but cannot tell apart a cluster with the same identity from another environment: enter the URLs correctly per environment), and at startup the lag is below the threshold (`REPLICA_LAG_EXCEEDED`).

- **The placement and platform records are read from the primary** (small and consistency-critical); only the tenant table data comes from the replica. Before each tenant is read, the replica is waited for until it replays the primary's current WAL position (at most `replicaMaxLagMs`, then `REPLICA_LAG_EXCEEDED`): the placement and schema that were read exist on the replica, and if replication stalls during a long backup, later tenants are not silently written with stale data.
- **Every tenant is backed up in full.** The change marker of an incremental backup rests on the `pg_stat_user_tables` counters; these are per instance and are not replicated. The manifest carries `source: "replica"` and, per database, the replay position at the moment the set started (`replayLsn`); each tenant's `tenant.json` carries the replay position at which its own data was read (`source`, `replayLsn`). A replica set does not break the chain of the next primary backup: that backup rewrites the tenants, and later ones are incremental again.
- **Recovery conflict:** the standby can cancel a long snapshot at the end of `max_standby_streaming_delay`; the drivers show this only as a generic connection error. At the start of each transaction the tool reads the standby's conflict counter (`pg_stat_database_conflicts`); if the counter increased during a connection-class error (without a code, or a connection drop), it reports this as `REPLICA_CONFLICT` (application, file system and SQL errors with a meaningful SQLSTATE come out with their own codes). The remedy: try again, or take it from the primary (without `--from-replica`); look at the `hot_standby_feedback`/`max_standby_streaming_delay` settings at the provider ([providers.md](providers.md)).
- The tool does not silently fall back to the primary: the target database is explicit on every call.
- Restore is done with the same `restore` command.
