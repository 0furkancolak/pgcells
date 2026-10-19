import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tenantMigrations } from "../../core/migrations/registry";
import { rollbackTargets } from "../../core/migrations/schema";
import { compileMigrations, compileSeeds, migrationPrefix, splitMigration } from "../../core/migrations/source";
import { codegen, createMigration, createSeed, staleFiles } from "../../core/sql/codegen";

const schema = `tenant_${"c".repeat(32)}`;
const one = (source: string, scope: "tenant" | "platform" = "tenant", id = "20260915143012_x") =>
  compileMigrations(scope, [[id, source]])[0];

test("the prefix is UTC yyyyMMddHHmmss built from date parts", () => {
  expect(migrationPrefix(new Date(Date.UTC(2026, 8, 15, 14, 30, 12)))).toBe("20260915143012");
  expect(migrationPrefix(new Date(Date.UTC(987, 0, 2, 3, 4, 5)))).toBe("09870102030405");
});

test("files need exactly --up then --down; empty down is irreversible; checksum covers the file", () => {
  expect(splitMigration("x", "\n--up\nCREATE TABLE a (id uuid);\n--down \nDROP TABLE a;\n")).toEqual({
    up: "\nCREATE TABLE a (id uuid);\n",
    down: "\nDROP TABLE a;\n",
  });
  for (const source of [
    "CREATE TABLE a (id uuid);",
    "--up\nCREATE TABLE a (id uuid);",
    "--down\nDROP TABLE a;\n--up\nCREATE TABLE a (id uuid);",
    "--up\nCREATE TABLE a (id uuid);\n--up\n--down\n",
    "--up\nCREATE TABLE a (id uuid);\n--todo\n--down\n",
    "-- başlık\n--up\nCREATE TABLE a (id uuid);\n--down\n",
  ])
    expect(() => one(source), source).toThrow(/--up/);
  const reversible = one("--up\nCREATE TABLE a (id uuid);\n--down\n-- yorum\nDROP TABLE a;\n");
  expect(reversible?.down?.bind(schema)).toEqual([`\n-- yorum\nDROP TABLE "${schema}".a;\n`]);
  expect(one("--up\nCREATE TABLE a (id uuid);\n--down\n-- yalnızca yorum\n")?.down).toBeUndefined();
  expect(one("--up\nCREATE TABLE a (id uuid);\n--down\n")?.checksum).not.toBe(one("--up\nCREATE TABLE a (id uuid);\n--down\n\n")?.checksum);
  expect(() => one("--up\n\n--down\n")).toThrow(/20260915143012_x: SQL_UNSUPPORTED/);
  for (const id of ["0001_initial", "20260915143012_Bad", "2026091514301_short"])
    expect(() => one("--up\nCREATE TABLE a (id uuid);\n--down\n", "tenant", id)).toThrow(/IDs must be/);
  expect(() =>
    compileMigrations("tenant", [
      ["20260915143012_b", "--up\nCREATE TABLE b (id uuid);\n--down\n"],
      ["20260915143012_a", "--up\nCREATE TABLE a (id uuid);\n--down\n"],
    ]),
  ).toThrow(/increasing/);
});

test("concurrent index metadata comes from the parsed statement and must stand alone", () => {
  const index = one("--up\nCREATE UNIQUE INDEX CONCURRENTLY a_idx ON a (id);\n--down\nDROP INDEX CONCURRENTLY a_idx;\n");
  expect(index?.concurrentIndex).toEqual({ name: "a_idx", table: "a", unique: true });
  expect(index?.concurrentDrop).toBe("a_idx");
  expect(one("--up\nCREATE INDEX a_idx ON a (id);\n--down\nDROP INDEX a_idx;\n")).toMatchObject({
    concurrentIndex: undefined,
    concurrentDrop: undefined,
  });
  expect(tenantMigrations.map((m) => [m.id, m.concurrentIndex?.name, m.concurrentDrop])).toEqual([
    ["20260915155444_auth", undefined, undefined],
    ["20260915155445_user_imports", undefined, undefined],
    ["20260916092603_auth_rate_limits", undefined, undefined],
  ]);
  for (const source of [
    "--up\nCREATE INDEX CONCURRENTLY a_idx ON a (id); CREATE TABLE b (id uuid);\n--down\n",
    "--up\nCREATE INDEX CONCURRENTLY ON a (id);\n--down\n",
    "--up\nDROP INDEX CONCURRENTLY a_idx;\n--down\n",
    "--up\nCREATE TABLE b (id uuid);\n--down\nDROP INDEX CONCURRENTLY a_idx, b_idx;\n",
  ])
    expect(() => one(source), source).toThrow(/CONCURRENTLY|concurrent index needs a name|DROP INDEX CONCURRENTLY takes one/);
  expect(() => one("--up\nCREATE INDEX CONCURRENTLY a_idx ON a (id);\n--down\n", "platform")).toThrow(/tenant/);
});

