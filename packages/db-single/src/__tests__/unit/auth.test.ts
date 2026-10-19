import { expect, test } from "bun:test";
import { hashPassword } from "better-auth/crypto";
import { createAuth, importedPasswords } from "../../core/auth";
import { authTables, rateLimitTable, twoFactorTables } from "../../core/auth-schema";
import { migrations } from "../../core/migrations/registry";
import { foldTables } from "../../core/sql/tables";

const SECRET = "s".repeat(32);
const runtime = { pools: { primary: { query: async () => [], transaction: async () => undefined } }, schema: "app_x" } as never;

test("createAuth builds the options once: schema-bound adapter, secret, base URL, fixed cookie prefix and database-made ids", () => {
  let made = 0;
  let seen: { options: Record<string, unknown> } | undefined;
  const auth = createAuth(
    runtime,
    (input) => {
      made++;
      seen = input as never;
      return { name: "auth" };
    },
    { secret: SECRET, baseURL: "https://app.example.com" },
  );
  expect(auth()).toBe(auth());
  expect(made).toBe(1);
  expect(seen?.options).toMatchObject({ secret: SECRET, baseURL: "https://app.example.com", advanced: { cookiePrefix: "auth", database: { generateId: false } } });
  expect(seen?.options.basePath).toBeUndefined();
  expect(seen?.options.database).toBeDefined();
});

test("basePath and cookiePrefix are passed through; bad values and short secrets are INVALID_CONFIG up front", () => {
  let seen: { options: Record<string, unknown> } | undefined;
  createAuth(runtime, (input) => (seen = input as never), { secret: SECRET, baseURL: "https://a.example", basePath: "/api/auth", cookiePrefix: "my-app" })();
  expect(seen?.options).toMatchObject({ basePath: "/api/auth", advanced: { cookiePrefix: "my-app" } });
  const make = () => ({});
  for (const bad of [{ secret: "short" }, { cookiePrefix: "Bad Prefix" }, { cookiePrefix: "" }, { basePath: "api/auth" as `/${string}` }])
    expect(() => createAuth(runtime, make, { secret: SECRET, baseURL: "https://a.example", ...bad }), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});

test("authTables, twoFactorTables and rateLimitTable name tables that the shipped migration really creates, with every mapped column", () => {
  const folded = foldTables(migrations.flatMap((migration) => migration.up.statements)).tables;
  const columns = (table: string) => (folded.get(table) ?? []).map((column) => column.name);
  const tables = authTables();
  for (const model of [tables.user, tables.session, tables.account, tables.verification]) {
    expect(columns(model.modelName), model.modelName).not.toEqual([]);
    for (const column of Object.values(model.fields)) expect(columns(model.modelName), `${model.modelName}.${column}`).toContain(column);
  }
  const twoFactor = twoFactorTables();
  expect(columns(twoFactor.twoFactor.modelName)).toEqual(expect.arrayContaining(Object.values(twoFactor.twoFactor.fields)));
  expect(columns("users")).toContain(twoFactor.user.fields.twoFactorEnabled);
  expect(columns(rateLimitTable().modelName)).toEqual(expect.arrayContaining(["key", "count", Object.values(rateLimitTable().fields)[0] as string]));
  expect(tables.user.fields.emailVerified).toBe("email_verified");
});

test("the shipped auth migration uses database-made uuid ids and snake_case columns", () => {
  const sql = migrations.flatMap((migration) => migration.up.bind("app_x")).join("\n");
  expect(sql).toContain('"app_x".users');
  expect(sql).toContain("gen_random_uuid");
  expect(sql).not.toMatch(/\bcreatedAt\b|\bemailVerified\b/);
});

test("importedPasswords verifies Better Auth scrypt, bcrypt and (on Bun) argon2 hashes, and rejects wrong passwords", async () => {
  const bcrypt = await Bun.password.hash("secret", "bcrypt");
  const argon2 = await Bun.password.hash("secret", "argon2id");
  const scrypt = await hashPassword("secret");
  for (const hash of [scrypt, bcrypt, argon2]) {
    expect(await importedPasswords.verify({ hash, password: "secret" }), hash.slice(0, 7)).toBe(true);
    expect(await importedPasswords.verify({ hash, password: "wrong" }), hash.slice(0, 7)).toBe(false);
  }
  expect((await importedPasswords.hash("secret")).startsWith("$")).toBe(false);
});
