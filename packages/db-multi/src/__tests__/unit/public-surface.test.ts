/** Application-specific platform-move/merge tooling is not part of this repository; the published surface must not grow it back. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as tools from "../../tools";

const source = (file: string) => readFileSync(join(import.meta.dir, "../..", file), "utf8");

test("tools entry exports no platform-move or platform-merge operations", () => {
  expect(Object.keys(tools).filter((name) => /PlatformMove|movePlatform|Merge/i.test(name))).toEqual([]);
  expect(Object.keys(tools)).toEqual(expect.arrayContaining(["backupAll", "restoreTenant", "startMove", "setDatabase", "adoptSchemas"]));
});

test("cli has no platform-move command", () => {
  expect(source("core/cli.ts")).not.toMatch(/platform-move|platform-merge|mergeOptions/);
});
