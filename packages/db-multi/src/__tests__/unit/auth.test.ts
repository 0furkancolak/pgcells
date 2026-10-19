/** `@0furkancolak/pgcells/auth`: secret (ortak / HKDF), tenant ve platform varsayılanları, LRU, örnek denetimleri, motor üzerindeki Better Auth
 * bağdaştırıcısının SQL'i ve transaction'ı, Better Auth migration dilbilgisi. */
import { expect, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { type AuthOptions, type AuthTenant, createPlatformAuth, createTenantAuth, tenantAuthDatabase, tenantAuthSecret } from "../../core/auth";
import { authTables, type AuthType, rateLimitTable, twoFactorTables } from "../../core/auth-schema";
import { connect, type Database } from "../../core/database";
import { migrationTables, tenantMigrations } from "../../core/migrations/registry";
import { prepareMigration } from "../../core/sql/compiler";
import { foldTables, tableModules } from "../../core/sql/tables";
import { type Placement, tenantSchema } from "../../core/tenants/model";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const SECRET = "m".repeat(32);
/** `generateId: false` iken `id` ve başvuran alanlar `uuid` sütunudur. */
const UUID = "0f8b2f5e-8c1d-4a55-9d61-2d6c1f0b7a10";
const POOL = { max: 2, idleTimeoutSeconds: 1, maxLifetimeSeconds: 1, connectTimeoutSeconds: 1 };

function fakeRuntime(handler?: Handler) {
  const fake = fakeDriver(handler);
  const state: Partial<Placement> = { databaseId: "db0", status: "active" };
  const databases = new Map<string, Database>();
  const node = (id: string) => {
    if (!databases.has(id)) databases.set(id, connect(fake.driver(id, POOL), { deadlineMs: 5000, maxPending: 8 }));
    return databases.get(id) as Database;
  };
  const get = async (tenantId: string) =>
    ({ tenantId, kind: "tenant", schemaName: tenantSchema(tenantId), schemaVersion: 1, placementVersion: 1, ...state }) as Placement;
  return { fake, state, node, runtime: { platform: { get }, pools: { node } } };
}

/** Sahte veritabanı yanıtları: sayım, etkilenen satır ve `RETURNING` satırları. */
const rows: Handler = (text) => {
  if (text.startsWith("SELECT count")) return [{ count: "7" }];
  if (/^(UPDATE|DELETE)/.test(text) && !text.includes("RETURNING")) return Object.assign([], { count: text.startsWith("UPDATE") ? 2 : 3 });
  if (text.startsWith("INSERT")) return [{ id: "s1", name: "A", email: "a@x", is_email_verified: false, image: null, created_at: new Date(0), updated_at: new Date(0) }];
  if (text.includes("student_two_factors")) return [{ id: "t1", secret: "s", backup_codes: "b", user_id: "u1", verified: true, failed_verification_count: "3" }];
  return [];
};

const adapterFor = async (options: BetterAuthOptions = {}) => {
  const context = fakeRuntime(rows);
  const adapter = (await tenantAuthDatabase(context.runtime, "acme"))(options);
  const sql = () => context.fake.commands.map((command) => command.text);
  return { ...context, adapter, sql, params: () => context.fake.commands.map((command) => command.params) };
};

test("tenantAuthSecret is HKDF-SHA256(master, tenant ID), deterministic and distinct per tenant and master", async () => {
  const acme = await tenantAuthSecret(SECRET, "acme");
  expect(acme).toBe(Buffer.from(hkdfSync("sha256", SECRET, "@repo/db/auth", "acme", 32)).toString("hex"));
  expect(await tenantAuthSecret(SECRET, "acme")).toBe(acme);
  expect(await tenantAuthSecret(SECRET, "globex")).not.toBe(acme);
  expect(await tenantAuthSecret("n".repeat(32), "acme")).not.toBe(acme);
  await expect(tenantAuthSecret("short", "acme")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await expect(tenantAuthSecret(SECRET, "Acme")).rejects.toMatchObject({ code: "INVALID_TENANT_ID" });
});

test("createTenantAuth: shared secret, tenant-ID cookie prefix and tenant URL by default; caches per placement in an LRU", async () => {
  const { runtime, state } = fakeRuntime();
  const made: AuthTenant[] = [];
  const authFor = createTenantAuth(runtime, (tenant) => made.push(tenant), { secret: SECRET, rootDomain: "acme.com", max: 1 });
  await authFor("shop");
  expect(made[0]?.options).toMatchObject({ baseURL: "https://shop.acme.com", secret: SECRET, advanced: { cookiePrefix: "shop" } });
  expect(made[0]?.options).not.toHaveProperty("basePath");
  expect(made[0]?.options.database).toBeFunction();
  await authFor("shop");
  expect(made).toHaveLength(1);
  state.databaseId = "db1"; // taşınan tenant yeni örnek alır
  await authFor("shop");
  await authFor("globex");
  await authFor("shop"); // max 1: globex onu çıkardı
  expect(made.map((tenant) => tenant.tenantId)).toEqual(["shop", "shop", "globex", "shop"]);
  state.status = "maintenance";
  await expect(authFor("shop")).rejects.toMatchObject({ code: "TENANT_UNAVAILABLE" });
  await expect(tenantAuthDatabase(runtime, "globex")).rejects.toMatchObject({ code: "TENANT_UNAVAILABLE" });
});

test("createTenantAuth: authType sets basePath and <authType>-<tenantId> cookies; perTenantSecret derives; config is validated up front", async () => {
  const { runtime } = fakeRuntime();
  const options = async (config: Partial<Parameters<typeof createTenantAuth>[2]>) => {
    let seen: AuthOptions | undefined;
    await createTenantAuth(runtime, (tenant) => (seen = tenant.options), { secret: SECRET, rootDomain: "example.com", ...config })("chitchat");
    return seen;
  };
  expect(await options({ authType: "student" })).toMatchObject({ basePath: "/api/auth/student", secret: SECRET, advanced: { cookiePrefix: "student-chitchat" } });
  expect((await options({ authType: "teacher", perTenantSecret: true }))?.secret).toBe(await tenantAuthSecret(SECRET, "chitchat"));
  for (const authType of ["Student", "user-x", "", "a".repeat(33)])
    expect(() => createTenantAuth(runtime, () => 0, { secret: SECRET, rootDomain: "a.com", authType })).toThrow("authType");
  expect(() => createTenantAuth(runtime, () => 0, { secret: "short", rootDomain: "a.com" })).toThrow("at least 32");
});

test("instance checks: cookieCache needs perTenantSecret; an enabled memory rate limit is refused", async () => {
  const { runtime } = fakeRuntime();
  const instance = (options: object) => () => ({ options });
  const build = (options: object, perTenantSecret = false) => createTenantAuth(runtime, instance(options), { secret: SECRET, rootDomain: "a.com", perTenantSecret })("acme");
  const cookieCache = { session: { cookieCache: { enabled: true } } };
  await expect(build(cookieCache)).rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining("cookieCache") });
  expect(await build(cookieCache, true)).toMatchObject({ options: cookieCache });
  await expect(build({ rateLimit: { enabled: true } })).rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining("rateLimit") });
  await expect(build({ rateLimit: { enabled: true, storage: "memory" }, secondaryStorage: {} })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  // Veritabanı deposu auth türünün kendi tablosunu ister: varsayılan `rateLimit` tablosu yoktur ve anahtar (IP + yol) auth türünü içermez.
  const database = { enabled: true, storage: "database" };
  await expect(build({ rateLimit: database })).rejects.toMatchObject({ code: "INVALID_CONFIG", message: expect.stringContaining("rateLimitTable") });
  for (const ok of [{ rateLimit: { enabled: true }, secondaryStorage: {} }, { rateLimit: { ...database, ...rateLimitTable("student") } }, { rateLimit: { enabled: false } }, {}])
    expect(await build(ok)).toMatchObject({ options: ok });
  expect(() => createPlatformAuth(runtime, instance({ rateLimit: { enabled: true } }), { secret: SECRET, baseURL: "https://api.a.com" })()).toThrow("rateLimit");
  expect(() => createPlatformAuth(runtime, instance({ rateLimit: database }), { secret: SECRET, baseURL: "https://api.a.com" })()).toThrow("rateLimitTable");
  expect(createPlatformAuth(runtime, instance({ rateLimit: { ...database, ...rateLimitTable("user") } }), { secret: SECRET, baseURL: "https://api.a.com" })()).toBeDefined();
});

