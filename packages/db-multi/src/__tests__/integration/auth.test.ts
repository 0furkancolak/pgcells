/** Better Auth tenant schema'larında, kendi bağdaştırıcımızla: runtime PgBouncer üzerinden, yönetim doğrudan. İzolasyon, çerezler, auth
 * türleri (user/student/teacher tek tenant'ta, çok türlü auth tabloları), 2FA tabloları, demo girişi, drift, üretim. */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { createPlatformAuth, createTenantAuth, tenantAuthDatabase } from "../../core/auth";
import { type AuthType, rateLimitTable } from "../../core/auth-schema";
import { bootstrap, provisionTenant, resetDemoTenant } from "../../management";
import { compileMigrations } from "../../core/migrations/source";
import type { Placement } from "../../core/tenants/model";
import { authSchemaDiff, generateAuthMigration } from "../../core/tools/auth";
import { DEMO_PASSWORD } from "../../seeds/demo/20260915155445_demo_login";
import authOptions, { authTypeOptions } from "../fixtures/auth-options";
import { createTestRuntime, enabled, integration, q, removeTenants } from "./helpers";

const SECRET = "integration-master-secret-0123456789";
const ROOT = "localhost";
const [ACME, GLOBEX, DEMO] = ["acme", "globex", "demo-auth"];
const DEMO_EMAIL = `demo@${DEMO}.example.com`;
const EMAIL = "same@example.com";
const PASSWORD = "Passw0rd!Passw0rd";
const AUTH_TYPES: readonly AuthType[] = ["user", "student", "teacher"];
/** Auth türünün kullanıcı ve 2FA tabloları (`20260915155444_auth.sql`). */
const TABLES = {
  user: { users: "users", twoFactor: "two_factor" },
  student: { users: "students", twoFactor: "student_two_factors" },
  teacher: { users: "teachers", twoFactor: "teacher_two_factors" },
} as const;
const cookieCache = { cookieCache: { enabled: true, maxAge: 300 } };
let runtime: ReturnType<typeof createTestRuntime>;
const placements: Record<string, Placement> = {};
const cookies: Record<string, string> = {};

beforeAll(async () => {
  if (!enabled) return;
  runtime = createTestRuntime();
  await bootstrap(runtime.management);
  for (const [id, databaseId] of [[ACME, "db0"], [GLOBEX, "db1"]] as const) {
    const p = (placements[id] = await provisionTenant(runtime.management, id, databaseId));
    // Sürücü başına tekrar çalışır: önceki kullanıcılar (oturum, hesap ve 2FA kayıtları cascade) silinir.
    const t = (name: string) => q(p.schemaName, name);
    await runtime.management.pools
      .node(databaseId)
      .exec(`DELETE FROM ${t("verification")}; DELETE FROM ${t("student_verifications")}; DELETE FROM ${t("teacher_verifications")}; DELETE FROM ${t("users")}; DELETE FROM ${t("students")}; DELETE FROM ${t("teachers")}`);
  }
});
afterAll(async () => {
  if (!runtime) return;
  try {
    await removeTenants(runtime.management, ACME, GLOBEX, DEMO);
  } finally {
    await runtime.close();
  }
});

/** cookieCache açık: ortak secret'la `createTenantAuth` bunu reddeder, bu yüzden tenant secret'ı. `secret` karşı örnek içindir. */
const tenantAuth = (secret?: string) =>
  createTenantAuth(runtime, (tenant) => betterAuth({ ...tenant.options, ...authOptions, ...(secret && { secret }), session: { ...authOptions.session, ...cookieCache } }), {
    secret: SECRET,
    rootDomain: ROOT,
    perTenantSecret: true,
  });
type Auth = { handler(request: Request): Promise<Response> };

