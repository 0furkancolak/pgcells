# Operations

This document covers the maintenance work done in production: `bootstrap` and `doctor` at deploy time, adding and draining databases, moving a tenant to another database, backup/export/restore and cleaning up old sets, reserved IDs, and the lock, CAS and recovery guarantees these rest on. All commands require a direct (management) connection; the full list of commands is in [cli.md](cli.md).

## Deploy step

```sh
bun run cli bootstrap        # platform/node migrations, database identities, runtime timeout defaults; can be re-run
bun run cli migrate-all      # tenants that are out of date; exit code 1 if there are failed/incomplete
bun run tools doctor --pgbouncer-url                      # asks for the console URL through hidden input; in a script: printf '%s\n' "$PGBOUNCER_ADMIN_URL" | …
```

On a managed provider (Neon, Supabase), take a safety point before `migrate-all`: `bun run cli migrate-all --safety-point neon` (a `pre-migrate-<timestamp>` branch from each source branch; the migration does not start unless all of them are created) or `--safety-point supabase` (only records the PITR timestamp and writes the restore request). To go back: on Neon, inspect the branch and use [`neon export-tenant`](providers.md#provider-tools) + `restore` for the tenant; on Supabase, restore the whole project with PITR (PITR is a paid add-on; if you do not have it, take your own `db dump` backup).

For each database, `bootstrap` does the node migrations, the identity verification and the runtime timeout defaults in a single transaction (under a lock), then the platform migrations and the `platform.nodes` record in db0. When run twice, the second run's `applied` lists are empty.

## `doctor`

A read-only production check. The output is `{ ok, checks: [{ target, check, ok, detail }], externalChecks: [{ check, status: "unverified", detail }] }`; if `ok: false`, the exit code is 1.

| Check | Target | If it fails |
|---|---|---|
| `direct_connection` | each database | The management URL goes to a transaction pooler; give a direct or session pooling URL |
| `database_identity` | each database | The database at this URL is registered with a different identity; restore the `DATABASE_URLS` order |
| `string_literals` | each database | `standard_conforming_strings` must be on |
| `runtime_timeouts` | each database | The database default is not the expected `statement_timeout`/`lock_timeout`/`client_connection_check_interval`; run `bootstrap`, then refresh the pooler connections |
| `platform_migrations` | each database (node) and platform | There is a pending platform/node migration (`bootstrap`) or the ledger does not match the registry (`MIGRATION_DRIFT`, inspect by hand) |
| `configured_databases` | platform | The `DATABASE_URLS` list does not match the `platform.nodes` records |
| `active_placements` | platform | An active record pointing at an unknown database, not following the ID/schema rules, or waiting for a migration; bulk operations stop at these records |
| `migration_recovery` | platform | A leftover runner record; [recovery](migrations-and-seeds.md#recovering) |
| `operational_states` | platform | Information: the number of tenants that are not active and that own a move (always `ok`) |
| `retained_moved_copies` | each database | Information (always `ok`): the fenced source copies `…__moved_<id>` that completed moves left on this node. They hold pre-move data; drop them when no longer needed |
| `unfenced_moved_copies` | each database | A tenant that moved away still has a schema with its own name on its old node (a move completed before fencing existed). A process with a stale placement could still write to it; rename it (`ALTER SCHEMA "tenant_x" RENAME TO "tenant_x__moved_00000000"`) or drop it |
| `replica_reachable`, `replica_in_recovery`, `replica_lag`, `replica_identity`, `replica_runtime_timeouts`, `replica_pooled` | each replica (`db0#1`) | Replica checks; details: [replicas.md](replicas.md#doctor-checks) |
| `pooled_runtime` | each database | If `--pooled-urls` is given: the runtime URL does not go to a transaction-mode pooler (it gives `POOLER_REQUIRED` at runtime). The option takes no value; the URLs (`DATABASE_URLS` format, the same count and order) are asked through hidden input and do not end up in argv. If the count does not match, `INVALID_CONFIG` |
| `global_pool_mode` | pgbouncer | Extra information specific to PgBouncer: if `--pgbouncer-url` is given: the global `pool_mode` is not `transaction`. The option takes no value; the console URL (`postgres://…/pgbouncer`) is asked through hidden input and does not end up in argv or the shell history |
| `timeout_alignment` | pgbouncer | With `--pgbouncer-url`: PgBouncer's `query_wait_timeout` is not above the application's answer deadline (`statementTimeoutMs` + 1.5 s); clients would see pooler resets (`08P01`) instead of `DATABASE_TIMEOUT`. `0` (no limit) passes |
| `connection_budget` | each database | With `--pgbouncer-url` and `--instances`, `--pool-max`, `--poolers`: one of the three budget inequalities is violated; the detail says which. Uses the pooler's global `default_pool_size` (per-database `pool_size` overrides are not read) |
| `directory_pii` | platform | Information (always `ok`): columns of `platform.tenants` that look like personal data (`owner_email`, `phone` …). The directory lives in db0's region, so that region holds the data whatever the tenant's residency zone says; keep personal data in the tenant's own cell |
| `app_region` | platform | With node regions defined: information without `--app-region`; with it, fails if no database lives in that region (an application with that `region` would refuse every tenant) |
| `replica_region` | each replica | Information: where the directory says the replica lives, with a warning when it differs from its database's region |
| `inspection` | any | The check could not be completed (connection/permission); the error code is in the detail |

`externalChecks` are those that cannot be proven with SQL and must be verified by hand: `pooled_runtime` (if `--pooled-urls` was not given; `ready()` already checks at startup), `effective_pgbouncer_mode` (if PgBouncer is used, `SHOW POOLS` for the database/user pools), `hyperdrive_cache` (caching off on all Hyperdrive connections), `deployment` (`/ready`, TLS/network, and the application's `DATABASE_URLS` order being the same as management's).

## Adding and draining databases

**Adding a new database:**

1. Bring up the new PostgreSQL (the same major version, encoding/locale/collation and extensions — move and restore require this).
2. Append the URL to the **end** of the `DATABASE_URLS` list; in both the application and management environments.
3. `bun run cli bootstrap` — writes the identity and timeout defaults to the new database and registers it in `platform.nodes`.
4. Restart the applications (otherwise requests of a tenant placed on the new database get `DATABASE_NOT_FOUND`; `ready()` gives `DATABASE_NOT_CONFIGURED`).

New tenants automatically go to the new database through placement selection ([tenants.md](tenants.md#placement-selection-size-capacity-draining)). To balance the existing tenants, [move them](#tenant-move).

**Placement selection settings:**

```sh
bun run tools databases                              # status, capacity, tenants, load, configured
bun run tools database set db0 --status draining     # takes no new tenants; existing ones stay
bun run tools database set db0 --status active
bun run tools database set db1 --capacity 2000       # upper limit of the sum of sizes
```

**Draining a database:** set it to `draining` and move its tenants to other databases one by one. Since the list grows only by appending to the end, do **not** delete the URL of a drained database from the list (the identities of the databases after it shift, `DATABASE_ORDER_CHANGED`).

## Tenant move

```sh
bun run tools move kadikoy db1 --writers-drained
# {"moveId": "b9323100-…"}
# {"id": "b9323100-…", "tenantId": "kadikoy", "targetDatabaseId": "db1", "status": "completed", "phase": "completed", …}
bun run tools move-status b9323100-…
bun run tools resume-move b9323100-… --writers-drained
bun run tools rollback-move b9323100-… --writers-drained
```

From code: `startMove(m, tenantId, targetDatabaseId, writersDrained, onStarted?)`, `getMove(m, id)`, `resumeMove(m, id, writersDrained)`, `rollbackMove(m, id, writersDrained)` — `@0furkancolak/pgcells/tools`.

### Stop the writers first

Before the move, stop **all** application and background jobs that write to that tenant (HTTP write routes, queue workers, cron) from the outside, and keep them stopped until move/resume/rollback finishes. `--writers-drained` declares that you have done this; it does not stop requests itself; if it is not given, `MAINTENANCE_REQUIRED`.

### Flow

`planned → maintenance → copying → validated → cutover → fenced → completed`

1. **maintenance:** the placement becomes `migrating` and `onPlacementChange` is called. Then **`placementCacheWaitMs` (default 30 s) is waited**: every process that holds an `active` record in its cache, including those without a hook (e.g. the CLI, an application not connected to Redis), drops it in this time. During this time reads may keep returning from the source database with the cached placement; when the cache expires, requests get `TENANT_UNAVAILABLE`.
2. **copying:** the schema name is reserved on the target and the data is copied from the source snapshot (repeatable read). The data is moved as driver-independent bulk JSON (a cursor + `row_to_json` on the source, `json_populate_recordset` batches of 500 rows on the target). Cancellation and the time limit are checked between batches/statements; the target transaction is rolled back.
3. **validated:** the target's fingerprint is compared with the source's (`COPY_MISMATCH`).
4. **cutover:** the placement switches to the target database (`placement_version` increases, status `maintenance`), and `onPlacementChange` is called.
5. **fenced:** the source schema is renamed from `tenant_x` to `tenant_x__moved_<first 8 hex of the move id>` (a name too long for PostgreSQL is shortened before the marker). From here a process that still routes by the old placement fails with `undefined_table` (42P01) instead of silently writing to a copy nobody reads. The data stays inspectable under the new name; nothing is deleted. Re-running the phase is safe (a source that is already renamed is skipped).
6. **completed:** the placement is `active`. The renamed source schema is **not deleted automatically**.

Each step runs under the tenant and node locks and the ownership of `placements.move_operation_id` and the move record. While there is an unfinished move, a new `move` for the same tenant is rejected (`MOVE_UNFINISHED`).

### States

| State | What to do |
|---|---|
| Error before the database switch (cutover) | `resume-move` or `rollback-move` |
| Error after the database switch | `resume-move` (rollback is rejected with `ROLLBACK_NOT_ALLOWED`) |
| Completed | Inspect the fenced copy `tenant_…__moved_<id>` on the source database and drop it when you no longer need it: `DROP SCHEMA "tenant_…__moved_…" CASCADE`. `doctor` lists it as `retained_moved_copies`. Moving the tenant back needs no cleanup: the tenant's own schema name is free again on that database |
| `TARGET_EXISTS` | The target has a schema of the tenant's own name (for example a copy left by a move that completed before fencing existed, or a manual restore) and it is not taken over: inspect the data, run the `DROP SCHEMA … CASCADE` command in the message on that database and try again |
| `TARGET_RESERVED` | The target schema is reserved for another unfinished move; complete or roll back that move |
| `SAME_DATABASE` | The tenant is already on the target |

### Online move: `move --online`

The flow above takes the tenant offline from `maintenance` to `completed` and waits `placementCacheWaitMs`. `move --online` keeps the tenant writable and pauses writes only for the final catch-up. It copies the schema with PostgreSQL logical replication:

```sh
bun run tools move kadikoy db1 --online [--verify auto|counts|none]
# asks (hidden input) for the SOURCE database URL as the TARGET server reaches it: postgres://user:pw@host:5432/db
```

```ts
await startMove(management, "kadikoy", "db1", undefined, onStarted, {
  online: { sourceUrlForTarget: "postgres://…", verify: "auto" },
});
```

No `--writers-drained` is needed. The URL is only used to create the subscription; PostgreSQL stores it, pgcells does not, and `resume-move` asks for it (`--source-url`) only if the subscription was not created yet.

**Requirements.** PostgreSQL 15 or newer on both sides (publications for all tables in a schema), `wal_level=logical` and a free replication slot on the source, `max_logical_replication_workers` of at least 2 on the target, a management role on the target that may create subscriptions (superuser, or `pg_create_subscription` on 16), and the target server must reach the source with the URL you give (a direct connection, not a pooler). They are checked before anything is recorded (`UNSUPPORTED_MOVE` names what is missing). Tables without a primary key get `REPLICA IDENTITY FULL` on the source. Same table-and-sequence limits as the offline move, and the PostgreSQL version, collation and extension checks still apply.

**Flow.** `planned → prepared → replicating → paused → cutover → fenced → completed`.

1. **prepared:** the target gets the empty structure (tables, keys, indexes, foreign keys) and both sides get a small heartbeat table `_pgcells_hb` in the tenant schema.
2. **replicating:** a publication on the source (`FOR TABLES IN SCHEMA`), a subscription on the target with the initial copy; the move waits for every table to finish copying and for a heartbeat to come back within `maxLagMs` (1 s). The tenant is writable all along.
3. **paused:** in one source transaction every table is locked `SHARE ROW EXCLUSIVE` (writes wait, reads continue), the placement becomes `migrating` (processes with `onPlacementChange` stop sending writes), a heartbeat inserted now must reach the target (so the target has every earlier write), the sequence values are copied, row counts are compared (`verify`), the schema is renamed (the fence) and the transaction commits. Writers that were waiting on the locks re-resolve the table name and fail with `undefined_table`; nothing can be written to the abandoned copy.
4. **cutover, fenced, completed:** as in the offline move; then the subscription, the slot and the publication are removed and the heartbeat table is dropped from the target. If removing them fails the move still completes and `move-status` shows what to clean by hand in `error`.

**What the application sees.** Reads never stop. During the pause writes wait on the locks; a process that follows the placement hook gets `TENANT_UNAVAILABLE` (503) until `completed`, so give the placement hook (`onPlacementChange`, or the Redis placement cache) to every process: a process without it keeps its cached `active` placement for up to `placementCacheMs` (≤ 25 s) and its writes fail with `undefined_table` until the cache expires. Nothing is ever written to the abandoned copy and no acknowledged write is lost. A lock that can not be taken in `lockTimeoutMs` (2 s, because a long transaction holds the table) is retried `lockAttempts` (5) times without holding anyone; if it stays busy the move fails (`55P03`) with the placement untouched and can be resumed.

**`verify`.** Comparing row counts inside the pause costs time proportional to the size. `auto` (default) does it for schemas up to 256 MiB; `counts` always; `none` never. The apply errors of the subscription are checked throughout; `move --online` stops with `ONLINE_REPLICATION_FAILED` if the target reports any.

**Measured** (local Docker, PostgreSQL 16.15, writes at about 200 per second throughout, `bench/online-move-spike.ts`): 113 MB: initial copy 2.4 s, pause 162 ms of which 138 ms is the row count; 1.1 GB: initial copy 85 s, pause 10.4 s with the row count (10.2 s of it) and about 0.14 s without it, plus 1.2 s to take the locks; in both the counts matched and the abandoned copy did not change after the rename. Through the package (small tenant, live writer): pause 220–300 ms, 6–11 refused writes (`TENANT_UNAVAILABLE`) and one `undefined_table`, no lost acknowledged write. **Not measured:** 10 GB and 50 GB (this machine could not hold them); the copy time grows linearly with size, the pause should not once `verify` is `none`. Provider support: [providers.md](providers.md#online-move-logical-replication).

`rollback-move` works for an online move before the cutover: it removes the replication objects, gives the source schema its own name back if the pause had renamed it, and drops the target copy.

### Limits

- Only ordinary tables and sequences are moved (`UNSUPPORTED_MOVE`); an empty schema is `EMPTY_SCHEMA`.
- The PostgreSQL major version, encoding/locale/collation and extension versions of the source and target must match (`VERSION_MISMATCH`, `COLLATION_MISMATCH`, `EXTENSION_MISMATCH`).
- Because Bun SQL does not support COPY, a single code path was chosen: it is slower than binary COPY, and very large rows (e.g. megabytes of bytea) grow the batch memory.
- The command takes at least `placementCacheWaitMs`; for a small tenant, copying and validation take under a second ([measurement](performance-and-observability.md#span-timeline-benchspans-latest-run)).

## Backup, export and restore

It is driver-independent (pg_dump is not needed) and uses the same schema reading/building code as the move: tables, sequences, keys, indexes and sequence values are read from the catalog, and rows are written as gzipped JSON Lines. Each tenant is taken from a consistent snapshot (repeatable read).

```sh
bun run tools backup /backups --full                # full set: /backups/20260915120000/
bun run tools backup /backups                       # incremental set: an unchanged tenant is not rewritten
bun run tools backup /backups --tenants abc,xyz --concurrency 4
bun run tools backup prune /backups --keep 14
bun run tools export abc /out/abc                   # a single tenant, all its data (the folder must not exist)
bun run tools restore abc /backups                  # from the latest completed set
bun run tools restore abc /backups --set 20260915120000
bun run tools restore abc /out/abc db1 --size 20    # from an export folder, database and size by hand
```

From code (`@0furkancolak/pgcells/tools`): `backupAll(m, root, { full, tenants, concurrency, signal, report })`, `pruneBackups(root, keep)`, `exportTenant(m, tenantId, dir, { signal })`, `restoreTenant(m, tenantId, source, { set, databaseId, size, signal, report })`.

- **Only active tenants** are backed up; `--tenants` narrows this list. The default concurrency is 2. Before starting, it is checked that all databases are ready.
- **Result:** `{ id, full, tenants, written, unchanged, failed, … }`. If there is a tenant error, the set is still completed, the failed tenants are written to the manifest, and the CLI exit code is 1.

### Set format

```
<root>/<UTC yyyyMMddHHmmss>/
  manifest.json                 # full or not, base set, tenant → the set holding the data + change marker + row count, failed tenants
  platform/{tenants,placements,nodes,reserved_tenant_ids}.jsonl.gz
  tenants/<id>/tenant.json      # schema shape, PostgreSQL version and collation info, size, table files and row counts
  tenants/<id>/<n>.jsonl.gz
```

The manifest is written last; a set without a manifest is incomplete and is not used as a base. The set ID has second resolution; a backup taken in the same second as the previous one gets the next second's ID.

### Incremental backup

- If `--full` is not given, the latest completed set becomes the base.
- If a tenant's change marker (table file identity, column count, insert/update/delete counters, sequence values, statistics reset time, server start time, placement database and version) is the same, the data is not rewritten; the manifest points to the earlier set. TRUNCATE, a move and a server restart change the marker.
- Because PostgreSQL counters can be written up to 10 seconds late from idle connections, in an incremental set the markers are read **after waiting 11 seconds**: every write committed before the set started is reflected in the marker.
- Tenants in a database with `track_counts` off or older than PostgreSQL 15 are rewritten in every set.
- To be able to delete old sets, still take a full set regularly (e.g. daily incremental, weekly `--full`).

### Backup from a replica

`backup --from-replica` and `export --from-replica` read the tenant data from the replica (to reduce the primary's load); the URLs are asked through hidden input and must be direct. A replica set is always **full**, the manifest carries `source: "replica"`, and the placement/platform records are read from the primary. Restore is the same `restore` command. Details and limits: [replicas.md](replicas.md#backup-and-export-from-a-replica---from-replica).

### Pruning

`backup prune <root> --keep N` keeps the last N completed sets and the older sets they point to, and deletes the other completed sets; it does not touch incomplete sets. The output is `{ kept, removed }`. It does not connect to the database.

### Restore

- It builds only a tenant that **does not exist**; it does not overwrite an active tenant (`TENANT_EXISTS`).
- The source can be a backup root (the latest completed set or `--set`) or an export folder.
- Reserved IDs, database readiness, schema uniqueness across all databases and placement selection are the same as provision; if `--size` is not given, the size in the backup is used.
- The PostgreSQL major version, collation and extensions must match those in the backup.
- The schema and data are built under the tenant locks in a **single transaction** and the row count per table is verified (`RESTORE_MISMATCH`); if interrupted, nothing is left behind and it can be retried.
- The backup's migration history must be a prefix of this code's list (a backup taken with newer code gives `MIGRATION_DRIFT`); if it is older, the pending migrations are applied, then the tenant becomes `active`. Seeds do not run again (the ledger is in the backup).
- The output is `{ placement, rows, … }`.

### Caveats

- The platform records (`platform/`) are not restored automatically; the files are for inspection.
- Because rows are moved in batches of 500 as JSON, it is slower than binary COPY.
- Copy the backup folder to a disk or object store separate from the application databases.
- After a deleted tenant is restored, the applications' placement caches do not cache `TENANT_NOT_FOUND`; requests see the new placement immediately.

## In-place migration from an existing application

The tenant schemas with arbitrary names of another application can be adopted without copying data: `adopt plan` → `adopt apply` renames the schema to `tenant_<id>` and writes the placement, and `adopt rollback` undoes it. Commands, issue codes and going back: [cli.md](cli.md) and [errors.md](errors.md).

## Reserved IDs

```sh
bun run tools reserve mybrand,destek --reason brand   # an existing tenant cannot be reserved (TENANT_EXISTS)
bun run tools reserved                                  # [{"tenantId","reason"}]
bun run tools unreserve destek                          # {"released":["destek"]}
```

Details: [tenants.md](tenants.md#reserved-ids).

## Guarantees

- **Locks.** The global `migration-runner` in the platform database and `tenant-operation:<id>` per tenant, and `tenant-management:<id>` in the tenant's database, are advisory locks held on dedicated direct sessions. Locks are not waited for: with a held lock, `MIGRATION_RUNNER_BUSY` or `TENANT_BUSY` returns immediately. `provisionTenant`, `seedTenant`, `resetDemoTenant`, single-tenant `migrateTenant`, `move` and `restore` take the same tenant locks. `bootstrap` takes the `platform-bootstrap` key in each database by waiting at the transaction level; placement selection and ID reservation take the `tenant-placement` transaction lock.
- **Session loss.** A management session is in its own single-connection pool and does not reconnect. If the driver reports closure, a query gives a connection error, or no answer comes within the statement timeout + 5 s, the session is considered lost and all pending queries are rejected with `LOCK_LOST`. Run the same command again.
- **CAS.** Placement `status` / `schema_version` updates are conditional on `placement_version` and are re-verified after the lock (`PLACEMENT_CONFLICT`).
- **Cancellation.** `signal` (SIGINT/SIGTERM in the CLI) stops taking new work; after `shutdownGraceMs` (10 s) the sessions are cancelled on the server side (`MIGRATION_CANCELLED`). All operations can be re-run.
- **Crash.** If a migration runner record remains, `migration-recover` ([migrations-and-seeds.md](migrations-and-seeds.md#recovering)); a half-finished provision, demo reset, move and restore are completed with the same command.
