/** Guard: this package's source has no multi-tenant vocabulary. Notes explaining why live only under `docs/` (this test does not look there). */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const WORDS = /tenant|placement|platform/i;
const PATTERNS = ["src/**/*", "package.json", "compose.yaml", ".env.example"];
// The guard itself and the docs check (which verifies that docs/from-multi.md deliberately contains the vocabulary) have to mention the words.
const EXEMPT = ["src/__tests__/unit/no-multi-tenant.test.ts", "src/__tests__/unit/docs.test.ts"];

test("package sources, manifests and compose files use no multi-tenant vocabulary", async () => {
  const hits: string[] = [];
  // Bun Glob does not match alternatives containing `/` and `**` inside braces (0 files); the patterns are scanned separately.
  const files = PATTERNS.flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: root, dot: true })]);
  expect(files).toContain("package.json");
  expect(files.some((file) => file.startsWith("src/core/"))).toBe(true);
  for (const file of files) {
    if (EXEMPT.includes(file)) continue;
    (await Bun.file(join(root, file)).text()).split("\n").forEach((line, index) => {
      if (WORDS.test(line)) hits.push(`${file}:${index + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  expect(hits).toEqual([]);
});