test("enum types carry across files and bind to the migration schema", () => {
  const [first, second] = compileMigrations("tenant", [
    ["20260915143012_mood", "--up\nCREATE TYPE mood AS ENUM ('ok', 'sad');\n--down\nDROP TYPE mood;\n"],
    ["20260915143013_use", "--up\nALTER TABLE a ADD COLUMN m mood DEFAULT 'ok'::mood;\n--down\nALTER TABLE a DROP COLUMN m;\n"],
  ]);
  expect(first?.up.bind(schema)).toEqual([`\nCREATE TYPE "${schema}".mood AS ENUM ('ok', 'sad');\n`]);
  expect(first?.down?.bind(schema)).toEqual([`\nDROP TYPE "${schema}".mood;\n`]);
  expect(second?.up.bind(schema)).toEqual([
    `\nALTER TABLE "${schema}".a ADD COLUMN m "${schema}"."mood" DEFAULT 'ok'::"${schema}"."mood";\n`,
  ]);
  expect(() => one("--up\nCREATE TABLE a (m mood);\n--down\n")).toThrow(/unsupported type: mood/);
});

test("rollback targets are the newest applied migrations and refuse irreversible ones before any DDL", () => {
  const applied = compileMigrations("tenant", [
    ["20260915143011_a", "--up\nCREATE TABLE a (id uuid);\n--down\n"],
    ["20260915143012_b", "--up\nCREATE TABLE b (id uuid);\n--down\nDROP TABLE b;\n"],
    ["20260915143013_c", "--up\nCREATE TABLE c (id uuid);\n--down\nDROP TABLE c;\n"],
  ]);
  const ids = (target: Parameters<typeof rollbackTargets>[1]) => rollbackTargets(applied, target).map((m) => m.id);
  expect(ids({})).toEqual(["20260915143013_c"]);
  expect(ids({ steps: 2 })).toEqual(["20260915143013_c", "20260915143012_b"]);
  expect(ids({ to: "20260915143011_a" })).toEqual(["20260915143013_c", "20260915143012_b"]);
  expect(ids({ to: "20260915143013_c" })).toEqual([]);
  expect(() => ids({ steps: 3 })).toThrow(/20260915143011_a has an empty --down/);
  expect(() => ids({ steps: 4 })).toThrow(/steps/);
  expect(() => ids({ steps: 0 })).toThrow(/steps/);
  expect(() => ids({ to: "20990101083015_x" })).toThrow(/not an applied migration/);
  expect(() => ids({ steps: 1, to: "20260915143011_a" })).toThrow(/either/);
});

