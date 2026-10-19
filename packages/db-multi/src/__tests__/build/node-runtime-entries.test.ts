/** The published `dist` must load under plain Node for every runtime entry: SQL text imports are inlined by the build, and only the Bun
 * driver (`bun:SQL`) needs Bun. Management, tools and the CLI import under Node but call Bun APIs when used (documented, Bun-only in v0.1). */
import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dir, "../../..");
const NODE_ENTRIES = ["index", "middleware", "auth", "telemetry", "management", "tools", "core/drivers/pg", "core/drivers/postgres", "core/drivers/neon"];
const BUN_ONLY_ENTRIES = ["core/drivers/bun", "core/cli"];

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "ignore", stderr: "inherit" });
  expect(await build.exited).toBe(0);
}, 180_000);

test("every runtime entry of dist imports under node", async () => {
  for (const entry of NODE_ENTRIES) {
    const url = pathToFileURL(join(root, "dist", `${entry}.js`)).href;
    const child = Bun.spawn(["node", "--input-type=module", "-e", `await import(${JSON.stringify(url)})`], { stdout: "ignore", stderr: "pipe" });
    const [code, stderr] = [await child.exited, await new Response(child.stderr).text()];
    expect({ entry, code, stderr: stderr.slice(0, 300) }).toEqual({ entry, code: 0, stderr: "" });
  }
}, 120_000);

test("every entry has a declaration file and the bin target exists with a shebang", async () => {
  for (const entry of [...NODE_ENTRIES, ...BUN_ONLY_ENTRIES]) expect({ entry, dts: existsSync(join(root, "dist", `${entry}.d.ts`)) }).toEqual({ entry, dts: true });
  expect((await Bun.file(join(root, "dist/core/cli.js")).text()).startsWith("#!/usr/bin/env bun")).toBe(true);
});

test("declaration files only use relative specifiers that NodeNext can resolve (explicit .js)", async () => {
  const bad: string[] = [];
  for (const file of new Bun.Glob("dist/**/*.d.ts").scanSync({ cwd: root })) {
    const text = await Bun.file(join(root, file)).text();
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\()["'](\.{1,2}(?:\/[^"']*)?)["']/g)) if (!/\.(js|json)$/.test(match[1] as string)) bad.push(`${file}: ${match[1]}`);
  }
  expect(bad).toEqual([]);
});