test("createPlatformAuth: one cached instance over db0's platform schema, panel path and cookie prefix", async () => {
  const { runtime, fake } = fakeRuntime();
  const made: AuthOptions[] = [];
  const panel = createPlatformAuth(runtime, ({ options }) => made.push(options), { secret: SECRET, baseURL: "https://api.example.com" });
  expect(panel()).toBe(1);
  expect(panel()).toBe(1);
  expect(made[0]).toMatchObject({ basePath: "/api/auth/panel", secret: SECRET, baseURL: "https://api.example.com", advanced: { cookiePrefix: "panel" } });
  await made[0]?.database({}).findOne({ model: "user", where: [{ field: "id", value: "1" }] });
  expect(fake.commands).toMatchObject([{ url: "db0", text: 'SELECT * FROM "platform"."user" WHERE "id" = $1 LIMIT 1', params: ["1"] }]);
  expect(() => createPlatformAuth(runtime, () => 0, { secret: SECRET, baseURL: "x", authType: "Panel" })).toThrow("authType");
});

test("adapter where: operators, insensitive mode, escaped LIKE, AND with one OR group, sort/limit/offset; empty IN", async () => {
  const { adapter, sql, params } = await adapterFor();
  await adapter.findMany({
    model: "user",
    where: [
      { field: "email", value: "A@X", mode: "insensitive" },
      { field: "name", operator: "in", value: ["a", "b"] },
      { field: "name", operator: "contains", value: "50%_" },
      { field: "emailVerified", value: true, connector: "OR" },
      { field: "image", operator: "ne", value: null, connector: "OR" },
    ],
    sortBy: { field: "createdAt", direction: "desc" },
    limit: 5,
    offset: 10,
  });
  await adapter.findMany({ model: "session", where: [{ field: "expiresAt", operator: "lte", value: new Date(0) }, { field: "token", operator: "not_in", value: [] }], limit: 1 });
  await adapter.findOne({ model: "user", where: [{ field: "email", operator: "starts_with", value: "Ab", mode: "insensitive" }], select: ["email"] });
  expect(sql()).toEqual([
    'SELECT * FROM "tenant_acme"."user" WHERE lower("email") = $1 AND "name" IN ($2, $3) AND "name" LIKE $4 AND ("emailVerified" = $5 OR "image" IS NOT NULL) ORDER BY "createdAt" DESC LIMIT 5 OFFSET 10',
    'SELECT * FROM "tenant_acme"."session" WHERE "expiresAt" <= $1 AND true LIMIT 1',
    'SELECT "email" FROM "tenant_acme"."user" WHERE "email" ILIKE $1 LIMIT 1',
  ]);
  expect(params()[0]).toEqual(["a@x", "a", "b", "%50\\%\\_%", true]);
  expect(params()[2]).toEqual(["Ab%"]);
});

