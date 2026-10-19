/** Persisted identifiers must never change: the migration/seed ledger stores a SHA-256 of every applied file (a changed byte is
 * MIGRATION_DRIFT / SEED_DRIFT), derived secrets and lock keys are shared by every process in a mixed fleet. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const packageRoot = join(import.meta.dir, "../../..");
const golden = JSON.parse(readFileSync(join(import.meta.dir, "frozen-identifiers.golden.json"), "utf8")) as {
  files: Record<string, string>;
  needles: { file: string; text: string }[];
};

const digest = (path: string) => createHash("sha256").update(readFileSync(join(packageRoot, path))).digest("hex");

test("applied migration and seed files keep their exact bytes", () => {
  const current = new Set<string>();
  for (const dir of ["src/migrations", "src/seeds"]) {
    for (const entry of readdirSync(join(packageRoot, dir), { recursive: true, withFileTypes: true }))
      if (entry.isFile() && entry.name !== "index.gen.ts") current.add(relative(packageRoot, join(entry.parentPath, entry.name)));
  }
  const missing = Object.keys(golden.files).filter((path) => !current.has(path));
  const changed = Object.entries(golden.files).filter(([path, hash]) => current.has(path) && digest(path) !== hash).map(([path]) => path);
  expect({ missing, changed }).toEqual({ missing: [], changed: [] });
});

test("persisted strings are still present in source", () => {
  const absent = golden.needles.filter(({ file, text }) => !readFileSync(join(packageRoot, file), "utf8").includes(text));
  expect(absent).toEqual([]);
});
