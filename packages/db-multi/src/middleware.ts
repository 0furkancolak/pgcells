/** Middleware entry point (`@0furkancolak/pgcells/middleware`): sets up the database and adds `db` to the request's context: within the same request,
 * `db.tenant`, `db.node` and `db.platform`. It follows Hono's `(c, next)` shape (no dependency; `c.req.header` and `c.set` are enough).
 *
 *   app.use(dbMiddleware({ driver: bunDriver, rootDomain: "example.com" })); // Bun/Node: one pool per process, DATABASE_URLS
 *   app.use(dbMiddleware({ driver: postgresDriver, rootDomain: "example.com", perRequest: true, config: (c) => workerConfig(c.env) })); // Workers
 *   app.get("/users/:email", async (c) => c.json(await c.get("db").tenant.query(findUserByEmail, [c.req.param("email")]))); // the application's src/queries/tenant/users.sql
 *
 * Outside HTTP (cron, queue, Worker `scheduled`) the same structure is built with `createDbScope(db, tenantId)`.
 *
 * The tenant and placement are resolved once, on the first tenant query (routes that do not use db never hit the DB); an invalid host gives
 * `INVALID_TENANT_ID`. If the `placement` option returns a cached placement (e.g. from Redis), the platform database is not read. */
import { type Config, type DatabaseOptions, loadConfig } from "./core/config";
import type { Driver } from "./core/driver";
import type { SpanHandler } from "./core/database";
import { AppError } from "./core/errors";
import { type CloseOptions, type CloseResult, createDatabase, type Database } from "./core/runtime";
import type { ReadContext, ReadSession, TenantContext } from "./core/tenants/context";
import { type Placement, tenantFromHost } from "./core/tenants/model";

/** Three separate contexts in the same unit of work: `tenant` is the tenant schema (`src/queries/tenant/`), `node` is the `platform` schema of the DB
 * where the tenant lives (`src/queries/node/`), and `platform` is the `platform` schema of db0 (`src/queries/platform/`). */
export interface RequestDb {
  readonly tenantId: string;
  readonly tenant: TenantContext;
  readonly node: TenantContext;
  readonly platform: TenantContext;
  /** Tenant read queries go to a replica (`readOnly` queries; see `docs/replicas.md`). If a write ran on `tenant` within the same request, the read
   * stays on the primary (read-your-writes); consistency across requests is not guaranteed. */
  readonly tenantRead: ReadContext;
  /** The tenant's placement, resolved once per scope (the same one the contexts use). */
  placement(): Promise<Placement>;
  /** The region this application runs in (`createDatabase({ region })`); `undefined` in single-region mode. */
  readonly region: string | undefined;
}

export type { Database };
/** A cached placement (e.g. `@0furkancolak/pgcells-redis` `createPlacementCache`); if it returns `undefined`, the built-in cache and the platform database are used.
 * The cache lifetime must be bounded by `PLACEMENT_CACHE_MAX_MS`: moves and demo resets wait for this duration. */
export type PlacementCache = (tenantId: string) => Placement | undefined | Promise<Placement | undefined>;

/** Use without HTTP (cron, queue consumer, Worker `scheduled`): `tenant` is a fixed id or a function called on first use.
 * The placement is resolved once per scope; the scope holds no pool, and the caller closes `db`. */
export function createDbScope(db: Database, tenant: string | (() => string), placement?: PlacementCache): RequestDb {
  let tenantId: string | undefined;
  let resolved: Promise<Placement> | undefined;
  const resolveTenant = () => (tenantId ??= typeof tenant === "string" ? tenant : tenant());
  const target = () =>
    (resolved ??= (async () => {
      const id = resolveTenant();
      return (await placement?.(id)) ?? db.placement(id);
    })());
  // If a write ran in the `tenant` context within the same request, subsequent reads go to the primary.
  let wrote = false;
  const markWrite = () => void (wrote = true);
  // Reads are pinned to the same replica; after a write they go to the primary (pinning is not used).
  const readSession: ReadSession = {};
  const context = (run: <T>(work: (t: TenantContext) => Promise<T>) => Promise<T>) => {
    const scoped: TenantContext = { query: (query, values) => run((t) => t.query(query, values)), transaction: (work) => run((t) => t.transaction(work)) };
    return Object.freeze(scoped);
  };
  return Object.freeze({
    get tenantId() {
      return resolveTenant();
    },
    placement: target,
    region: db.region,
    tenant: context(async (work) => db.withTenant.forPlacement(await target(), work, markWrite)),
    tenantRead: Object.freeze<ReadContext>({
      query: async (query, values) => {
        const placement = await target();
        return db.withTenantRead.forPlacement(placement, (t) => t.query(query, values), wrote, readSession);
      },
    }),
    node: context(async (work) => db.withNode((await target()).databaseId, work)),
    platform: context((work) => db.withPlatform(work)),
  });
}

export interface MiddlewareContext {
  req: { header(name: string): string | undefined };
  set(key: "db", value: RequestDb): void;
  env?: unknown;
}

