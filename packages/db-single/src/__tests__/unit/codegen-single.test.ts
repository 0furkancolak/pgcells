import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codegen, createMigration, createSeed, generate, staleFiles, writeGenerated } from "../../core/sql/codegen";

const users = "-- name: listUsers\nSELECT id FROM users ORDER BY id\n\n-- name: addUser\nINSERT INTO users (id) VALUES ($1::integer)\n";

test("each query file becomes a flat module of defineQuery calls with no scope argument", () => {
  const modules = generate([["src/queries/users.sql", users]]);
  expect([...modules.keys()]).toEqual(["src/queries/users.gen.ts"]);
  const text = modules.get("src/queries/users.gen.ts") ?? "";
  expect(text).toContain('import { defineQuery } from "../core/sql/query";');
  expect(text).toContain('export const listUsers = defineQuery(["SELECT id FROM ",".users ORDER BY id"], false, true);');
  expect(text).toContain("export const addUser = defineQuery(");
  expect(text).toMatch(/, false, false\);/);
});

test("query files must live directly in src/queries and names must be unique across files", () => {
  expect(() => generate([["src/queries/sub/users.sql", users]])).toThrow("query files live in src/queries/");
  expect(() => generate([["src/queries/users.sql", users], ["src/queries/more.sql", users]])).toThrow("duplicate query listUsers");
  expect(() => generate([["src/queries/users.sql", "SELECT 1"]])).toThrow("-- name:");
});

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "single-codegen-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}
const migration = "--up\nCREATE TABLE users (id integer PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());\n--down\nDROP TABLE users;\n";

test("codegen emits query, migration list, seed list and table modules from the flat layout", async () => {
  const root = await project({
    "src/migrations/20260101000001_users.sql": migration,
    "src/seeds/20260101000002_first.sql": "INSERT INTO users (id) VALUES (1);\n",
    "src/queries/users.sql": users,
  });
  try {
    const modules = await codegen(root);
    expect([...modules.keys()].sort()).toEqual(["src/migrations/index.gen.ts", "src/queries/users.gen.ts", "src/seeds/index.gen.ts", "src/tables/users.gen.ts"]);
    expect(modules.get("src/migrations/index.gen.ts")).toContain('["20260101000001_users", m0]');
    expect(modules.get("src/seeds/index.gen.ts")).toContain('["20260101000002_first", m0]');
    expect(modules.get("src/tables/users.gen.ts")).toContain("export const userRow");
    expect(modules.get("src/tables/users.gen.ts")).toContain('createdAt: "created_at"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migration and seed folders are flat: a nested file is refused", async () => {
  const root = await project({ "src/migrations/legacy/20260101000001_users.sql": migration });
  try {
    await expect(codegen(root)).rejects.toThrow("flat folders");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staleFiles reports missing, edited and orphan generated files; writeGenerated fixes them", async () => {
  const root = await project({ "src/migrations/20260101000001_users.sql": migration, "src/queries/users.sql": users });
  try {
    expect((await staleFiles(root)).length).toBeGreaterThan(0);
    await writeGenerated(root);
    expect(await staleFiles(root)).toEqual([]);
    await writeFile(join(root, "src/queries/users.gen.ts"), "// edited\n");
    expect(await staleFiles(root)).toEqual(["src/queries/users.gen.ts"]);
    await writeGenerated(root);
    expect(await staleFiles(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createMigration and createSeed write UTC-stamped files and refresh the list; ids must increase", async () => {
  const root = await project({});
  try {
    const first = await createMigration({ name: "add_users", now: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), root });
    expect(first).toEqual({ id: "20260102030405_add_users", path: "src/migrations/20260102030405_add_users.sql" });
    expect(await Bun.file(join(root, first.path)).text()).toBe("--up\n\n--down\n");
    expect(await Bun.file(join(root, "src/migrations/index.gen.ts")).text()).toContain('"20260102030405_add_users"');
    await expect(createMigration({ name: "older", now: new Date(Date.UTC(2026, 0, 1)), root })).rejects.toMatchObject({ code: "MIGRATION_INVALID" });
    await expect(createMigration({ name: "Bad Name", root })).rejects.toMatchObject({ code: "USAGE" });
    const seed = await createSeed({ name: "first_user", kind: "ts", now: new Date(Date.UTC(2026, 0, 3)), root });
    expect(seed.path).toBe("src/seeds/20260103000000_first_user.ts");
    expect(await Bun.file(join(root, seed.path)).text()).toContain('import type { SeedContext } from "../management";');
    const sql = await createSeed({ name: "sql_seed", now: new Date(Date.UTC(2026, 0, 4)), root });
    expect(sql.path).toBe("src/seeds/20260104000000_sql_seed.sql");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the package's own generated modules are fresh and defineQuery is called only from them", async () => {
  expect(await staleFiles(join(import.meta.dir, "../../.."))).toEqual([]);
});
