/** `authSchemaDiff`: var olan alanların eksik index ve tekillik kısıtları da fark sayılır (sahte `information_schema` / `pg_index` yanıtlarıyla). */
import { expect, test } from "bun:test";
import { getSchema } from "better-auth/db";
import authOptions from "../fixtures/auth-options";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { authSchemaDiff, generateAuthMigration } from "../../core/tools/auth";
import { fakeDriver } from "../fixtures/fake-driver";

type IndexRow = { table: string; name: string; column: string; unique: boolean; valid: boolean };

const TYPES: Record<string, string> = { boolean: "boolean", date: "timestamp with time zone", number: "integer" };
/** Better Auth'un beklediği her tablo ve sütun, alanın tipiyle. */
const columns = Object.entries(getSchema(authOptions as never)).flatMap(([table, value]) => [
  { table, column: "id", type: "uuid" },
  ...Object.entries(value.fields).map(([column, field]) => ({ table, column, type: TYPES[field.type as string] ?? "text" })),
]);
/** Index satırlarını test verir. */
function fakeDb(indexes: IndexRow[]) {
  return { db: { query: async (text: string) => (text.includes("information_schema") ? columns : indexes) } } as never;
}

/** Better Auth'un işaretlediği bütün tekil / index alanlarının karşılığı. */
const complete: IndexRow[] = [
  { table: "users", name: "users_email_unique", column: "email", unique: true, valid: true },
  { table: "session", name: "session_token_unique", column: "token", unique: true, valid: true },
  { table: "session", name: "session_user_id_idx", column: "user_id", unique: false, valid: true },
  { table: "account", name: "account_user_id_idx", column: "user_id", unique: false, valid: true },
  { table: "verification", name: "verification_identifier_idx", column: "identifier", unique: false, valid: true },
  { table: "two_factor", name: "two_factor_secret_idx", column: "secret", unique: false, valid: true },
  { table: "two_factor", name: "two_factor_user_id_idx", column: "user_id", unique: false, valid: true },
  { table: "rate_limit", name: "rate_limit_key_unique", column: "key", unique: true, valid: true },
];

test("no difference when every indexed and unique field has its index or constraint", async () => {
  expect((await authSchemaDiff(fakeDb(complete), authOptions, { schema: "app_x" })).sql).toBe("");
});

test("a missing index or unique constraint on an existing column is a difference", async () => {
  const without = (name: string) => complete.filter((row) => row.name !== name);
  const index = await authSchemaDiff(fakeDb(without("session_user_id_idx")), authOptions, { schema: "app_x" });
  expect(index.sql).toBe('create index "session_user_id_idx" on "session" ("user_id");');
  const unique = await authSchemaDiff(fakeDb(without("users_email_unique")), authOptions, { schema: "app_x" });
  expect(unique.sql).toBe('create unique index "users_email_uidx" on "users" ("email");');
  // Geçersiz (ya da kısmi) index karşılık sayılmaz; üretilecek adı zaten taşıyorsa migration o adla çakışırdı: INVALID_CONFIG, adıyla.
  await expect(authSchemaDiff(fakeDb(complete.map((row) => (row.name === "account_user_id_idx" ? { ...row, valid: false } : row))), authOptions, { schema: "app_x" })).rejects.toMatchObject({
    code: "INVALID_CONFIG",
    message: expect.stringContaining('"account_user_id_idx"'),
  });
  // Index adları schema genelinde tekildir: üretilecek ad başka tablonun index'indeyse de çakışırdı.
  const elsewhere = [...without("session_user_id_idx"), { table: "verification", name: "session_user_id_idx", column: "identifier", unique: false, valid: true }];
  await expect(authSchemaDiff(fakeDb(elsewhere), authOptions, { schema: "app_x" })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  // Tekil alan tekil olmayan index'le karşılanmaz.
  expect((await authSchemaDiff(fakeDb(complete.map((row) => (row.name === "users_email_unique" ? { ...row, unique: false } : row))), authOptions, { schema: "app_x" })).sql).toContain('"users_email_uidx"');
});

test("auth generate interrupted during the final comparison is MIGRATION_CANCELLED even when nothing differs", async () => {
  const abort = new AbortController();
  let interrupt = false;
  const fake = fakeDriver((text) => {
    if (text.includes("information_schema")) return columns;
    if (text.includes("indnkeyatts")) {
      if (interrupt) abort.abort();
      return complete;
    }
    return [];
  });
  const m = createManagement(createConfig("postgres://admin@127.0.0.1:7100/app"), { driver: fake.driver });
  const generate = () => generateAuthMigration({ db: m, options: authOptions, registry: { migrations: [], seeds: [] }, root: "/nonexistent", signal: abort.signal });
  try {
    expect(await generate()).toEqual({ created: false });
    interrupt = true;
    await expect(generate()).rejects.toMatchObject({ code: "MIGRATION_CANCELLED" });
  } finally {
    await m.close();
  }
});