test("adapter writes: count, updateMany/deleteMany counts, atomic consumeOne, schema-qualified and parameterized", async () => {
  const { adapter, sql, params } = await adapterFor();
  expect(await adapter.count({ model: "session", where: [{ field: "userId", value: "u1" }] })).toBe(7);
  expect(await adapter.updateMany({ model: "session", where: [{ field: "userId", value: "u1" }], update: { ipAddress: "1.1.1.1" } })).toBe(2);
  expect(await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "u1" }] })).toBe(3);
  expect(await adapter.consumeOne({ model: "verification", where: [{ field: "identifier", value: "reset-x" }] })).toBeNull();
  const [count, update, remove, consume] = sql();
  expect(count).toBe('SELECT count(*) AS count FROM "tenant_acme"."session" WHERE "userId" = $1');
  expect(update).toMatch(/^UPDATE "tenant_acme"\."session" SET (?:"\w+" = \$\d, )*"ipAddress" = \$\d(?:, "\w+" = \$\d)* WHERE "userId" = \$\d$/);
  expect(remove).toBe('DELETE FROM "tenant_acme"."session" WHERE "userId" = $1');
  expect(consume).toBe('DELETE FROM "tenant_acme"."verification" WHERE "id" IN (SELECT "id" FROM "tenant_acme"."verification" WHERE "identifier" = $1 LIMIT 1) RETURNING *');
  expect(params()[1]).toContain("1.1.1.1");
});

