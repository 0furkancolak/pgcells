import { expect, test } from "bun:test";
import { join } from "node:path";
import { createConfig } from "../../core/config";
import { generatePoolerFiles } from "../../core/tools/pooler-generate";

const golden = join(import.meta.dir, "../fixtures/pooler");
const config = createConfig(
  ["postgres://admin:s3cret-pw@pg0.eu.internal:5432/app", "postgres://admin:s3cret-pw@pg1.eu.internal:6543/tenants"],
  ["db1=postgres://admin:s3cret-pw@pg1-ro.eu.internal/tenants", "db1=postgres://admin:s3cret-pw@pg1-ro2.eu.internal/tenants"],
);

test("the generated files match the golden files byte for byte (regenerate them deliberately with UPDATE_GOLDEN=1)", async () => {
  const files = generatePoolerFiles({ nodes: config.nodes });
  for (const [name, text] of Object.entries(files)) {
    const file = Bun.file(join(golden, name));
    if (process.env.UPDATE_GOLDEN === "1") await Bun.write(file, text);
    expect(text).toBe(await file.text());
  }
});

test("output never contains a password, and is identical for the same input in any node order", () => {
  const files = generatePoolerFiles({ nodes: config.nodes });
  expect(JSON.stringify(files)).not.toContain("s3cret-pw");
  expect(generatePoolerFiles({ nodes: [...config.nodes].reverse() })).toEqual(files);
});

test("every node and replica gets an alias, and the real database name is kept", () => {
  const ini = generatePoolerFiles({ nodes: config.nodes })["pgbouncer.ini"];
  expect(ini).toContain("db0 = host=pg0.eu.internal port=5432 dbname=app pool_size=20");
  expect(ini).toContain("db1 = host=pg1.eu.internal port=6543 dbname=tenants pool_size=20");
  expect(ini).toContain("db1_ro1 = host=pg1-ro.eu.internal port=5432 dbname=tenants");
  expect(ini).toContain("db1_ro2 = host=pg1-ro2.eu.internal port=5432 dbname=tenants");
});

test("query_wait_timeout stays above the application's answer deadline and follows statementTimeoutMs", () => {
  const wait = (statementTimeoutMs: number) =>
    Number(/query_wait_timeout = (\d+)/.exec(generatePoolerFiles({ nodes: config.nodes, statementTimeoutMs })["pgbouncer.ini"])?.[1]);
  expect(wait(5000)).toBe(8);
  expect(wait(5000)).toBeGreaterThan(5 + 1.5);
  expect(wait(30_000)).toBeGreaterThan(30 + 1.5);
});

test("sizes are bounded to whole positive numbers", () => {
  for (const bad of [{ poolers: 0 }, { defaultPoolSize: 1.5 }, { maxClientConn: -1 }])
    expect(() => generatePoolerFiles({ nodes: config.nodes, ...bad })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
