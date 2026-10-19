/** Middleware entry point (`@0furkancolak/pgcells-single/middleware`): sets up the database and adds `db` to the request context (`query`, `transaction`,
 * `read.query`). Fits Hono's `(c, next)` shape (no dependency; `c.set` is enough).
 *
 *   app.use(dbMiddleware({ driver: bunDriver })); // Bun/Node: a single pool per process, DATABASE_URLS
 *   app.use(dbMiddleware({ driver: postgresDriver, perRequest: true, config: (c) => workerConfig(c.env) })); // Workers
 *   app.get("/users/:email", async (c) => c.json(await c.get("db").query(findUserByEmail, [c.req.param("email")]))); // the application's src/queries/users.sql
 *
 * Outside HTTP (cron, queue, Worker `scheduled`) the same structure is built with `createDbScope(db)`; the scope holds no pool, and the caller closes `db`. */
import { type Config, loadConfig } from "./core/config";
import type { Queryable, ReadContext, ReadSession } from "./core/context";
import type { Driver } from "./core/driver";
import { AppError } from "./core/errors";
import { createDb, type Db, type DbOptions } from "./core/runtime";

/** Request scope: if a write ran in the same request, later `read.query` reads stay on the primary (read-your-writes); reads are pinned to the same
 * replica (monotonic reads across calls). Consistency that carries over to another request is not guaranteed. */
export interface RequestDb extends Queryable {
  readonly read: ReadContext;
}
export type { Db };

export function createDbScope(db: Db): RequestDb {
  let wrote = false;
  const markWrite = () => void (wrote = true);
  const session: ReadSession = {};
  return Object.freeze<RequestDb>({
    query: ((query, values) => db.run((ctx) => ctx.query(query, values), markWrite)) as Queryable["query"],
    transaction: (work) => db.run((ctx) => ctx.transaction(work), markWrite),
    read: Object.freeze<ReadContext>({ query: ((query, values) => db.readRun((ctx) => ctx.query(query, values), wrote, session)) as ReadContext["query"] }),
  });
}

export interface MiddlewareContext {
  set(key: "db", value: RequestDb): void;
  env?: unknown;
  /** Hono/Workers: handed to `waitUntil` so that closing the `perRequest` pool does not delay the response. Hono throws on read when there is no context (Bun/Node). */
  readonly executionCtx?: { waitUntil(work: Promise<unknown>): void };
}

const executionContext = (c: MiddlewareContext) => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};

/** `createDb` options (`onSpan` is the measurement of the pool the middleware opens); the driver is optional here. */
type DbMiddlewareOptions<C extends MiddlewareContext> = Omit<DbOptions, "driver"> & {
  /** The database opened by the application (`createDb`): `ready()`, Better Auth and shutdown use the same pool; when given, `driver`, `config` and `perRequest` are not used. */
  database?: Db;
  driver?: Driver;
  /** Defaults to `loadConfig()` (`process.env.DATABASE_URLS`); on Workers, from the bindings. */
  config?: Config | ((c: C) => Config);
  /** Workers: a `poolMax: 1` pool per request, closed after the response (sockets cannot outlive the request). */
  perRequest?: boolean;
};

/** The database source options must be consistent; otherwise `INVALID_CONFIG`. */
function assertMiddlewareOptions({ database, driver, perRequest }: DbMiddlewareOptions<never>) {
  const hasOneDatabaseSource = !database !== !driver;
  if (!hasOneDatabaseSource || (!!database && !!perRequest))
    throw new AppError("INVALID_CONFIG", "dbMiddleware needs either database or driver (perRequest only with driver)");
}

export function dbMiddleware<C extends MiddlewareContext>(middlewareOptions: DbMiddlewareOptions<C>) {
  assertMiddlewareOptions(middlewareOptions);
  const { database, driver, config, perRequest, ...options } = middlewareOptions;
  let shared: Db | undefined = database;
  const openDb = (c: C) => createDb(typeof config === "function" ? config(c) : (config ?? loadConfig()), { ...options, driver: driver as Driver, ...(perRequest && { poolMax: 1 }) });

  return async (c: C, next: () => Promise<void>) => {
    const db = perRequest ? openDb(c) : (shared ??= openDb(c));
    c.set("db", createDbScope(db));
    try {
      await next();
    } finally {
      if (perRequest) {
        // Closing the socket does not wait for the response (on Workers `waitUntil` keeps the close alive until the end); without a context it is awaited. A close error does not change the response.
        const closing = db.close().catch(() => {});
        const context = executionContext(c);
        if (context) context.waitUntil(closing);
        else await closing;
      }
    }
  };
}