test("createMigration writes the template with the injected time and regenerates only the scope list", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-create-"));
  try {
    const now = new Date(Date.UTC(2026, 8, 15, 14, 30, 12));
    expect(await createMigration({ name: "create_students", root, now })).toEqual({
      id: "20260915143012_create_students",
      path: "src/migrations/tenant/20260915143012_create_students.sql",
    });
    expect(await Bun.file(join(root, "src/migrations/tenant/20260915143012_create_students.sql")).text()).toBe("--up\n\n--down\n");
    expect(await Bun.file(join(root, "src/migrations/tenant/index.gen.ts")).text()).toContain(
      'import m0 from "./20260915143012_create_students.sql" with { type: "text" };',
    );
    // Same second (or a clock behind the latest file) would break ID order.
    await expect(createMigration({ name: "again", root, now })).rejects.toMatchObject({ code: "MIGRATION_INVALID" });
    for (const name of ["CreateStudents", "create-students", "1st", ""])
      await expect(createMigration({ name, root, now })).rejects.toMatchObject({ code: "USAGE" });
    await expect(createMigration({ name: "x", scope: "public", root, now })).rejects.toMatchObject({ code: "USAGE" });
    expect(await readdir(join(root, "src/migrations"))).toEqual(["tenant"]);
    // An empty template is listed but not valid SQL: full codegen names the file.
    await expect(codegen(root)).rejects.toThrow(/20260915143012_create_students: SQL_UNSUPPORTED/);
    await Bun.write(
      join(root, "src/migrations/tenant/20260915143012_create_students.sql"),
      "--up\nCREATE TABLE students (id uuid PRIMARY KEY);\n--down\nDROP TABLE students;\n",
    );
    const modules = await codegen(root);
    expect([...modules.keys()]).toEqual([
      "src/migrations/tenant/index.gen.ts",
      "src/tables/tenant/students.gen.ts",
    ]);
    await Bun.write(join(root, "src/migrations/tenant/0001_old.sql"), "--up\n--down\n");
    await expect(staleFiles(root)).rejects.toThrow(/0001_old.sql: name must be/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQL seeds are tenant-bound DML only; IDs follow migration rules", () => {
  const [seed] = compileSeeds([["20260915143012_courses", "INSERT INTO courses (id, title) VALUES (gen_random_uuid(), 'x');"]]);
  expect(seed?.checksum).toHaveLength(64);
  for (const source of ["CREATE TABLE a (id uuid);", "INSERT INTO a (id) VALUES (1); DROP TABLE a;", ""])
    expect(() => compileSeeds([["20260915143012_x", source]]), source).toThrow(/20260915143012_x/);
  expect(() => compileSeeds([["1_x", "DELETE FROM a;"]])).toThrow(/IDs must be/);
});

test("createSeed writes SQL or TS templates and codegen lists TS seeds with their checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "seed-create-"));
  try {
    const now = new Date(Date.UTC(2026, 8, 15, 14, 30, 12));
    await expect(createSeed({ name: "x", root, now })).rejects.toMatchObject({ code: "USAGE" });
    await expect(createSeed({ name: "x", profile: "public", root, now })).rejects.toMatchObject({ code: "USAGE" });
    expect(await createSeed({ name: "demo_users", profile: "demo", kind: "ts", root, now })).toEqual({
      id: "20260915143012_demo_users",
      path: "src/seeds/demo/20260915143012_demo_users.ts",
    });
    const later = new Date(now.getTime() + 1000);
    expect((await createSeed({ name: "courses", profile: "demo", root, now: later })).path).toBe("src/seeds/demo/20260915143013_courses.sql");
    await expect(createSeed({ name: "again", profile: "demo", root, now })).rejects.toMatchObject({ code: "MIGRATION_INVALID" });
    const list = await Bun.file(join(root, "src/seeds/demo/index.gen.ts")).text();
    expect(list).toContain('import m0 from "./20260915143012_demo_users";');
    expect(list).toMatch(/\["20260915143012_demo_users", \{ checksum: "[0-9a-f]{64}", run: m0 \}\]/);
    expect(list).toContain('import m1 from "./20260915143013_courses.sql" with { type: "text" };');
    // The comment-only SQL template does not compile until DML is written.
    await expect(codegen(root)).rejects.toThrow(/20260915143013_courses/);
    await Bun.write(join(root, "src/seeds/demo/20260915143013_courses.sql"), "DELETE FROM courses;\n");
    expect([...(await codegen(root)).keys()]).toEqual(["src/seeds/demo/index.gen.ts"]);
    await Bun.write(join(root, "src/seeds/other/20260915143014_x.sql"), "DELETE FROM courses;\n");
    await expect(codegen(root)).rejects.toThrow(/unknown migration scope or seed profile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
