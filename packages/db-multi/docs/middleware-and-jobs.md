# Middleware and background jobs

`@0furkancolak/pgcells/middleware` adds a tenant-bound `db` object to the HTTP request; the same object is built outside HTTP (cron, queue consumer, Worker `scheduled`) with `createDbScope`. This document covers the `dbMiddleware` options, sharing the application's pool, the per-request pool on Workers, supplying the placement from a cache, and work outside requests.

## `dbMiddleware`

It has no dependencies; it works with any `(c, next)` middleware that has `c.req.header(name)` and `c.set("db", value)` (Hono).

```ts
import { Hono } from "hono";
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells/middleware";
import { getNodeIdentity } from "@0furkancolak/pgcells/queries/node/identity";
import { listTenants } from "@0furkancolak/pgcells/queries/platform/tenants";
import { listUsers } from "@0furkancolak/pgcells/queries/tenant/users"; // the application's query (getting-started.md step 4)

const db = createDatabase({ driver: bunDriver, poolMax: 10 });
await db.ready();

const app = new Hono<{ Variables: { db: RequestDb } }>();
app.use(dbMiddleware({ database: db, rootDomain: "example.com" }));

app.get("/users", async (c) => c.json(await c.get("db").tenant.query(listUsers, [20, 0])));
app.get("/overview", async (c) => {
  const request = c.get("db");
  const [users, [node], tenants] = await Promise.all([
    request.tenant.query(listUsers, [20, 0]),        // the tenant schema
    request.node.query(getNodeIdentity),              // the tenant's database, platform schema
    request.platform.query(listTenants, [20, 0]),     // db0, platform schema
  ]);
  return c.json({ tenantId: request.tenantId, users, node, tenants });
});
```

### Options

