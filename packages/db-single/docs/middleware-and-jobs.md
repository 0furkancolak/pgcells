# Middleware and background jobs

`@0furkancolak/pgcells-single/middleware` adds a `db` object to the HTTP request; outside HTTP (cron, queue, Worker `scheduled`) the same object is built with `createDbScope`.

## `dbMiddleware`

It has no dependencies; it works with any `(c, next)` middleware that has `c.set("db", value)` (Hono). `c.get("db")` is a `RequestDb`: `query`, `transaction`, `read.query` ([queries.md](queries.md)); it is passed straight to repository functions.

```ts
import { createDb } from "@0furkancolak/pgcells-single";
import { bunDriver } from "@0furkancolak/pgcells-single/drivers/bun";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells-single/middleware";
import { findUserByEmail, findUsers } from "@0furkancolak/pgcells-single/repositories/users";

const db = createDb({ driver: bunDriver, poolMax: 10 });
await db.ready();

const app = new Hono<{ Variables: { db: RequestDb } }>();
app.use(dbMiddleware({ database: db }));
app.get("/users", async (c) => c.json(await findUsers(c.get("db").read, 20)));        // replica or primary
app.get("/users/:email", async (c) => c.json(await findUserByEmail(c.get("db"), c.req.param("email"))));
```

| Option | Meaning |
|---|---|
| `database` | The application’s `createDb` instance (recommended): `ready()`, Better Auth and shutdown use the same pool. It cannot be combined with `driver` and `perRequest` (`INVALID_CONFIG`); `config` and the options that open a pool are ignored |
| `driver` | Without `database`, the middleware opens the pool itself on the first request. Exactly one of `database` and `driver` must be given |
| `config` | With `driver`: `Config` or `(c) => Config`; the default is `loadConfig()`, from bindings in Workers |
| `perRequest` | With `driver`: a per-request pool with `poolMax: 1`, closed when `next()` finishes (Workers/Hyperdrive) |
| `schema`, `pooler`, `onSpan`, `poolMax`, ... | Options of the pool it opens ([configuration.md](configuration.md#runtime-options-createdb)) |

An invalid combination (both or neither; `database` with `perRequest`) gives `INVALID_CONFIG` at setup.

For read-your-writes and replica pinning behavior, see [replicas.md](replicas.md).

### HTTP status mapping (example)

```ts
const STATUS: Record<string, number> = { "23505": 409, DATABASE_UNAVAILABLE: 503, DATABASE_BUSY: 503, REPLICA_UNAVAILABLE: 503, DATABASE_TIMEOUT: 504 };
app.onError((error, c) => {
  const raw = errorCode(error);
  // Errors such as PgBouncer 08P01 or a dropped connection reduce to a single code: DATABASE_UNAVAILABLE (503). 504 is only for DATABASE_TIMEOUT.
  const code = STATUS[raw] === undefined && databaseUnavailable(error) ? "DATABASE_UNAVAILABLE" : raw;
  return c.json({ error: code }, (STATUS[code] ?? 500) as 500);
});
```

### Readiness and shutdown

```ts
app.get("/ready", async (c) => {
  try { await db.ready(); return c.json({ ready: true }); }
  catch (error) { return c.json({ ready: false, error: errorCode(error) }, 503); }
});

const server = Bun.serve({ port: 8080, idleTimeout: 30, fetch: app.fetch });
process.once("SIGTERM", async () => { await server.stop(); await db.close(); });
```

`db.ready()` is bounded even on a closed DB (each step takes `statementTimeoutMs + 1 s`) but may exceed Bun’s default `idleTimeout` (10 s): cache the result in the health endpoint or raise `idleTimeout`.

## Workers: a pool per request

```ts
app.use(dbMiddleware({
  driver: postgresDriver,
  perRequest: true,
  pooler: "assumed", // the ready() probe is not verified on Hyperdrive
  config: (c) => createConfig(c.env.DB.connectionString),
}));
```

Hyperdrive caching must be off, and the driver must be `postgresDriver` or `pgDriver` ([configuration.md](configuration.md#deploy)).

## Outside HTTP

In cron, queue consumers and Worker `scheduled`, you usually need no scope: use `Db` directly (or the repository functions with `db`); `createDb` once per process (in Workers, `poolMax: 1` per invocation, `ctx.waitUntil(db.close())`). If code written for a request (a service expecting `RequestDb`) is to run in a job with the same read-your-writes behavior, `createDbScope(db)` builds the same object; the scope holds no pool, and whoever opened `db` closes it. In retried queue jobs, count `23505` as success if the write is idempotent.

## Common mistakes

- **`INVALID_CONFIG: dbMiddleware needs either database or driver`** — you passed both (or neither), or `database` with `perRequest`.
- **Two pools** — if you open `createDb` and also give the middleware a `driver`, the number of connections doubles and `db.close()` does not close the middleware’s; use `database`.
- **“Cannot perform I/O on behalf of a different request” in Workers** — the pool was shared between requests; use `perRequest: true`.
