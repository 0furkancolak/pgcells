import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, staleFiles } from "../../core/sql/codegen";
import { prepareQuery } from "../../core/sql/compiler";
import { isPreparedQuery } from "../../core/sql/query";
import * as nodeIdentity from "../../queries/node/identity.gen";
import * as platformTenants from "../../queries/platform/tenants.gen";
import * as auth from "../../queries/tenant/auth.gen";

const schema = `tenant_${"a".repeat(32)}`;
const codegen = join(import.meta.dir, "../../core/sql/codegen.ts");
const check = (cwd: string) => Bun.spawnSync(["bun", codegen, "--check"], { cwd, stderr: "pipe" });
const one = (source: string) => generate([["src/queries/tenant/q.sql", source]]).get("src/queries/tenant/q.gen.ts");

test("each query file generates its own module with unique self-describing names that bind like the compiler", async () => {
  const names = [auth, nodeIdentity, platformTenants].flatMap((module) => Object.keys(module));
  expect(names).toContain("createPasswordUser");
  expect(new Set(names).size).toBe(names.length);
  expect(names.every((name) => /^[a-z][A-Za-z0-9]*$/.test(name))).toBe(true);
  expect(isPreparedQuery(auth.createPasswordUser)).toBe(true);
  expect(Object.isFrozen(auth.createPasswordUser)).toBe(true);
  // The generated module binds the same as the compiler output of the source with the `-- name:` line stripped.
  const source = (await Bun.file(join(import.meta.dir, "../../queries/tenant/auth.sql")).text()).replace(/^-- name: createPasswordUser\n/, "").trim();
  expect(auth.createPasswordUser.bind(schema)).toBe(prepareQuery(source).bind(schema));
  expect(() => auth.createPasswordUser.bind('x"; DROP SCHEMA public; --')).toThrow();
  expect(one("-- name: lockStudent\nSELECT id FROM t FOR UPDATE")).toContain('true, "tenant", false);');
  expect([
    ...generate([
      ["src/queries/tenant/a.sql", "-- name: listA\nSELECT 1"],
      ["src/queries/tenant/b.sql", "-- name: listB\nSELECT 2"],
    ]).keys(),
  ]).toEqual(["src/queries/tenant/a.gen.ts", "src/queries/tenant/b.gen.ts"]);
});
test("the query folder is the scope: tenant schemas for tenant queries, the platform schema for node and platform queries", () => {
  expect([auth.createPasswordUser.scope, nodeIdentity.getNodeIdentity.scope, platformTenants.listTenants.scope]).toEqual(["tenant", "node", "platform"]);
  expect(platformTenants.listTenants.bind("platform")).toBe(
    prepareQuery("SELECT tenant_id, kind, status FROM placements ORDER BY tenant_id LIMIT $1 OFFSET $2", "platform").bind("platform"),
  );
  expect(nodeIdentity.getNodeIdentity.bind("platform")).toContain('"platform".node_identity');
  expect(() => platformTenants.listTenants.bind(schema)).toThrow(expect.objectContaining({ code: "QUERY_SCOPE" }));
  expect(() => auth.createPasswordUser.bind("platform")).toThrow(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  for (const scope of ["tenant", "node", "platform"]) {
    const module = generate([[`src/queries/${scope}/p.sql`, "-- name: listP\nSELECT 1"]]).get(`src/queries/${scope}/p.gen.ts`);
    expect(module).toContain('from "../../core/sql/query"');
    expect(module).toContain(`, "${scope}", true);`);
  }
  for (const path of ["src/queries/p.sql", "src/queries/x/p.sql"])
    expect(() => generate([[path, "-- name: listX\nSELECT 1"]])).toThrow("query files live in src/queries/{tenant,node,platform}/");
});
test("codegen rejects unnamed, badly named, duplicate and unsupported queries", () => {
  expect(() => one("SELECT 1")).toThrow(/-- name/);
  for (const name of ["list_students", "ListStudents", "2fa"])
    expect(() => one(`-- name: ${name}\nSELECT 1`)).toThrow(/must match/);
  expect(() => one("-- name: listA\nSELECT 1\n-- name: listA\nSELECT 2")).toThrow(/duplicate/);
  expect(() =>
    generate([
      ["src/queries/tenant/a.sql", "-- name: listItems\nSELECT 1"],
      ["src/queries/platform/b.sql", "-- name: listItems\nSELECT 2"],
    ]),
  ).toThrow("duplicate query listItems (also in src/queries/tenant/a.sql)");
  expect(() => one("-- name: bad\nSELECT * FROM public.students")).toThrow(/bad: SQL_UNSUPPORTED/);
  expect(() => one("-- name: two\nSELECT 1; SELECT 2")).toThrow(/SQL_UNSUPPORTED/);
});
test("codegen --check passes in the repository and fails on drift", async () => {
  expect(check(process.cwd()).exitCode).toBe(0);
  const root = await mkdtemp(join(tmpdir(), "codegen-"));
  const dir = join(root, "src/queries/tenant");
  await mkdir(join(root, "src/__tests__"), { recursive: true });
  await mkdir(dir, { recursive: true });
  const source = "-- name: listDemo\nSELECT id FROM demo";
  const generated = one(source) ?? "";
  await writeFile(join(dir, "demo.sql"), source);
  await writeFile(join(dir, "demo.gen.ts"), generate([["src/queries/tenant/demo.sql", source]]).get("src/queries/tenant/demo.gen.ts") ?? "");
  // Tests may mention defineQuery; they are not application code.
  await writeFile(join(root, "src/__tests__/x.ts"), "defineQuery([], false)");
  expect(await staleFiles(root)).toEqual([]);
  // A hand-edit (here: dropping the schema qualification) must be detected.
  await writeFile(join(dir, "demo.gen.ts"), generated.replace('",".demo', ".demo"));
  await writeFile(join(dir, "orphan.gen.ts"), "");
  await writeFile(join(root, "src/repository.ts"), "defineQuery([], false)");
  await writeFile(join(dir, "missing.sql"), "-- name: listMissing\nSELECT 1");
  expect(await staleFiles(root)).toEqual([
    "src/queries/tenant/demo.gen.ts",
    "src/queries/tenant/missing.gen.ts",
    "src/queries/tenant/orphan.gen.ts",
    "src/repository.ts",
  ]);
  const result = check(root);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("demo.gen.ts");
});
test("runtime entry and Worker bundles never include the SQL parser, compiler, management, migrations or tools", async () => {
  // Bun supports `metafile`; the pinned @types/bun predates its typings.
  const build = (await Bun.build({
    entrypoints: ["src/index.ts", "src/__tests__/fixtures/worker.ts"],
    target: "bun",
    metafile: true,
  } as Bun.BuildConfig)) as Bun.BuildOutput & {
    metafile: { outputs: Record<string, { inputs: Record<string, unknown> }> };
  };
  expect(build.success).toBe(true);
  const outputs = Object.entries(build.metafile.outputs);
  expect(outputs).toHaveLength(2);
  // The runtime entry loads no driver; the Worker bundles only postgres.js (never Bun SQL or pg).
  const forbidden =
    /pgsql-ast-parser|^src\/core\/sql\/(compiler|grammar|comments|codegen)\.ts|^src\/(core\/)?(management|cli)\.ts|^src\/(core\/)?(migrations|operations|tools)\/|^src\/core\/drivers\/(bun|pg)\.ts|node_modules\/pg\//;
  for (const [name, output] of outputs) {
    const inputs = Object.keys(output.inputs);
    expect(inputs).toContain("src/core/sql/query.ts");
    expect(inputs.filter((path) => forbidden.test(path))).toEqual([]);
    expect(inputs.includes("src/core/drivers/postgres.ts")).toBe(name.includes("worker"));
  }
});
