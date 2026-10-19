# Configuration

The package reads one required environment variable (`DATABASE_URLS`) and one optional variable (`DATABASE_REPLICA_URLS`); every other setting is a typed option passed to the factories (`createDb`, `createManagement`, `dbMiddleware`) or a CLI flag. There are no other environment variables (`DB_DRIVER`, `RUN_INTEGRATION`, `TEST_POOLED_URLS` belong to the tests only).

## `DATABASE_URLS`

A single PostgreSQL URL (`postgres:` or `postgresql:`):

```sh
DATABASE_URLS=postgres://user:password@host:5432/db
```

An empty value, multiple URLs, or a URL that routes the schema through a connection parameter gives `INVALID_CONFIG` (the message does not contain the URL). `DATABASE_REPLICA_URLS` is a comma-separated plain URL list (at most 8, unique, different from the primary; if malformed, `loadConfig` gives `INVALID_CONFIG`, in the CLI too): [replicas.md](replicas.md). The config is plain data: `loadConfig()` (env), `createConfig(url, replicaUrls?)` (by hand; Workers, tests) → `{ url, replicas }`.

## Direct and pooler URL

The application and management connect to **the same DB with the same credentials**; the difference is the connection type.

| Process | What `DATABASE_URLS` points at | Why |
|---|---|---|
| Application (`createDb`, `dbMiddleware`) | A transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive) | The query path uses no named prepared statements or session state; server timeouts are DB defaults. `db.ready()` probes: `POOLER_REQUIRED` on a direct connection |
| CLI, tools, `createManagement` | Direct or session pooling | migrate, seed, baseline and restore hold a session advisory lock; a transaction pooler drops the lock |

When a management session opens, a cheap check runs once per URL (`DIRECT_CONNECTION_REQUIRED` if an independent connection lands on the same backend or the pid of the reserved session changes); it is best effort, and `doctor` reports the same thing as `direct_connection`.

**A pooler is required at runtime.** `db.ready()` (`pooler: "verified"`, the default) opens its own short-lived pool and asks `pg_backend_pid()` on two separate connections (at most ten rounds): behind a pooler two clients see the same server session, on a direct connection they do not. If it is not seen, `POOLER_REQUIRED`. If the pooler is real but the probe cannot see it (an unverified Hyperdrive, a very busy pooler), `pooler: "assumed"` skips the probe on purpose. The result is stored once; call `ready()` at startup and in `/ready`, not on the request path. The requirement is not enforced in an application that never calls `ready()`.

## Runtime options (`createDb`)

```ts
const db = createDb({ driver: bunDriver, poolMax: 10 });                                  // reads DATABASE_URLS
const other = createDb(createConfig("postgres://user:password@host:5432/db"), { driver: bunDriver, schema: "app" });
```

Numeric options are integers between 1 and the upper limit; anything else gives `INVALID_CONFIG`.

| Option | Default | Upper limit | Meaning |
|---|---:|---:|---|
| `driver` | required | | `bunDriver`, `postgresDriver`, `pgDriver`, `neonDriver` |
| `schema` | `"public"` | | The schema of the tables; every query is bound as `"<schema>".table`. Lowercase letters, digits, `_`; at most 63 bytes; `pg_*` and `information_schema` are forbidden (`INVALID_SCHEMA`) |
| `poolMax` | 5 | 100 | Pool size; each replica opens its own pool of the same size |
| `statementTimeoutMs` | 5000 | 300000 | Connection acquisition deadline; if a statement is not answered within `statementTimeoutMs + 1 s` it is cancelled, the connection is discarded, `DATABASE_TIMEOUT` |
| `idleTimeoutSeconds` | 20 | 300 | Lifetime of an idle connection |
| `maxLifetimeSeconds` | 300 | 3600 | Maximum lifetime of a connection |
| `replicaMaxLagMs` | 5000 | 3600000 | A replica whose lag exceeds this is not used |
| `replicaStatusMs` | 5000 | 60000 | Cache duration of the replica status |
| `replicaOnUnavailable` | `"primary"` | `"primary"` \| `"error"` | With no healthy replica, the read runs on the primary (a single statement if no replica is configured; a `READ ONLY` transaction if one is configured but unavailable) or gives `REPLICA_UNAVAILABLE` |
| `pooler` | `"verified"` | `"verified"` \| `"assumed"` | See above |
| `onSpan` | none | | Measurement ([telemetry.md](telemetry.md)) |

If the number of jobs waiting for a connection exceeds 64, `DATABASE_BUSY`. The returned object: `query`, `transaction`, `read.query`, `replicas()`, `ready()`, `close()`, `schema`, `config` ([queries.md](queries.md)).

## Management options (`createManagement`)

```ts
const management = createManagement({ driver: postgresDriver, schema: "public" }); // DATABASE_URLS: direct URL
await management.close();
```

It takes the runtime limits except `replicaOnUnavailable` and `pooler`; in addition `migrationStatementTimeoutMs` (30000, at most 3600000), `migrationLockTimeoutMs` (1000, at most 60000), `schema` and `onSpan`. In management, `statementTimeoutMs` is not a connection deadline but the runtime `statement_timeout` value that `migrate` writes as the DB default; `poolMax` does not set the management pool (fixed at 4). The CLI cannot change these options, runs with the defaults and takes only `--schema`. **The application’s `statementTimeoutMs` must be the same as what `migrate` wrote:** the server-side timeout comes from the DB default, while the application’s is only the client deadline.