test("adapter mapping: students-style modelName/fields with generateId false, twoFactor plugin table with native incrementOne", async () => {
  const { adapter, sql, params } = await adapterFor({
    user: { modelName: "students", fields: { emailVerified: "is_email_verified", createdAt: "created_at", updatedAt: "updated_at" } },
    advanced: { database: { generateId: false } },
    plugins: [
      twoFactor({
        schema: {
          twoFactor: { modelName: "student_two_factors", fields: { backupCodes: "backup_codes", userId: "user_id", failedVerificationCount: "failed_verification_count", lockedUntil: "locked_until" } },
          user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
        },
      }),
    ],
  });
  const student = await adapter.create({ model: "user", data: { name: "A", email: "a@x", emailVerified: false } });
  expect(student).toMatchObject({ id: "s1", name: "A", email: "a@x", emailVerified: false, createdAt: new Date(0) });
  const counter = await adapter.incrementOne<{ failedVerificationCount: number }>({
    model: "twoFactor",
    where: [{ field: "userId", value: UUID }],
    increment: { failedVerificationCount: 1 },
    set: { lockedUntil: new Date(0) },
  });
  expect(counter?.failedVerificationCount).toBe(3);
  const [insert, increment] = sql();
  expect(insert).toMatch(/^INSERT INTO "tenant_acme"\."students" \((?:"\w+", )*"is_email_verified"(?:, "\w+")*\) VALUES \((?:\$\d, )*\$\d\) RETURNING \*$/);
  expect(insert).not.toContain('"id"');
  expect(increment).toBe(
    'UPDATE "tenant_acme"."student_two_factors" SET "failed_verification_count" = COALESCE("failed_verification_count", 0) + $1, "locked_until" = $2 WHERE "user_id" = $3 AND "id" IN (SELECT "id" FROM "tenant_acme"."student_two_factors" WHERE "user_id" = $4 LIMIT 1) RETURNING *',
  );
  expect(params()[1]).toMatchObject([1, expect.anything(), UUID, UUID]);
});