| Option | Meaning |
|---|---|
| `database` | The application's `createDatabase` instance. Recommended: `ready()`, Better Auth, the placement cache and shutdown (`await db.close()`) use the same pool. If given, `driver`, `config`, `perRequest` and the pool options are not used. |
| `driver` | If `database` is not given: the middleware opens the pool itself on the first request. Exactly one of `database` and `driver` must be given. |
| `config` | With `driver`: a `Config` or `(c) => Config`. Default `loadConfig()` (`process.env.DATABASE_URLS`); on Workers from the bindings. |
| `perRequest` | With `driver`: opens a `poolMax: 1` pool per request and closes it after `next()` finishes (Workers/Hyperdrive). |
| `rootDomain` | The root of the tenant subdomains: `"example.com"` or a list (`["example.com", "localhost"]`). Required if `tenant` is not given. |
| `tenant` | `(c) => string`: custom resolution instead of `Host` (e.g. a path parameter, a JWT claim). |
| `placement` | `(tenantId, c) => Placement \| undefined \| Promise<…>`: the cached placement. If it returns `undefined`, the built-in cache and the platform database are used. |
| `poolMax`, `statementTimeoutMs`, `idleTimeoutSeconds`, `maxLifetimeSeconds`, `placementCacheMs` | Options of the pool opened with `driver` ([configuration.md](configuration.md#runtime-options-createdatabase)) |

Invalid combinations give `INVALID_CONFIG` at setup: neither `rootDomain` nor `tenant`; both `database` and `driver` (or neither); `database` with `perRequest`.

### Behavior

- The tenant and placement are resolved once, on the first use of `db`; routes that do not use `db` never go to the database.
- Errors are the same as `withTenant`: `INVALID_TENANT_ID` (the host does not match), `TENANT_NOT_FOUND`, `TENANT_UNAVAILABLE`. These are thrown at the `c.get("db").tenant.query(…)` call; mapping them to HTTP status is the application's job.
- Each database has a single pool: node queries use the same pool as that database's tenants, platform queries use the db0 pool.
- `c.get("db")`: `tenantId`, `tenant`, `node`, `platform`; each is of the form `query(query, values)` and `transaction(async (tx) => …)` ([queries.md](queries.md)).

### HTTP status mapping (example)

```ts
import { databaseUnavailable, errorCode } from "@0furkancolak/pgcells";

const STATUS: Record<string, number> = {
  INVALID_TENANT_ID: 400, TENANT_NOT_FOUND: 404, "23505": 409,
  TENANT_UNAVAILABLE: 503, DATABASE_UNAVAILABLE: 503, DATABASE_BUSY: 503, DATABASE_TIMEOUT: 504,
};
app.onError((error, c) => {
  const raw = errorCode(error);
  // Errors such as PgBouncer 08P01 or a dropped connection collapse into one stable code: DATABASE_UNAVAILABLE (503). 504 is only DATABASE_TIMEOUT.
  const code = STATUS[raw] === undefined && databaseUnavailable(error) ? "DATABASE_UNAVAILABLE" : raw;
  return c.json({ error: code }, (STATUS[code] ?? 500) as 500);
});
```

### Readiness and shutdown

```ts
app.get("/ready", async (c) => {
  try {
    await db.ready();
    return c.json({ ready: true });
  } catch (error) {
    return c.json({ ready: false, error: errorCode(error) }, 503);
  }
});

const server = Bun.serve({ port: 8080, idleTimeout: 30, fetch: app.fetch });
process.once("SIGTERM", async () => {
  await server.stop();
  // Refuses new database work (ready() fails), lets started requests finish, then closes the pools.
  await db.close({ drain: true, timeoutMs: 10_000 });
});
```

`dbMiddleware(...)` returns a handler with a `shutdown(options?)` method that does the same for the shared database (`database` option or the one the middleware opened); it does nothing with `perRequest`.

`db.ready()` is bounded even with a database that is down behind PgBouncer: the identity/record check takes `statementTimeoutMs + 1 s`, then (only until the first successful result) the pooler check runs with its own `statementTimeoutMs + 1 s` limit; with the defaults the worst case is about 14 s, which is above Bun's default `idleTimeout` (cache the `ready()` result in the health endpoint or raise `idleTimeout`). Bun's default `idleTimeout` is 10 s; give a longer `idleTimeout` so that PgBouncer's `query_wait_timeout` (default 10 s) error can be returned as a response.

## Placement from a cache

In a single process the built-in cache (`placementCacheMs`, default 5 s) is enough. In a multi-process setup, supply the placement from Redis:

```ts
import { createPlacementCache, createRedis, loadRedisConfig } from "@0furkancolak/pgcells-redis";

const redis = createRedis(loadRedisConfig());
const placements = createPlacementCache({ redis, db });
app.use(dbMiddleware({ database: db, rootDomain: "example.com", placement: placements.loadPlacement }));
```

The returned placement is used and the platform database is not read. The cache duration is bounded by `PLACEMENT_CACHE_MAX_MS` (25 s) and `move`/`demo-reset` wait longer than that; so a record pointing at the old database does not cause lost writes. If you pass `onPlacementChange` to the management context, invalidation happens immediately. Details: [`@0furkancolak/pgcells-redis` placement cache](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/placement-cache.md).

## Workers: per-request pool

```ts
import { createConfig } from "@0furkancolak/pgcells";
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells/middleware";

type Bindings = { DB0: { connectionString: string }; DB1: { connectionString: string } };
const app = new Hono<{ Bindings: Bindings; Variables: { db: RequestDb } }>();
app.use(
  dbMiddleware({
    driver: postgresDriver,
    perRequest: true,
    rootDomain: "example.com",
    config: (c) => createConfig([c.env.DB0.connectionString, c.env.DB1.connectionString]),
  }),
);
export default app;
```

Hyperdrive caching must be off and the driver must be `postgresDriver` or `pgDriver` ([configuration.md](configuration.md#cloudflare-workers--hyperdrive)).

## Outside HTTP: `createDbScope`

```ts
createDbScope(db, tenantId, placement?) // → RequestDb: { tenantId, tenant, tenantRead, node, platform }
```

- `db`: a `createDatabase` instance. The scope holds no pool; whoever opened the pool closes it.
- `tenantId`: a fixed ID, or a `() => string` called on first use.
- `placement`: an optional placement cache (e.g. `placements.loadPlacement`); the placement is resolved once per scope.
- `tenantRead`: reading from a replica (`tenantRead.query(q)`); if a write has run on `tenant` in the same scope, the read stays on the primary ([replicas.md](replicas.md)).
- If only `platform` will be used, `""` can be given as the tenant ID: it is not resolved unless `tenant`, `node` or `tenantId` is used (if used, `INVALID_TENANT_ID`).

### Bun/Node cron

```ts
import { createDatabase, errorCode } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createDbScope } from "@0furkancolak/pgcells/middleware";
import { listTenants } from "@0furkancolak/pgcells/queries/platform/tenants";
import { listUsers } from "@0furkancolak/pgcells/queries/tenant/users"; // the application's query

const db = createDatabase({ driver: bunDriver, poolMax: 3 }); // once per process

async function nightly() {
  const tenants = await createDbScope(db, "").platform.query<{ tenantId: string; status: string }[]>(listTenants, [1000, 0]);
  for (const { tenantId, status } of tenants) {
    if (status !== "active") continue;
    try {
      const users = await createDbScope(db, tenantId).tenant.query(listUsers, [100, 0]);
      // … work
    } catch (error) {
      console.error(JSON.stringify({ tenantId, code: errorCode(error) }));
    }
  }
}
const timer = setInterval(() => void nightly(), 60 * 60 * 1000);
process.once("SIGTERM", async () => {
  clearInterval(timer);
  await db.close();
});
```

`listTenants` is paginated (`LIMIT $1 OFFSET $2`); for thousands of tenants, page through it in a loop.

### Worker `scheduled`

```ts
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { postgresDriver } from "@0furkancolak/pgcells/drivers/postgres";
import { createDbScope } from "@0furkancolak/pgcells/middleware";
import { listTenants } from "@0furkancolak/pgcells/queries/platform/tenants";
import { expireSessions } from "@0furkancolak/pgcells/queries/tenant/sessions"; // your own query

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const db = createDatabase(createConfig([env.DB0.connectionString, env.DB1.connectionString]), { driver: postgresDriver, poolMax: 1 });
    ctx.waitUntil(
      (async () => {
        try {
          const tenants = await createDbScope(db, "").platform.query<{ tenantId: string }[]>(listTenants, [100, 0]);
          for (const { tenantId } of tenants) await createDbScope(db, tenantId).tenant.query(expireSessions);
        } finally {
          await db.close();
        }
      })(),
    );
  },
};
```

### Queues (BullMQ)

`@0furkancolak/pgcells-redis` `createTenantWorker` builds `createDbScope(db, job.data.tenantId, placement)` for each job and gives the handler `{ tenantId, db }`: [`@0furkancolak/pgcells-redis` queues](https://github.com/0furkancolak/pgcells/blob/main/packages/redis/docs/queues.md).

## Regions: `regionGuard`

With `createDatabase({ region: "eu-west" })` a tenant context for a tenant whose node is in another region fails with `WRONG_REGION` instead of reaching a database across an ocean. `regionGuard` turns that into an HTTP answer *before* the route runs, and `createDbScope`/`RequestDb` expose `placement()` and `region` for your own checks:

```ts
import { dbMiddleware, regionGuard } from "@0furkancolak/pgcells/middleware";

app.use(dbMiddleware({ database: db, rootDomain: "example.com" }));
app.use(regionGuard({ mode: "redirect", locate: (placement, c) => `https://${placement.region}.example.com${new URL(c.req.url).pathname}` }));
```

`mode: "421"` (default) answers `421 Misdirected Request` with the tenant's region in the body and in `x-pgcells-region`; `"redirect"` answers `307` to `locate(placement, c)` and falls back to 421 without a URL. `onWrongRegion` (on the guard, and on `createDatabase`) is a hook for metrics; it cannot allow the request. Without `region` on the database, or for a node with no region, the guard does nothing. Getting the request to the right region in the first place (geo DNS, an edge router) is not the library's job. See the [regions guide](https://github.com/0furkancolak/pgcells/blob/main/docs/guides/regions.md#5-routing-a-request-to-the-right-region).

## Common errors

- **`INVALID_CONFIG: dbMiddleware needs either database or driver`** — you gave both (or neither); or you gave `perRequest: true` together with `database`.
- **Two pools** — if you open a `createDatabase` and also give the middleware a `driver`, there are two separate pools in the process (the number of database connections doubles, and `db.close()` does not close the middleware's). Use the `database` option.
- **"Cannot perform I/O on behalf of a different request" on Workers** — the pool was shared across requests; use `perRequest: true`.