async function call(auth: Auth, host: string, path: string, body?: unknown, cookie?: string, base = "/api/auth", headers: Record<string, string> = {}) {
  const res = await auth.handler(
    new Request(`https://${host}.${ROOT}${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", origin: `https://${host}.${ROOT}`, ...(cookie && { cookie }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  const cookie_ = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => c && !c.endsWith("=")).join("; ");
  return { status: res.status, json: text ? JSON.parse(text) : null, cookie: cookie_ };
}
const signIn = (auth: Auth, host: string, email = EMAIL, password = PASSWORD) => call(auth, host, "/sign-in/email", { email, password });

integration("the same email signs up, signs in and gets its own session in each tenant schema only", async () => {
  const authFor = tenantAuth();
  const ids: string[] = [];
  for (const host of [ACME, GLOBEX]) {
    const auth = await authFor(host);
    expect((await call(auth, host, "/sign-up/email", { email: EMAIL, password: PASSWORD, name: host })).status).toBe(200);
    const signedIn = await signIn(auth, host);
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toContain(`${host}.session_data=`);
    cookies[host] = signedIn.cookie;
    const session = await auth.api.getSession({ headers: new Headers({ cookie: signedIn.cookie }) });
    expect(session?.user.email).toBe(EMAIL);
    expect(session?.user.id).toMatch(/^[0-9a-f-]{36}$/); // generateId: false → gen_random_uuid()
    ids.push(session?.user.id ?? "");
  }
  expect(ids[0]).not.toBe(ids[1]);
  for (const p of Object.values(placements)) {
    const [rows] = await runtime.management.pools
      .node(p.databaseId)
      .query<{ users: string[]; accounts: number; sessions: number }>(
        `SELECT (SELECT array_agg(id::text) FROM ${q(p.schemaName, "users")}) AS users, (SELECT count(*)::int FROM ${q(p.schemaName, "account")}) AS accounts, (SELECT count(*)::int FROM ${q(p.schemaName, "session")}) AS sessions`,
      );
    expect(rows?.users).toEqual([ids[p.tenantId === ACME ? 0 : 1] as string]);
    expect(rows?.accounts).toBe(1);
    expect(rows?.sessions).toBeGreaterThanOrEqual(1);
  }
  for (const databaseId of ["db0", "db1"]) {
    const tables = await runtime.management.pools
      .node(databaseId)
      .query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('user','users','session','account','verification')`);
    expect(tables).toEqual([]);
  }
});

integration("with cookieCache a session cookie from one tenant is rejected by another, renamed or not (per-tenant secret)", async () => {
  const authFor = tenantAuth();
  const [acme, globex] = [await authFor(ACME), await authFor(GLOBEX)];
  const renamed = (cookies[ACME] ?? "").replaceAll(`${ACME}.`, `${GLOBEX}.`);
  expect((await call(acme, ACME, "/get-session", undefined, cookies[ACME])).json?.user.email).toBe(EMAIL);
  expect((await call(globex, GLOBEX, "/get-session", undefined, cookies[ACME])).json).toBeNull();
  expect((await call(globex, GLOBEX, "/get-session", undefined, renamed)).json).toBeNull();
  // Karşı örnek (make ortak secret'ı zorlar, denetim bilerek atlanır): yeniden adlandırılmış önbellek çerezi kabul edilir. Bu yüzden
  // createTenantAuth ortak secret'la cookieCache'i reddeder.
  const sharedFor = tenantAuth(SECRET);
  const shared = await signIn(await sharedFor(ACME), ACME);
  const leaked = await call(await sharedFor(GLOBEX), GLOBEX, "/get-session", undefined, shared.cookie.replaceAll(`${ACME}.`, `${GLOBEX}.`));
  expect(leaked.json?.user.email).toBe(EMAIL);
  expect(() => createTenantAuth(runtime, () => betterAuth({ ...authOptions, session: { ...authOptions.session, ...cookieCache } }), { secret: SECRET, rootDomain: ROOT })).not.toThrow();
  await expect(
    createTenantAuth(runtime, (tenant) => betterAuth({ ...tenant.options, ...authOptions, session: { ...authOptions.session, ...cookieCache } }), { secret: SECRET, rootDomain: ROOT })(ACME),
  ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
});

integration("user, student and teacher auth in one tenant: own tables and columns, own cookies, 2FA rows, sessions do not cross types", async () => {
  const email = "typed@example.com";
  const acme = placements[ACME] as Placement;
  const pool = runtime.management.pools.node(acme.databaseId);
  const cookieOf: Record<string, string> = {};
  type TypedAuth = Auth & { api: { getSession(context: { headers: Headers }): Promise<{ user: Record<string, unknown> } | null> } };
  const auths: Record<string, TypedAuth> = {};
  for (const authType of AUTH_TYPES) await pool.exec(`DELETE FROM ${q(acme.schemaName, TABLES[authType].users)} WHERE email = '${email}'`);
  for (const authType of AUTH_TYPES) {
    const make = (tenant: Parameters<Parameters<typeof createTenantAuth>[1]>[0]) => betterAuth({ ...tenant.options, ...authTypeOptions(authType) });
    const auth = (auths[authType] = (await createTenantAuth(runtime, make, { secret: SECRET, rootDomain: ROOT, authType })(ACME)) as unknown as TypedAuth);
    const base = `/api/auth/${authType}`;
    expect((await call(auth, ACME, "/sign-up/email", { email, password: PASSWORD, name: authType }, undefined, base)).status).toBe(200);
    const signedIn = await call(auth, ACME, "/sign-in/email", { email, password: PASSWORD }, undefined, base);
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toContain(`${authType}-${ACME}.session_token=`);
    cookieOf[authType] = signedIn.cookie;
    expect((await auth.api.getSession({ headers: new Headers({ cookie: signedIn.cookie }) }))?.user).toMatchObject({ email, name: authType, emailVerified: false });
    // twoFactor eklentisi auth türünün kendi 2FA tablosuna yazar (snake_case sütunlar).
    const enabled = await call(auth, ACME, "/two-factor/enable", { password: PASSWORD }, signedIn.cookie, base);
    expect(enabled.status).toBe(200);
    expect(enabled.json?.backupCodes).toHaveLength(10);
  }
  expect(await auths.student?.api.getSession({ headers: new Headers({ cookie: cookieOf.user ?? "" }) })).toBeNull();
  expect(await auths.teacher?.api.getSession({ headers: new Headers({ cookie: cookieOf.student ?? "" }) })).toBeNull();
  for (const authType of AUTH_TYPES) {
    const { users, twoFactor } = TABLES[authType];
    const [row] = await pool.query<{ n: number; factors: number }>(
      `SELECT count(*)::int AS n, (SELECT count(*)::int FROM ${q(acme.schemaName, twoFactor)} f JOIN ${q(acme.schemaName, users)} u ON u.id = f.user_id WHERE u.email = $1) AS factors
       FROM ${q(acme.schemaName, users)} WHERE email = $1`,
      [email],
    );
    expect(row).toEqual({ n: 1, factors: 1 });
  }
});

integration("a malformed id finds nothing on the uuid columns instead of failing the request", async () => {
  const adapter = (await tenantAuthDatabase(runtime, ACME))({ ...authTypeOptions("student"), advanced: { database: { generateId: false } } });
  expect(await adapter.findOne({ model: "user", where: [{ field: "id", value: "not-a-uuid" }] })).toBeNull();
  expect(await adapter.findMany({ model: "session", where: [{ field: "userId", operator: "in", value: ["x", "y"] }] })).toEqual([]);
  expect(await adapter.count({ model: "account", where: [{ field: "userId", value: "x" }] })).toBe(0);
  expect(await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "x" }] })).toBe(0);
});

/** Rate limit sayaçları için ayrı bir istemci IP'si; satırlar anahtar önekiyle (`<ip>|<yol>`) silinir. */
const testIp = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
const databaseRateLimit = (authType: AuthType) => ({
  enabled: true,
  storage: "database" as const,
  ...rateLimitTable(authType),
  customRules: { "/sign-in/email": { window: 60, max: 2 } },
});

integration("database rate limit: each auth type counts in its own tenant table, so one type's limit does not block another", async () => {
  const acme = placements[ACME] as Placement;
  const pool = runtime.management.pools.node(acme.databaseId);
  const ip = testIp();
  const tables = (["user", "student"] as const).map((authType) => q(acme.schemaName, rateLimitTable(authType).modelName));
  const limited = (authType: AuthType) =>
    createTenantAuth(runtime, (tenant) => betterAuth({ ...tenant.options, ...authTypeOptions(authType), rateLimit: databaseRateLimit(authType) }), {
      secret: SECRET,
      rootDomain: ROOT,
      authType,
    })(ACME);
  const attempt = async (auth: Auth, authType: AuthType) =>
    (await call(auth, ACME, "/sign-in/email", { email: "nobody@example.com", password: PASSWORD }, undefined, `/api/auth/${authType}`, { "x-forwarded-for": ip })).status;
  try {
    const [user, student] = [await limited("user"), await limited("student")];
    expect([await attempt(user, "user"), await attempt(user, "user"), await attempt(user, "user")]).toEqual([401, 401, 429]);
    expect(await attempt(student, "student")).toBe(401);
    const [row] = await pool.query<{ user: string; student: string }>(
      `SELECT (SELECT string_agg(key || '=' || count || ':' || (last_request > 0), ',') FROM ${tables[0]} WHERE starts_with(key, $1)) AS "user",
              (SELECT string_agg(key || '=' || count, ',') FROM ${tables[1]} WHERE starts_with(key, $1)) AS student`,
      [`${ip}|`],
    );
    expect(row).toEqual({ user: `${ip}|/sign-in/email=2:true`, student: `${ip}|/sign-in/email=1` });
  } finally {
    for (const table of tables) await pool.query(`DELETE FROM ${table} WHERE starts_with(key, $1)`, [`${ip}|`]);
  }
});

integration("panel auth on db0's platform schema: sign-up, sign-in, 2FA and a database rate limit use the migrated platform tables", async () => {
  const app = runtime.management;
  const platform = app.pools.node("db0");
  const email = `panel-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const ip = testIp();
  expect(await authSchemaDiff(app, { ...authTypeOptions("user"), rateLimit: databaseRateLimit("user") }, { databaseId: "db0", schema: "platform" })).toMatchObject({
    toBeCreated: [],
    toBeAdded: [],
    toBeAddedIndexes: [],
    typeMismatches: [],
    sql: "",
  });
  const panel = createPlatformAuth(runtime, ({ options }) => betterAuth({ ...options, ...authTypeOptions("user"), rateLimit: databaseRateLimit("user") }), {
    secret: SECRET,
    baseURL: `https://panel.${ROOT}`,
  })() as Auth;
  const base = "/api/auth/panel";
  const headers = { "x-forwarded-for": ip };
  try {
    expect((await call(panel, "panel", "/sign-up/email", { email, password: PASSWORD, name: "panel" }, undefined, base, headers)).status).toBe(200);
    const signedIn = await call(panel, "panel", "/sign-in/email", { email, password: PASSWORD }, undefined, base, headers);
    expect(signedIn.status).toBe(200);
    expect(signedIn.cookie).toContain("panel.session_token=");
    expect((await call(panel, "panel", "/two-factor/enable", { password: PASSWORD }, signedIn.cookie, base, headers)).status).toBe(200);
    expect((await call(panel, "panel", "/sign-in/email", { email, password: "wrong-password" }, undefined, base, headers)).status).toBe(401);
    expect((await call(panel, "panel", "/sign-in/email", { email, password: PASSWORD }, undefined, base, headers)).status).toBe(429);
    // Kayıt da oturum açar; rate limit sayacı yol başınadır ve reddedilen deneme sayılmaz.
    const [row] = await platform.query<{ users: number; sessions: number; factors: number; limits: string }>(
      `SELECT count(*)::int AS users,
              (SELECT count(*)::int FROM platform.session s WHERE s.user_id = u.id) AS sessions,
              (SELECT count(*)::int FROM platform.two_factor f WHERE f.user_id = u.id) AS factors,
              (SELECT string_agg(key || '=' || count, ',' ORDER BY key) FROM platform.rate_limit WHERE starts_with(key, $2)) AS limits
       FROM platform.users u WHERE u.email = $1 GROUP BY u.id`,
      [email, `${ip}|`],
    );
    expect(row).toEqual({ users: 1, sessions: 2, factors: 1, limits: [`${ip}|/sign-in/email=2`, `${ip}|/sign-up/email=1`, `${ip}|/two-factor/enable=1`].join(",") });
  } finally {
    await platform.query("DELETE FROM platform.users WHERE email = $1", [email]);
    await platform.query("DELETE FROM platform.rate_limit WHERE starts_with(key, $1)", [`${ip}|`]);
  }
});

integration("a demo tenant is login-ready right after provisioning and after a reset", async () => {
  const app = runtime.management;
  await provisionTenant(app, DEMO, "db0", { demo: true });
  expect((await signIn(await tenantAuth()(DEMO), DEMO, DEMO_EMAIL, DEMO_PASSWORD)).status).toBe(200);
  await resetDemoTenant(app, DEMO);
  const auth = await tenantAuth()(DEMO);
  expect((await signIn(auth, DEMO, DEMO_EMAIL, "wrong-password")).status).toBe(401);
  expect((await signIn(auth, DEMO, DEMO_EMAIL, DEMO_PASSWORD)).status).toBe(200);
});

integration("migrated tenant schemas match Better Auth options of every auth type; generation writes only a real diff with its --down", async () => {
  const app = runtime.management;
  for (const p of Object.values(placements))
    for (const authType of AUTH_TYPES)
      expect(await authSchemaDiff(app, authTypeOptions(authType), { databaseId: p.databaseId, schema: p.schemaName })).toMatchObject({
        toBeCreated: [],
        toBeAdded: [],
        toBeAddedIndexes: [],
        typeMismatches: [],
        sql: "",
      });
  const root = await mkdtemp(join(tmpdir(), "auth-generate-"));
  try {
    expect(await generateAuthMigration({ db: app, options: authOptions, root })).toEqual({ created: false });
    const options = { ...authOptions, user: { ...authOptions.user, additionalFields: { plan: { type: "string", required: false } } } } as const;
    const result = await generateAuthMigration({ db: app, options, root, name: "auth_plan" });
    if (!result.created) throw new Error("expected a migration");
    const text = await Bun.file(`${root}/${result.path}`).text();
    expect(text).toBe(`--up\nalter table "users" add column "plan" text;\n\n--down\nALTER TABLE "users" DROP COLUMN "plan";\n`);
    expect(compileMigrations("tenant", [[result.id, text]])[0]?.down?.bind(placements[ACME]?.schemaName ?? "")).toHaveLength(1);
    // Boolean alan timestamp sütununa eşlenmişse (teacher `email_verified`) fark tip uyuşmazlığıdır, dosya yazılmaz. Better Auth
    // alanları eşlenmiş sütun adına göre anahtarlar: var olan başka bir alanın adı (ör. `createdAt`) iki alanı birleştirir, bu yüzden
    // ayrı bir timestamp sütunu kullanılır.
    const schema = placements[ACME]?.schemaName ?? "";
    await app.pools.node("db0").exec(`ALTER TABLE ${q(schema, "users")} ADD COLUMN email_verified_at timestamptz`);
    try {
      const wrong = { ...authOptions, user: { ...authOptions.user, fields: { ...authOptions.user.fields, emailVerified: "email_verified_at" } } };
      const diff = await authSchemaDiff(app, wrong, { databaseId: "db0", schema });
      expect(diff.typeMismatches).toContainEqual({ table: "users", column: "email_verified_at", expected: "boolean", actual: "timestamp with time zone" });
    } finally {
      await app.pools.node("db0").exec(`ALTER TABLE ${q(schema, "users")} DROP COLUMN email_verified_at`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