interface DbMiddlewareOptions<C extends MiddlewareContext> extends DatabaseOptions {
  /** Measurement for the pool the middleware opens (`@0furkancolak/pgcells/telemetry`); if `database` is given, its `onSpan` applies. */
  onSpan?: SpanHandler;
  /** The database opened by the application (`createDatabase`): `ready()`, Better Auth, the placement cache and shutdown use the same pool;
   * if it is given, `driver`, `config` and `perRequest` are not used. */
  database?: Database;
  driver?: Driver;
  /** Defaults to `loadConfig()` (`process.env.DATABASE_URLS`); on Workers, from the bindings. */
  config?: Config | ((c: C) => Config);
  /** Workers: a `poolMax: 1` pool per request, closed after the response (sockets cannot outlive a request). */
  perRequest?: boolean;
  /** The root of the tenant subdomains: `"example.com"` for `abc.example.com` → `abc` (locally `["example.com", "localhost"]`). */
  rootDomain?: string | readonly string[];
  /** Custom resolution instead of `Host`; if not given, `rootDomain` is required. */
  tenant?: (c: C) => string;
  /** See `PlacementCache`. */
  placement?: (tenantId: string, c: C) => Placement | undefined | Promise<Placement | undefined>;
}

/** The tenant-resolution and database-source options must be consistent; otherwise `INVALID_CONFIG`. */
function assertMiddlewareOptions({ database, driver, perRequest, rootDomain, tenant }: DbMiddlewareOptions<never>) {
  const resolvesTenant = !!tenant || !!rootDomain?.length;
  if (!resolvesTenant) throw new AppError("INVALID_CONFIG", "dbMiddleware needs rootDomain (or a tenant resolver)");
  const hasOneDatabaseSource = !database !== !driver;
  const perRequestWithDatabase = !!database && !!perRequest;
  if (!hasOneDatabaseSource || perRequestWithDatabase)
    throw new AppError("INVALID_CONFIG", "dbMiddleware needs either database or driver (perRequest only with driver)");
}

export function dbMiddleware<C extends MiddlewareContext>(middlewareOptions: DbMiddlewareOptions<C>) {
  assertMiddlewareOptions(middlewareOptions);
  const { database, driver, config, perRequest, rootDomain, tenant, placement, ...options } = middlewareOptions;
  const resolveTenant = (c: C) => (tenant ? tenant(c) : tenantFromHost(c.req.header("host"), rootDomain ?? []));
  let shared: Database | undefined = database;
  const openDatabase = (c: C) => {
    const resolved = typeof config === "function" ? config(c) : (config ?? loadConfig());
    return createDatabase(resolved, { ...options, driver: driver as Driver, ...(perRequest && { poolMax: 1 }) });
  };

  const handler = async (c: C, next: () => Promise<void>) => {
    const db = perRequest ? openDatabase(c) : (shared ??= openDatabase(c));
    c.set(
      "db",
      createDbScope(db, () => resolveTenant(c), placement && ((id) => placement(id, c))),
    );
    try {
      await next();
    } finally {
      if (perRequest) await db.close().catch(() => {});
    }
  };
  /** Graceful shutdown for the shared database: refuses new requests' database work, waits for the started ones, closes the pools. Call it from your SIGTERM handler
   * after the load balancer stopped sending traffic. Does nothing with `perRequest` (each request closes its own pool). */
  const shutdown = async (closeOptions: CloseOptions = {}): Promise<CloseResult> => (shared ? shared.close({ drain: true, ...closeOptions }) : { drained: true, remaining: 0 });
  return Object.assign(handler, { shutdown });
}

export interface RegionGuardOptions<C> {
  /** `"421"` (default): answer `421 Misdirected Request` with the tenant's region. `"redirect"`: answer `307` to `locate(placement, c)`; without a URL it falls back to 421. */
  mode?: "421" | "redirect";
  /** The URL that serves this tenant from its own region (for `"redirect"`); keep the path and query yourself. */
  locate?: (placement: Placement, c: C) => string | undefined;
  /** Called for every request that reached the wrong region (metrics, logging). */
  onWrongRegion?: (placement: Placement, c: C) => void;
}

/** Stops a request that reached the wrong region before it touches any tenant data: if the tenant's node is in another region than `createDatabase({ region })`, it answers
 * `421` (or a `307` to `locate`) instead of talking to a database across an ocean. Without a `region` on the database, or for a node with no region, it does nothing.
 * Mount it after `dbMiddleware`; it resolves the placement, which the request's contexts reuse. Errors while resolving (unknown tenant, database down) are not caught here. */
export function regionGuard<C extends { get(key: "db"): RequestDb }>(options: RegionGuardOptions<C> = {}) {
  const { mode = "421", locate, onWrongRegion } = options;
  return async (c: C, next: () => Promise<void>): Promise<Response | void> => {
    const db = c.get("db");
    if (db.region === undefined) return next();
    const placement = await db.placement();
    if (!placement.region || placement.region === db.region) return next();
    onWrongRegion?.(placement, c);
    const target = mode === "redirect" ? locate?.(placement, c) : undefined;
    if (target) return new Response(null, { status: 307, headers: { location: target, "x-pgcells-region": placement.region } });
    return new Response(JSON.stringify({ error: "WRONG_REGION", region: placement.region }), {
      status: 421,
      headers: { "content-type": "application/json", "x-pgcells-region": placement.region },
    });
  };
}
