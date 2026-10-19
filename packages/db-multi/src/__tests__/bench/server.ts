/** Benchmark HTTP harness. Uses only the package's public entry points: `@0furkancolak/pgcells` (createDatabase, tenantFromHost, withTenant),
 * a driver from `@0furkancolak/pgcells/drivers/*`, generated queries, `prepareQuery` (`@0furkancolak/pgcells/management`; for bench-specific reads,
 * compiled once at startup, same compiler as codegen) and `@0furkancolak/pgcells/auth`. Tenant = Host header `<id>.bench.test` or `?tenant=<id>`.
 * Env: DATABASE_URLS (PgBouncer URLs), BENCH_DRIVER=bun|postgres|pg, BENCH_POOL_MAX (per DB, default 10), PORT, BETTER_AUTH_SECRET. */
import { betterAuth } from "better-auth";
import { createDatabase, errorCode, loadConfig, type Placement, tenantFromHost } from "@0furkancolak/pgcells";
import { authTables, createTenantAuth } from "@0furkancolak/pgcells/auth";
import { prepareQuery } from "@0furkancolak/pgcells/management";
import { loadDriver } from "./drivers";
import { benchEmail, uuidOf } from "./lib";

const driverName = process.env.BENCH_DRIVER ?? "bun";
const driver = await loadDriver(driverName);
const poolMax = Number(process.env.BENCH_POOL_MAX ?? 10);
const db = createDatabase(loadConfig(), { driver, poolMax });

// "Normal" baseline (/raw/*): same driver and URLs, hand-written schema-qualified SQL; no package routing, placement
// is read once at startup.
const rawPools = (process.env.DATABASE_URLS ?? "").split(",").map((url) => driver(url, { max: poolMax, idleTimeoutSeconds: 30, maxLifetimeSeconds: 1800, connectTimeoutSeconds: 10 }));
const rawPlacements = new Map(
  (await rawPools[0]!.query<{ tenant_id: string; database_id: string; schema_name: string }>("SELECT tenant_id, database_id, schema_name FROM platform.placements")).map(
    (p) => [p.tenant_id, { pool: rawPools[Number(p.database_id.slice(2))]!, schema: `"${p.schema_name}"` }],
  ),
);
const rawTarget = (tenantId: string) => rawPlacements.get(tenantId) ?? Promise.reject(Object.assign(new Error(tenantId), { code: "TENANT_NOT_FOUND" }));
const authFor = createTenantAuth(db, (tenant) => betterAuth({ ...tenant.options, ...authTables("user"), emailAndPassword: { enabled: true } }), {
  secret: process.env.BETTER_AUTH_SECRET ?? "",
  rootDomain: "bench.test",
  max: 1000,
});

const getUser = prepareQuery("SELECT id::text AS id, name, email FROM users WHERE id = $1::uuid");
// ORDER BY users.id (not the text alias `id`): the primary key index serves the page.
const pageUsers = prepareQuery("SELECT id::text AS id, name FROM users WHERE id > $1::uuid ORDER BY users.id LIMIT $2");
const insertUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text) RETURNING id::text AS id, name");

const placementCache = new Map<string, Placement>();
const counts = { requests: 0, errors: {} as Record<string, number> };
const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, INVALID_TENANT_ID: 400, TENANT_NOT_FOUND: 404, NOT_FOUND: 404, TENANT_UNAVAILABLE: 503, DATABASE_BUSY: 503, DATABASE_TIMEOUT: 504,
};
const fail = (code: string) => {
  counts.errors[code] = (counts.errors[code] ?? 0) + 1;
  return Response.json({ error: code }, { status: STATUS[code] ?? 500 });
};
function intParam(url: URL, name: string) {
  const value = Number(url.searchParams.get(name));
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error(name), { code: "BAD_REQUEST" });
  return value;
}

type Handler = (tenantId: string, url: URL, req: Request) => Promise<Response>;
const routes: Record<string, Handler> = {
  "GET /point": async (tenantId, url) => {
    const [row] = await db.withTenant(tenantId, (tenant) => tenant.query(getUser, [uuidOf(intParam(url, "id"))]));
    return row ? Response.json(row) : fail("NOT_FOUND");
  },
  "GET /range": async (tenantId, url) =>
    Response.json(await db.withTenant(tenantId, (tenant) => tenant.query(pageUsers, [uuidOf(intParam(url, "after")), Math.min(intParam(url, "limit"), 100)]))),
  "POST /insert": async (tenantId) => {
    const id = crypto.randomUUID();
    await db.withTenant(tenantId, (tenant) => tenant.transaction((tx) => tx.query(insertUser, [id, "bench insert", benchEmail(id)])));
    return Response.json({ id }, { status: 201 });
  },
  /** Package path that takes placement from the cache (`dbMiddleware({ placement })` does this with Redis): no platform read. */
  "GET /cached/point": async (tenantId, url) => {
    let placement = placementCache.get(tenantId);
    if (!placement) placementCache.set(tenantId, (placement = await db.platform.get(tenantId)));
    const [row] = await db.withTenant.forPlacement(placement, (tenant) => tenant.query(getUser, [uuidOf(intParam(url, "id"))]));
    return row ? Response.json(row) : fail("NOT_FOUND");
  },
  "GET /raw/point": async (tenantId, url) => {
    const { pool, schema } = await rawTarget(tenantId);
    const [row] = await pool.query(`SELECT id::text AS id, name, email FROM ${schema}.users WHERE id = $1::uuid`, [uuidOf(intParam(url, "id"))]);
    return row ? Response.json(row) : fail("NOT_FOUND");
  },
  "POST /raw/insert": async (tenantId) => {
    const { pool, schema } = await rawTarget(tenantId);
    const id = crypto.randomUUID();
    const tx = await pool.reserve();
    try {
      await tx.exec("BEGIN");
      await tx.query(`INSERT INTO ${schema}.users (id, name, email) VALUES ($1::uuid, $2, $3) RETURNING id::text AS id, name`, [id, "bench insert", benchEmail(id)]);
      await tx.exec("COMMIT");
    } catch (error) {
      await tx.exec("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
    return Response.json({ id }, { status: 201 });
  },
  /** Signs in once; returns the session cookie (k6 sends it back to /auth/session). */
  "POST /auth/sign-in": async (tenantId, _url, req) => {
    const auth = await authFor(tenantId);
    const res = await auth.handler(
      new Request(`https://${tenantId}.bench.test/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: `https://${tenantId}.bench.test` },
        body: await req.text(),
      }),
    );
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c && !c.endsWith("=")).join("; ");
    return Response.json({ cookie }, { status: res.status });
  },
  "GET /auth/session": async (tenantId, _url, req) => {
    const session = await (await authFor(tenantId)).api.getSession({ headers: req.headers });
    return session ? Response.json({ userId: session.user.id }) : fail("UNAUTHORIZED");
  },
};

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/metrics") {
      const memory = process.memoryUsage();
      const mib = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
      return Response.json({ driver: driverName, rssMiB: mib(memory.rss), heapUsedMiB: mib(memory.heapUsed), uptimeS: Math.round(process.uptime()), ...counts });
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return fail("NOT_FOUND");
    counts.requests++;
    try {
      return await handler(tenantFromHost(url.searchParams.has("tenant") ? `${url.searchParams.get("tenant")}.bench.test` : req.headers.get("host"), "bench.test"), url, req);
    } catch (error) {
      return fail(errorCode(error) ?? "UNKNOWN");
    }
  },
});

process.once("SIGTERM", async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});
