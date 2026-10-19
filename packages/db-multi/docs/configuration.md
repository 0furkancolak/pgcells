# Configuration

The package reads one required environment variable (`DATABASE_URLS`) and one optional variable (`DATABASE_REPLICA_URLS`, for those who use replicas); every other setting is a typed option passed to the factories (`createDatabase`, `createManagement`, `dbMiddleware`). This document covers the rules for the URL list, the defaults and upper limits of the options, the drivers, why the application and management need different connection types, where timeouts are applied, and deployment notes.

## `DATABASE_URLS`

Comma-separated PostgreSQL URLs:

```sh
DATABASE_URLS=postgres://admin:***@pg0:5432/app,postgres://admin:***@pg1:5432/app
```

- At least 1 and at most 100 URLs; the scheme is `postgres:` or `postgresql:`. An empty or duplicate entry, or an `options` or `search_path` query parameter, gives `INVALID_CONFIG` (the error message does not contain the URL).
- **The identity comes from the order:** `[0]` → `db0` (platform database and tenant database), `[1]` → `db1` …
- **Or name the nodes explicitly:** prefix every entry with its id, `db0=postgres://…,db1=postgres://…`. Explicit ids may come in any order and may skip numbers, but `db0` is required and the two forms cannot be mixed in one list. With explicit ids the application and management lists only have to agree on which URL carries which id, not on the order, so a pooled list and a direct list can be assembled independently. The id regex is `db0`…`db99`.
- **The list grows only by appending to the end** (bare form) or by adding new ids (explicit form). Do not reorder a bare list, and never delete a registered node. The order of a bare list must be the same in the application and management environments.
- **Protection:** the `platform.node_identity` row in each database is written on the first `bootstrap` and verified on every later `bootstrap`; `platform.nodes` in the platform database holds the registered identities. If the order changes, a registered database drops out of the list, or a registered location points at a new/empty database, `bootstrap` stops with `DATABASE_ORDER_CHANGED` before any platform write; `doctor` reports the same condition as `database_identity` / `configured_databases`. At runtime `db.ready()` does the same check ([tenants.md](tenants.md#readiness-dbready)).
- **Adding a new database:** append the URL to the end of the list (in both environments), run `bootstrap`, restart the application ([operations.md](operations.md#adding-and-draining-databases)).

The config is plain data:

```ts
import { createConfig, loadConfig } from "@0furkancolak/pgcells";

const fromEnv = loadConfig();                     // process.env.DATABASE_URLS
const fromOther = loadConfig({ DATABASE_URLS: "postgres://…" });
const explicit = createConfig(["postgres://…/db0", "postgres://…/db1"]); // array or comma-separated string
const withReplicas = createConfig(["postgres://…/db0"], ["db0=postgres://…/replica"]); // second argument: `DATABASE_REPLICA_URLS` entries
// → { nodes: [{ id: "db0", url: "…", replicas: [] }, { id: "db1", url: "…", replicas: [] }] }
```

### URLs from code instead of the environment

`DATABASE_URLS` is only the default source. `createDatabase(config, options)` and `createManagement(config, options)` accept any `Config`, and `createConfig` takes an array, so a secret manager, a vault client or Workers bindings need no extra option or environment variable. Resolve first, then build the config (both factories are synchronous, so do the `await` before them):

```ts
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";

// Secret manager: one secret per node, keyed by the node id. Explicit ids make the pairing independent of list order.
const secrets = await vault.getMany(["pg/db0", "pg/db1"]);                      // your client
const config = createConfig(["db0", "db1"].map((id, i) => `${id}=${secrets[i]}`)); // → db0=…,db1=…
const db = createDatabase(config, { driver: bunDriver });
```

Rotation: a plain `Database` keeps its pools for the life of the process. `createRotatingDatabase` returns a `Database` you can re-point without a restart:

```ts
import { createRotatingDatabase } from "@0furkancolak/pgcells";

const db = await createRotatingDatabase(async () => createConfig(await readUrlsFromVault()), { driver: bunDriver });
await db.ready();
process.on("SIGHUP", () => void db.rotate().catch((error) => log.error(error))); // or your own schedule / secret-change webhook
```

`rotate()` calls the resolver again, opens a new `Database`, runs its `ready()`, and only then swaps it in and closes the old one gracefully (in-flight work gets the pool close timeout). If the resolver or `ready()` fails, the current `Database` stays in place and the error is thrown (it never contains the URL). Concurrent calls share one rotation, and the placement cache starts empty after a swap. The returned object forwards every `Database` member, so `dbMiddleware({ database: db })` and Better Auth use it unchanged. Nothing polls a secret source; calling `rotate()` is your job.

A single URL cannot reach several servers (a libpq URL names one endpoint; multi-host URLs are for failover, not routing). Several cells therefore mean several URLs here, or a pooler that maps database names to servers (PgBouncer `[databases]`); the tenant-to-database mapping stays in `platform.*` either way ([below](#direct-connection-and-pooler)).

## Direct connection and pooler

The application and management connect to **the same databases, in the same order, with the same credentials**; the difference is the connection type.

| Process | What `DATABASE_URLS` points at | Why |
|---|---|---|
| Application (`createDatabase`, `dbMiddleware`) | A transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Cloudflare Hyperdrive) | The query path uses no named prepared statements or session state; server-side timeouts are the database defaults. `db.ready()` checks this; on a direct connection it gives `POOLER_REQUIRED` |
| CLI, tools, management functions (`createManagement`) | Direct PostgreSQL or session pooling | migration, provision, move and recover hold session-level advisory locks; a transaction pooler drops these locks |

A cheap check runs when each management session is opened (once per URL): if an independent connection lands on the same backend, or the backend pid of the dedicated session changes, `DIRECT_CONNECTION_REQUIRED`. The check is best effort; a busy pooler can hide itself, and `doctor` reports the same result as `direct_connection`. `bootstrap` uses only transaction-level locks.

**A pooler is mandatory at runtime.** `db.ready()` (`pooler: "verified"`, the default) reserves two separate connections per database and asks for `pg_backend_pid()` in sequence: with a pooler the two clients see the same server session, with a direct connection they never can. If it is never seen, it throws `POOLER_REQUIRED` (the message contains only the database identity). The check is a heuristic: if the same session **is seen**, a pooler is certain; if not, the connection is direct or the pooler is very busy. For a false negative, `createDatabase(…, { pooler: "assumed" })` explicitly skips the check; this is only for environments where it cannot be tested (e.g. it is not yet verified that the check works on Hyperdrive). The result is stored once per database; calling `ready()` again in a health endpoint does not re-check. Call `ready()` at startup and in the `/ready` endpoint, not on the request path (on Workers a pool is built per request). In an application that never calls `ready()`, the requirement is not enforced.

**Replica URLs (optional).** `DATABASE_REPLICA_URLS=db0=urlA,db0=urlB,db1=urlC` (every process that calls `loadConfig`, the CLI included, validates the value; a malformed value stops config loading with `INVALID_CONFIG`): the key is the database identity, and repeating the same key adds multiple replicas to a database (at most 8). All URLs (primaries and replicas) must be unique, a replica cannot equal a primary, and an `options`/`search_path` parameter is forbidden; errors give `INVALID_CONFIG` and do not contain the value. Management ignores replicas. Replicas are used through an explicit read context: [replicas.md](replicas.md).

## Runtime options (`createDatabase`)

```ts
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";

const db = createDatabase({ driver: bunDriver, poolMax: 10 });                            // reads DATABASE_URLS
const other = createDatabase(createConfig(["postgres://…/db0"]), { driver: bunDriver }); // config by hand (Workers, tests)
```

Numeric options must be integers between 1 and the upper limit; a value outside that gives `INVALID_CONFIG`.

| Option | Default | Upper limit | Meaning |
|---|---:|---:|---|
| `driver` | — (required) | | `bunDriver`, `postgresDriver`, `pgDriver` or `neonDriver` (runtime only) |
| `poolMax` | 5 | 100 | Pool size per database (not per tenant); on db0 it is shared with platform reads |
| `statementTimeoutMs` | 5000 | 300000 | Deadline for acquiring a connection from the pool; if a statement is not answered within `statementTimeoutMs + 1 s` it is cancelled, its connection is discarded and `DATABASE_TIMEOUT` ([Timeouts and cancellation](#timeouts-and-cancellation)) |
| `idleTimeoutSeconds` | 20 | 300 | Time after which an idle connection is closed |
| `maxLifetimeSeconds` | 300 | 3600 | Maximum lifetime of a connection |
| `placementCacheMs` | 5000 | 25000 (`PLACEMENT_CACHE_MAX_MS`) | In-process placement cache (`active` records only) |
| `replicaMaxLagMs` | 5000 | 3600000 | Replica reads: a replica whose lag exceeds this is not used ([replicas.md](replicas.md)) |
| `replicaStatusMs` | 5000 | 60000 | Cache duration of the replica status (health + lag) |
| `replicaOnUnavailable` | `"primary"` | `"primary"` \| `"error"` | When no healthy replica exists, the read goes to the primary in a `READ ONLY` transaction, or `REPLICA_UNAVAILABLE` |
| `onSpan` | none | | Measurement callback; see [telemetry.md](telemetry.md) for OpenTelemetry/Sentry |

The fields of the returned object that you will use: `ready()`, `close()`, `withTenant(id, work)`, `withTenant.forPlacement(placement, work)`, `withTenantRead(id, work)`, `replicas()`, `withNode(databaseId, work)`, `withPlatform(work)`, `placement(id)`, `invalidatePlacement(id)`, `platform.get(id)`, `config`. Their use is covered in [queries.md](queries.md) and [tenants.md](tenants.md).

## Management options (`createManagement`)

```ts
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { createManagement } from "@0furkancolak/pgcells/management";

const management = createManagement({
  driver: postgresDriver, // DATABASE_URLS must be direct URLs; config by hand: createManagement(createConfig([...]), { driver })
  migrationConcurrency: 8,
  onPlacementChange: (tenantId) => placements.invalidatePlacement(tenantId), // @0furkancolak/pgcells-redis
});
// …
await management.close();
```

It also accepts the numeric options from the runtime table; in addition:

| Option | Default | Upper limit | Meaning |
|---|---:|---:|---|
| `migrationConcurrency` | 16 | 128 | Total concurrent tenants in bulk jobs (CLI `--concurrency`) |
| `perDatabaseConcurrency` | 4 | 64 | Concurrency per database and the management pool size (CLI `--per-db-concurrency`) |
| `migrationStatementTimeoutMs` | 30000 | 3600000 | `statement_timeout` in management jobs |
| `migrationLockTimeoutMs` | 1000 | 60000 | `lock_timeout` in management jobs |
| `shutdownGraceMs` | 10000 | 300000 | How long running jobs are waited for before being cancelled after the cancellation signal |
| `placementCacheWaitMs` | 30000 | 300000 | How long `move` and `demo-reset` wait after changing the placement before touching the data |
| `pageSize` | 100 | 1000 | Placement page size per database in bulk jobs |
| `onPlacementChange` | none | | Called after the placement state or database is committed; if it throws, the operation stops (the move stays resumable) |
| `onSpan` | none | | Durations of the management steps |

In management, `statementTimeoutMs` is not the connection acquisition time but the runtime `statement_timeout` value that `bootstrap` writes to the databases by default (`lock_timeout` = at most 1000). `poolMax` does not determine the management pool; the pool size is `perDatabaseConcurrency`. The CLI cannot change the management options and runs with the defaults (only `--concurrency` and `--per-db-concurrency` are given per job).

### Caveats

- **`placementCacheWaitMs` must be longer than the longest placement cache.** The runtime cache (`placementCacheMs`) and the `@0furkancolak/pgcells-redis` placement cache are at most 25 s; the default of 30 s is safe for that reason. Lowering the value below 25 s can let a process whose cache still shows the old database write to the tenant that was moved.
- **The application's `statementTimeoutMs` and management's `statementTimeoutMs` must be the same.** `bootstrap` writes the server-side timeout with management's value; the application's value is only a client-side deadline.

## Drivers

| | Bun SQL (`bunDriver`) | postgres.js (`postgresDriver`) | pg (`pgDriver`) | Neon (`neonDriver`) |
|---|---|---|---|---|
| Import | `@0furkancolak/pgcells/drivers/bun` | `@0furkancolak/pgcells/drivers/postgres` | `@0furkancolak/pgcells/drivers/pg` | `@0furkancolak/pgcells/drivers/neon` |
| Package | none (Bun only) | `postgres` | `pg` | `@neondatabase/serverless` |
| Environment | Bun | Bun, Node, Workers | Bun, Node, Workers (`nodejs_compat`) | Workers/edge, Bun, Node (WebSocket) |
| CLI | default | `--driver=postgres` | `--driver=pg` | none (runtime only) |

The runtime entry point (`@0furkancolak/pgcells`) loads no driver; the bundle contains only the driver you import.

The drivers use no named prepared statements (safe for PgBouncer/Hyperdrive); transactions, timeouts, cancellation and locks are engine code above the drivers, so behavior is the same across the four drivers. `@0furkancolak/pgcells` exports only the `Driver` type; writing a new driver is not a public API.

**Value types** are independent of the driver (the integration test compares the four drivers through PgBouncer):

| PostgreSQL | JS |
|---|---|
| int8, numeric | `string` |
| int2, int4, float4, float8 | `number` |
| timestamptz | `Date` |
| date | UTC midnight `Date` (use `::text` in SQL if you want text) |
| json, jsonb | parsed value |
| uuid, interval, time | `string` |
| inet, cidr, macaddr, tsvector, tsquery, range types | `string` (scalar only; their arrays differ across drivers and are rejected) |
| bytea | `Buffer` |
| arrays | JS array |

In parameters a `Date` is converted to ISO UTC text. Send JSON values with `JSON.stringify` + `$1::text::jsonb`; use JSON instead of an array parameter. postgres.js reads array types with one query per connection.

## Timeouts and cancellation

- `bootstrap` writes the runtime settings to each database as defaults (`ALTER DATABASE … SET statement_timeout = <statementTimeoutMs>`, `lock_timeout = min(statementTimeoutMs, 1000)`, `client_connection_check_interval = 1000`). PostgreSQL applies this to every new backend; that is why server-side cancellation also works with PgBouncer transaction pooling and Hyperdrive, with no session setting needed. `client_connection_check_interval` requires PostgreSQL 14: the running statement of a session whose client has disconnected is cut off on the server within 1 s at most.
- At runtime a single query is a single round trip; an open transaction is `BEGIN … COMMIT`.
- After changing the value, run `bootstrap` and refresh the pooler's server connections (PgBouncer `RECONNECT` or a restart): backends opened earlier keep the old value. `doctor` checks the database default as `runtime_timeouts`.
- The default applies to **every** session that connects to these databases; for long jobs with psql (`CREATE INDEX`, large `UPDATE`) use `SET statement_timeout = 0`.
- Connection acquisition has a client deadline: work whose time expires never starts (`DATABASE_TIMEOUT`), and a connection that arrives late is returned unused; the server statement timeout (`57014`) also becomes `DATABASE_TIMEOUT`. If the pending-work limit is exceeded, `DATABASE_BUSY`.
- **Statement deadline.** Every statement runs on the dedicated connection: a single query, `exec`, the transaction's `BEGIN` (also while the server waits behind PgBouncer), the statements in the body, `COMMIT` and `ROLLBACK`. If no answer arrives within `statementTimeoutMs + 1 s` (`SET LOCAL statement_timeout + 1 s` in a transaction):
  1. the connection is marked "expired": no other statement runs on it and it never returns to the pool (it is discarded and a new connection is opened in its place);
  2. if the driver supports it, the statement is cancelled on the server (postgres.js, pg: CancelRequest, which PgBouncer forwards to the right server) and the answer is awaited for at most 0.5 s. An answer that arrives in that time is returned as is (if the statement committed, the caller sees that); if none arrives, `DATABASE_TIMEOUT`. Bun SQL cannot cancel a running statement: the connection is discarded and the server cuts the statement off through `client_connection_check_interval`;
  3. after a statement that expired in a transaction, `COMMIT` is not sent; when the connection closes, the server rolls back the uncommitted transaction. A statement waiting in the PgBouncer queue never runs once the client closes.

  The caller gets an answer within `statementTimeoutMs + 1 s + 0.5 s` at most (deadlines fire on time through a single shared timer; no per-statement timer is set up). The one uncertainty is structural: if the deadline expires after `COMMIT` has reached the server but before its answer arrives, the commit may have happened.
- Management pools run every job in a transaction with `SET LOCAL` migration timeouts. Management sessions use session-level timeouts on a direct connection; cancellation is done from another connection with `pg_cancel_backend(pid)`, after which the session is closed.

## Deployment notes

### Bun server (Railway etc.)

`createDatabase({ driver: bunDriver })` once per process; `await db.close()` on SIGTERM. The application must point `DATABASE_URLS` at a transaction-mode pooler (PgBouncer etc.; `db.ready()` checks); run management commands with direct URLs in the same order (e.g. `bun run cli bootstrap` and `bun run cli migrate-all` in the deploy step).

### Cloudflare Workers + Hyperdrive

- The driver must be `postgresDriver` or `pgDriver` (Bun SQL does not work on Workers). `compatibility_flags: ["nodejs_compat"]` is required.
- The pooler check of `db.ready()` is not yet verified on Hyperdrive: pass `createDatabase(…, { pooler: "assumed" })` (Hyperdrive is a transaction pooler) or first verify that the check passes in your own account. If `ready()` gives `POOLER_REQUIRED`, check that the Hyperdrive URL is really being used, then switch to `assumed`.
- Create a separate Hyperdrive for each URL; the binding names follow the `DATABASE_URLS` order: `DB0`, `DB1` …
- Placement queries must not return stale results: caching must be off — `wrangler hyperdrive create <name> --connection-string="postgres://..." --caching-disabled`.
- Build the pool per request and close it after the response; sockets cannot outlive the request. Do not run management jobs from a Worker (through Hyperdrive).

```ts
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { listUsers } from "@0furkancolak/pgcells/queries/tenant/users"; // the application's query (getting-started.md step 4)

type Env = Record<string, { connectionString: string } | undefined>;

/** Hyperdrive bindings DB0, DB1 … in the DATABASE_URLS order */
export function workerConfig(env: Env) {
  const urls: string[] = [];
  for (let i = 0; env[`DB${i}`]; i++) urls.push(env[`DB${i}`]!.connectionString);
  return createConfig(urls);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const db = createDatabase(workerConfig(env), { driver: postgresDriver, poolMax: 1 });
    try {
      const tenantId = new URL(request.url).hostname.split(".")[0] ?? "";
      return Response.json(await db.withTenant(tenantId, (tenant) => tenant.query(listUsers, [20, 0])));
    } finally {
      ctx.waitUntil(db.close().catch(() => {}));
    }
  },
};
```

In a real application, resolve the tenant with `tenantFromHost(request.headers.get("host"), "example.com")` or use [`dbMiddleware({ perRequest: true, … })`](middleware-and-jobs.md#workers-per-request-pool). The package verifies, with `bun run build:workers`, that the runtime entry point bundles for Workers.

### Neon serverless driver

`neonDriver` uses Neon's WebSocket `Pool` (pg-compatible); it is for Workers and the edge runtime. Installation is an optional dependency:

```bash
bun add @neondatabase/serverless
```

```ts
import { neonDriver } from "@0furkancolak/pgcells/drivers/neon";

// Neon `-pooler` URLs (runtime). The pool is opened and closed within the request.
const db = createDatabase(createConfig([env.DB0_URL]), { driver: neonDriver, poolMax: 1 });
// …after the response: ctx.waitUntil(db.close())
```

Limits:

- **Runtime only.** Management (CLI, `bootstrap`, `migrate-all`; session advisory locks) needs the pg/postgres/bun driver and a direct URL; there is no `--driver=neon` in the CLI.
- **No `cancel`.** Cancelling with the Neon client opens a new TCP connection, and there is no TCP on Workers. After the deadline the connection is discarded; the server cuts the statement off through `client_connection_check_interval` (the same contract as Bun SQL).
- **The HTTP `neon()` function is not supported:** it offers no interactive session or dedicated connection.
- A WebSocket connection cannot outlive a single request: build the pool per request (`poolMax: 1`). Bun and Node ≥ 22 use the global `WebSocket`; on older Node set `neonConfig.webSocketConstructor`.
- In local tests the Neon client connects to the `wsproxy` service in `compose.yaml` (`127.0.0.1:5488`); `DB_DRIVER=neon bun run test:integration`.

### PgBouncer

PgBouncer is only one of the accepted poolers for the runtime (see the table above); the following is specific to PgBouncer.

- `pool_mode = transaction` and `max_prepared_statements = 0` (the local example ships with the package and `docker compose` uses it).
- The runtime timeouts are the database defaults that `bootstrap` writes; no extra startup parameter is needed. For server connections opened before `bootstrap`, `RECONNECT` is needed.
- A role that is not the database owner cannot run `ALTER DATABASE`: run `bootstrap` with the database owner (or an authorized role).
- `doctor --pgbouncer-url` reads the global `pool_mode` (it asks for the console URL — `postgres://…/pgbouncer` — through hidden input and does not write it to argv); verify database/user overrides separately with `SHOW POOLS`.
