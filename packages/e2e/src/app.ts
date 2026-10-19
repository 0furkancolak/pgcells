/** E2E application: Hono + `dbMiddleware` (DATABASE_URLS → PgBouncer), Redis placement cache, BullMQ queue and Better Auth.
 * Tenant = the Host header `<tenant>.e2e.test`. */
import { betterAuth } from "better-auth";
import { Hono } from "hono";
import { AppError, createDatabase, databaseUnavailable, errorCode, loadConfig } from "@0furkancolak/pgcells";
import { authTables, createTenantAuth, importedPasswords } from "@0furkancolak/pgcells/auth";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { dbMiddleware, type RequestDb } from "@0furkancolak/pgcells/middleware";
import { getNodeIdentity } from "@0furkancolak/pgcells/queries/node/identity";
import { createPlacementCache, createRedis, createTenantQueue, loadRedisConfig } from "@0furkancolak/pgcells-redis";
import { countUsers, createUser, getUser, listUsers, log, placementTtl, throttled, type UserJob, UUID } from "./shared";

const ROOT = "e2e.test";

// Single pool: the middleware, ready(), the placement cache and Better Auth share the same database; one close on shutdown.
const db = createDatabase(loadConfig(), { driver: bunDriver, poolMax: Number(process.env.POOL_MAX ?? 5) });
const redis = createRedis(loadRedisConfig(), { onError: throttled("redis_error") });
const placements = createPlacementCache({ redis, db, ...placementTtl(), onError: throttled("placement_cache_error") });
const queue = createTenantQueue<UserJob>("users", { connection: redis.queue });
// `users`/`session`/`account`/`verification` tables (snake_case, uuid identifiers are generated in the database).
const authFor = createTenantAuth(
  db,
  (tenant) => betterAuth({ ...tenant.options, ...authTables("user"), emailAndPassword: { enabled: true, password: importedPasswords } }),
  { secret: process.env.BETTER_AUTH_SECRET ?? "", rootDomain: ROOT },
);

const STATUS: Record<string, number> = {
  BAD_REQUEST: 400, INVALID_TENANT_ID: 400, TENANT_NOT_FOUND: 404, NOT_FOUND: 404, "23505": 409,
  TENANT_UNAVAILABLE: 503, DATABASE_UNAVAILABLE: 503, DATABASE_BUSY: 503, DATABASE_TIMEOUT: 504,
};
/** Stable error code: connection/resource/shutdown errors (PgBouncer "no server" 08P01, driver connection codes) collapse into the single `DATABASE_UNAVAILABLE`. */
const codeOf = (error: unknown) => {
  const code = errorCode(error);
  return STATUS[code] === undefined && databaseUnavailable(error) ? "DATABASE_UNAVAILABLE" : code;
};
const failure = (code: string, status = STATUS[code] ?? 500) => Response.json({ error: code }, { status });

/** `{ name, id?, email? }`: the id is generated if missing, the email is derived from the id if missing (unique within the tenant). */
async function userBody(req: Request): Promise<UserJob> {
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; name?: unknown; email?: unknown };
  const id = body.id ?? crypto.randomUUID();
  const email = body.email ?? `${String(id)}@e2e.example`;
  if (typeof body.name !== "string" || !body.name || typeof id !== "string" || !UUID.test(id) || typeof email !== "string" || !email)
    throw new AppError("BAD_REQUEST", "name, optional uuid id and optional email");
  return { id, name: body.name, email };
}

const app = new Hono<{ Variables: { db: RequestDb } }>();
app.onError((error, c) => {
  const code = codeOf(error);
  if (!STATUS[code]) log("request_failed", { code, method: c.req.method, path: c.req.path });
  return failure(code);
});

app.get("/health", (c) => c.text("ok"));
/** `db.ready()` also returns at the response deadline for a down database behind PgBouncer (`statementTimeoutMs` + 1 s + cancel wait).
 * 504 only for `DATABASE_TIMEOUT`; every other not-ready case is 503. */
app.get("/ready", async (c) => {
  try {
    await db.ready();
    return c.json({ ready: true });
  } catch (error) {
    const code = codeOf(error);
    return Response.json({ ready: false, error: code }, { status: code === "DATABASE_TIMEOUT" ? 504 : 503 });
  }
});

app.use(dbMiddleware({ database: db, rootDomain: ROOT, placement: placements.loadPlacement }));

/** The database the tenant resolves to (from the cached placement): used to measure the cache refresh after a move. */
app.get("/where", async (c) => {
  const [row] = await c.get("db").node.query<{ databaseId: string }[]>(getNodeIdentity);
  return c.json({ tenantId: c.get("db").tenantId, databaseId: row?.databaseId });
});
app.get("/users", async (c) => c.json(await c.get("db").tenant.query(listUsers, [Math.min(Number(c.req.query("limit") ?? 20) || 20, 1000)])));
app.get("/users/count", async (c) => {
  const [row] = await c.get("db").tenant.query<{ n: number }[]>(countUsers);
  return c.json({ count: row?.n ?? 0 });
});
app.get("/users/:id", async (c) => {
  if (!UUID.test(c.req.param("id"))) return failure("BAD_REQUEST");
  const [row] = await c.get("db").tenant.query(getUser, [c.req.param("id")]);
  return row ? c.json(row) : failure("NOT_FOUND");
});
app.post("/users", async (c) => {
  const { id, name, email } = await userBody(c.req.raw);
  const [row] = await c.get("db").tenant.query(createUser, [id, name, email]);
  return c.json(row, 201);
});

/** Puts the job on the queue; the worker writes the user to the tenant schema. */
app.post("/jobs/users", async (c) => {
  const job = await userBody(c.req.raw);
  const tenantId = c.get("db").tenantId;
  await placements.loadPlacement(tenantId); // unknown tenant: TENANT_NOT_FOUND
  await queue.add(tenantId, "create-user", job, { jobId: job.id, attempts: 3, removeOnComplete: 1000, removeOnFail: 1000 });
  return c.json({ id: job.id }, 202);
});

/** Better Auth: baseURL is https://<tenant>.e2e.test; a local http request is rewritten to that address. */
app.all("/api/auth/*", async (c) => {
  const tenantId = c.get("db").tenantId;
  const origin = `https://${tenantId}.${ROOT}`;
  const url = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  headers.set("origin", origin);
  const body = ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.raw.arrayBuffer();
  return (await authFor(tenantId)).handler(new Request(`${origin}${url.pathname}${url.search}`, { method: c.req.method, headers, body }));
});
app.get("/me", async (c) => {
  const session = await (await authFor(c.get("db").tenantId)).api.getSession({ headers: c.req.raw.headers });
  return session ? c.json({ email: session.user.email }) : failure("UNAUTHORIZED", 401);
});

// idleTimeout (s): so that PgBouncer's 10 s query_wait_timeout error comes back as a response before Bun's default 10 s cutoff.
const server = Bun.serve({ port: Number(process.env.PORT ?? 8080), idleTimeout: 30, fetch: app.fetch });
log("app_started", { port: server.port });

process.once("SIGTERM", async () => {
  await server.stop();
  await queue.close();
  await Promise.all([db.close(), redis.close()]);
  process.exit(0);
});
