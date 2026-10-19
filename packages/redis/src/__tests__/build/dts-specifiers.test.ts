/** Published declaration files must use relative specifiers NodeNext can resolve (explicit `.js`), otherwise every type is `any` for such consumers. */
import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

beforeAll(async () => {
  // redis declarations are checked against the built db-multi declarations
  for (const cwd of [join(root, "../db-multi"), root]) {
    const build = Bun.spawn(["bun", "run", "build"], { cwd, stdout: "ignore", stderr: "inherit" });
    expect(await build.exited).toBe(0);
  }
}, 240_000);

test("declaration files only use relative specifiers that NodeNext can resolve (explicit .js)", async () => {
  const bad: string[] = [];
  for (const file of new Bun.Glob("dist/**/*.d.ts").scanSync({ cwd: root })) {
    const text = await Bun.file(join(root, file)).text();
    for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\()["'](\.{1,2}(?:\/[^"']*)?)["']/g)) if (!/\.(js|json)$/.test(match[1] as string)) bad.push(`${file}: ${match[1]}`);
  }
  expect(bad).toEqual([]);
});