test("adapter transaction: one reserved connection, BEGIN … COMMIT, ROLLBACK on error", async () => {
  const { adapter, sql } = await adapterFor();
  await adapter.transaction(async (trx) => {
    await trx.findOne({ model: "user", where: [{ field: "id", value: "1" }] });
    await trx.delete({ model: "user", where: [{ field: "id", value: "1" }] });
  });
  await expect(adapter.transaction(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(sql()).toEqual(["BEGIN", 'SELECT * FROM "tenant_acme"."user" WHERE "id" = $1 LIMIT 1', 'DELETE FROM "tenant_acme"."user" WHERE "id" = $1', "COMMIT", "BEGIN", "ROLLBACK"]);
});

test("auth migration: per-auth-type snake_case tables, uuid defaults and inline references bind and fold", () => {
  const auth = tenantMigrations.find((m) => m.id.endsWith("_auth"));
  const up = auth?.up.bind("tenant_acme").join("") ?? "";
  expect(up).toContain('CREATE TABLE "tenant_acme".users (\n  id "pg_catalog"."uuid" PRIMARY KEY DEFAULT "pg_catalog"."gen_random_uuid"(),');
  expect(up).toContain('email_verified "pg_catalog"."bool" NOT NULL DEFAULT false');
  expect(up).toContain('created_at "pg_catalog"."timestamptz" NOT NULL DEFAULT "pg_catalog"."now"()');
  expect(up).toContain('user_id "pg_catalog"."uuid" NOT NULL REFERENCES "tenant_acme".users (id) ON DELETE CASCADE');
  expect(up).toMatch(/CREATE TABLE "tenant_acme"\.students \([^;]*is_email_verified "pg_catalog"\."bool"/);
  expect(up).toMatch(/REFERENCES "tenant_acme"\.teachers \(id\)/);
  // Her tablo adı ve referans tenant schema'sıyla nitelenir.
  expect(up.match(/\b(?:TABLE|REFERENCES) (?!"tenant_acme"\.)/g)).toBeNull();
  expect(auth?.down?.bind("tenant_acme")).toEqual([
    '\nDROP TABLE "tenant_acme".teacher_two_factors, "tenant_acme".teacher_verifications, "tenant_acme".teacher_accounts, "tenant_acme".teacher_sessions, "tenant_acme".teachers,\n' +
      '  "tenant_acme".student_two_factors, "tenant_acme".student_verifications, "tenant_acme".student_accounts, "tenant_acme".student_sessions, "tenant_acme".students,\n' +
      '  "tenant_acme".two_factor, "tenant_acme".verification, "tenant_acme".account, "tenant_acme".session, "tenant_acme".users;\n',
  ]);
  expect(prepareMigration('CREATE TABLE "User" ("Id" text NOT NULL UNIQUE)').bind("tenant_a_com")).toEqual([
    'CREATE TABLE "tenant_a_com"."User" ("Id" "pg_catalog"."text" NOT NULL UNIQUE)',
  ]);
  for (const sql of ['create table "public"."user" ("id" text)', 'create index "i" on "public"."user" ("id")'])
    expect(() => prepareMigration(sql)).toThrow("SQL_UNSUPPORTED");
  const modules = tableModules("tenant", foldTables(tenantMigrations.flatMap((m) => m.up.statements)));
  expect(modules.get("src/tables/tenant/users.gen.ts")).toContain("  emailVerified: z.boolean(),\n  image: z.string().nullable(),");
  expect(modules.get("src/tables/tenant/students.gen.ts")).toContain("  isEmailVerified: z.boolean(),");
  expect(modules.get("src/tables/tenant/session.gen.ts")).toContain("  createdAt: z.date().optional(),");
});

test("authTables / twoFactorTables: table names per auth type, is_email_verified for student/teacher, mapped columns exist; unknown type is INVALID_CONFIG", async () => {
  const names = (authType: AuthType) => [...Object.values(authTables(authType)).map((model) => model.modelName), twoFactorTables(authType).twoFactor.modelName];
  expect(names("user")).toEqual(["users", "session", "account", "verification", "two_factor"]);
  expect(names("student")).toEqual(["students", "student_sessions", "student_accounts", "student_verifications", "student_two_factors"]);
  expect(names("teacher")).toEqual(["teachers", "teacher_sessions", "teacher_accounts", "teacher_verifications", "teacher_two_factors"]);
  expect(authTables("user").user.fields.emailVerified).toBe("email_verified");
  expect(authTables("student").user.fields.emailVerified).toBe("is_email_verified");
  expect(authTables("teacher").user.fields.emailVerified).toBe("is_email_verified");
  expect(twoFactorTables("student").user.fields.twoFactorEnabled).toBe("two_factor_enabled");
  // Eşlenen her sütun migration'dan katlanan tabloda gerçekten bulunur.
  const { tables } = foldTables(tenantMigrations.flatMap((m) => m.up.statements));
  for (const authType of ["user", "student", "teacher"] as const) {
    const two = twoFactorTables(authType);
    const mappings: [string, Record<string, string>][] = [
      ...Object.values(authTables(authType)).map((model): [string, Record<string, string>] => [model.modelName, model.fields]),
      [two.twoFactor.modelName, two.twoFactor.fields],
      [authTables(authType).user.modelName, two.user.fields],
    ];
    for (const [table, fields] of mappings) {
      const columns = (tables.get(table) ?? []).map((column) => column.name);
      expect(columns.length, table).toBeGreaterThan(0);
      for (const column of Object.values(fields)) expect(columns, `${table}.${column}`).toContain(column);
    }
  }
  for (const bad of ["admin", "constructor", "__proto__"]) {
    expect(() => authTables(bad as AuthType)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => twoFactorTables(bad as AuthType)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  }
  // Yardımcı eşleme bağdaştırıcıda schema-nitelikli snake_case SQL üretir.
  const { adapter, sql } = await adapterFor({ ...authTables("teacher"), advanced: { database: { generateId: false } } });
  expect(await adapter.count({ model: "session", where: [{ field: "userId", value: UUID }] })).toBe(7);
  expect(sql()).toEqual(['SELECT count(*) AS count FROM "tenant_acme"."teacher_sessions" WHERE "user_id" = $1']);
});


test("adapter uuid keys (generateId false): a malformed id or reference matches nothing instead of failing on the uuid column", async () => {
  const { adapter, sql, params } = await adapterFor({ ...authTables("user"), advanced: { database: { generateId: false } } });
  expect(await adapter.findOne({ model: "user", where: [{ field: "id", value: "not-a-uuid" }] })).toBeNull();
  await adapter.findMany({ model: "session", where: [{ field: "userId", operator: "in", value: ["x", UUID] }, { field: "id", operator: "not_in", value: ["y"] }], limit: 1 });
  await adapter.count({ model: "session", where: [{ field: "userId", operator: "ne", value: "x" }] });
  await adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "' OR 1=1" }] });
  await adapter.findOne({ model: "user", where: [{ field: "id", value: UUID.toUpperCase() }] });
  await adapter.findOne({ model: "user", where: [{ field: "id", value: `{${UUID}}` }] });
  await adapter.findOne({ model: "user", where: [{ field: "email", value: "not-a-uuid" }] });
  expect(sql()).toEqual([
    'SELECT * FROM "tenant_acme"."users" WHERE false LIMIT 1',
    'SELECT * FROM "tenant_acme"."session" WHERE "user_id" IN ($1) AND true LIMIT 1',
    'SELECT count(*) AS count FROM "tenant_acme"."session" WHERE "user_id" IS NOT NULL',
    'DELETE FROM "tenant_acme"."session" WHERE false',
    'SELECT * FROM "tenant_acme"."users" WHERE "id" = $1 LIMIT 1',
    'SELECT * FROM "tenant_acme"."users" WHERE "id" = $1 LIMIT 1',
    'SELECT * FROM "tenant_acme"."users" WHERE "email" = $1 LIMIT 1',
  ]);
  expect(params()[1]).toEqual([UUID]);
  // Kimliği uygulama üretiyorsa (Better Auth varsayılanı) sütun metindir: değer olduğu gibi gider.
  const text = await adapterFor();
  await text.adapter.findOne({ model: "user", where: [{ field: "id", value: "not-a-uuid" }] });
  expect(text.sql()).toEqual(['SELECT * FROM "tenant_acme"."user" WHERE "id" = $1 LIMIT 1']);
});