## Drivers

| | `bunDriver` | `postgresDriver` | `pgDriver` | `neonDriver` |
|---|---|---|---|---|
| Import | `@0furkancolak/pgcells-single/drivers/bun` | `.../drivers/postgres` | `.../drivers/pg` | `.../drivers/neon` |
| Package | none (Bun only) | `postgres` | `pg` | `@neondatabase/serverless` |
| Environment | Bun | Bun, Node, Workers | Bun, Node, Workers (`nodejs_compat`) | Workers/edge, Bun, Node (WebSocket) |
| CLI | default | `--driver=postgres` | `--driver=pg` | none (runtime only) |

The runtime entry point does not load a driver; the bundle contains only what you import. Drivers use no named prepared statements (safe for PgBouncer/Hyperdrive); transactions, timeouts, cancellation and locks are engine code above the drivers, and behavior is the same across the four drivers. Value types are driver-independent: int8/numeric `string`; int2/int4/float4/float8 `number`; timestamptz `Date`; date is a `Date` at UTC midnight; json/jsonb the parsed value; uuid/interval/time/inet/cidr/macaddr/tsvector/tsquery/range types `string` (scalar only); bytea `Buffer`; arrays are JS arrays. A `Date` parameter is converted to ISO UTC text; send JSON with `JSON.stringify` + `$1::text::jsonb`.

## Timeouts and cancellation

- `migrate` writes the runtime settings as DB defaults (`statement_timeout`, `lock_timeout = min(statementTimeoutMs, 1000)`, `client_connection_check_interval = 1000`; PostgreSQL 14+): because they apply to every new backend, server-side cancellation also works with PgBouncer transaction pooling and Hyperdrive. This **requires DB ownership**, and when a value changes you need to run `migrate` again + refresh the pooler: [operations.md](operations.md#what-migrate-writes-to-the-database).
- Both connection acquisition and every statement have a client deadline: if acquisition does not complete within `statementTimeoutMs` or the response does not arrive within `statementTimeoutMs + 1 s`, `DATABASE_TIMEOUT` is given (and so is the server’s `57014`).
- A statement whose time has expired is cancelled (if the driver supports it) and its answer is awaited for another 0.5 s: an answer that arrives in that time is returned as is, otherwise `DATABASE_TIMEOUT` (worst-case delay `statementTimeoutMs + 1.5 s`). The connection is discarded; in a transaction, after the expired statement no statement is sent, `COMMIT` included, and the server rolls the work back. postgres.js and pg cancel the statement on the server, Bun SQL and the Neon driver cannot (the server cuts the statement via `client_connection_check_interval`). The one structural uncertainty: if `COMMIT` reaches the server but the deadline expires before its reply arrives, the commit may have happened.

## Deploy

**Bun server.** `createDb({ driver: bunDriver })` once per process; `await db.close()` on SIGTERM. `DATABASE_URLS` must go to the transaction pooler; management commands (`bun run db:migrate`) run in the deploy step with the direct URL.

**Cloudflare Workers + Hyperdrive.** `postgresDriver` or `pgDriver` (Bun SQL does not work in Workers), `compatibility_flags: ["nodejs_compat"]`. The `ready()` probe is not verified on Hyperdrive: `pooler: "assumed"`. Create Hyperdrive with caching off (`wrangler hyperdrive create <name> --connection-string="postgres://..." --caching-disabled`). Create the pool per request and close it after the response; do not run management jobs from a Worker. `bun run build:workers` verifies that the runtime entry point bundles for Workers.

```ts
export default {
  async fetch(_request: Request, env: { DB: { connectionString: string } }, ctx: ExecutionContext) {
    const db = createDb(createConfig(env.DB.connectionString), { driver: postgresDriver, poolMax: 1, pooler: "assumed" });
    try {
      return Response.json(await findUsers(db.read, 20));
    } finally {
      ctx.waitUntil(db.close().catch(() => {}));
    }
  },
};
```

**Neon serverless driver.** Uses a WebSocket `Pool`; it is meant for Workers/edge and is an optional dependency (`bun add @neondatabase/serverless`). Use it with the Neon `-pooler` URL and a per-request pool (`poolMax: 1`). Runtime only: management needs pg/postgres/bun and the direct URL. **There is no `cancel`** (no TCP in Workers): after the deadline the connection is discarded and the server cuts the statement via `client_connection_check_interval`. The HTTP `neon()` function is not supported. Bun and Node ≥ 22 use the global `WebSocket`; on older Node, set `neonConfig.webSocketConstructor`. For local testing, the `wsproxy` in `compose.yaml` (`:5489`) is used: `DB_DRIVER=neon bun run test:integration`.

**PgBouncer.** `pool_mode = transaction` and `max_prepared_statements = 0` (the package’s own config has them). `doctor --pgbouncer-url` reads the global `pool_mode` (the URL is asked through hidden input); verify DB/user overrides separately with `SHOW POOLS`.
