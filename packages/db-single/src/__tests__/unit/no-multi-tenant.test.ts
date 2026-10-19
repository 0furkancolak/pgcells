/** Bekçi: bu paketin kaynağında çok-tenant sözlüğü yoktur. Nedenini anlatan notlar yalnızca `docs/` altındadır (bu test oraya bakmaz). */
import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const WORDS = /tenant|placement|platform/i;
const PATTERNS = ["src/**/*", "package.json", "compose.yaml", ".env.example"];
// Bekçinin kendisi ve belge denetimi (docs/from-multi.md'nin sözlüğü bilerek içerdiğini sınar) sözcükleri anmak zorundadır.
const EXEMPT = ["src/__tests__/unit/no-multi-tenant.test.ts", "src/__tests__/unit/docs.test.ts"];

test("package sources, manifests and compose files use no multi-tenant vocabulary", async () => {
  const hits: string[] = [];
  // Bun Glob, süslü parantez içinde `/` ve `**` barındıran alternatifleri eşleştirmiyor (0 dosya); desenler ayrı taranır.
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