test("rateLimitTable: one table per auth type in tenant schemas; the platform schema has the panel's auth and rate-limit tables", () => {
  expect(rateLimitTable("user")).toEqual({ modelName: "rate_limit", fields: { lastRequest: "last_request" } });
  expect(rateLimitTable("student").modelName).toBe("student_rate_limits");
  expect(rateLimitTable("teacher").modelName).toBe("teacher_rate_limits");
  for (const bad of ["admin", "__proto__"]) expect(() => rateLimitTable(bad as AuthType)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  const columnsOf = (tables: ReturnType<typeof migrationTables>, table: string) => (tables.get(table) ?? []).map((column) => column.name);
  const tenant = migrationTables("tenant");
  for (const authType of ["user", "student", "teacher"] as const)
    expect(columnsOf(tenant, rateLimitTable(authType).modelName)).toEqual(["id", "key", "count", "last_request"]);
  // Panel (`createPlatformAuth`) `user` türünün eşlemesini db0'ın `platform` schema'sında kullanır.
  const platform = migrationTables("platform");
  const two = twoFactorTables("user");
  const mappings: [string, Record<string, string>][] = [
    ...Object.values(authTables("user")).map((model): [string, Record<string, string>] => [model.modelName, model.fields]),
    [two.twoFactor.modelName, two.twoFactor.fields],
    [authTables("user").user.modelName, two.user.fields],
    [rateLimitTable("user").modelName, rateLimitTable("user").fields],
  ];
  for (const [table, fields] of mappings) {
    const columns = columnsOf(platform, table);
    expect(columns, table).toContain("id");
    for (const column of Object.values(fields)) expect(columns, `${table}.${column}`).toContain(column);
  }
});
