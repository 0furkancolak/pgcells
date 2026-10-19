import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

/** Tenant routing never relies on session state: SQL is qualified with the schema at compile time. No exceptions. Across the repo,
 * source, SQL, fixtures and configuration are scanned; docs are not (the sentence "`search_path` is not used" is not execution). */
const REPO = join(import.meta.dir, "../../../../..");
const SCANNED = [
  "packages/*/src/**/*.{ts,js,sql}",
  "packages/*/fixtures/**/*.sql",
  "packages/*/k6/**/*.js",
  "packages/*/*.{yaml,yml,json}",
  "packages/*/.env.example",
  "packages/db-multi/src/core/local/**/*.{ini,txt}",
  ".github/**/*.{yml,yaml}",
];
/** `SET`/`RESET` (including role/DB defaults), `set_config`, URL `options=-c search_path` ve `?search_path=`. */
const RUNTIME_FORMS = [
  /\b(?:SET|RESET)\s+(?:LOCAL\s+|SESSION\s+)?search_path\b/i,
  /\bset_config\s*\(\s*['"]search_path/i,
  /options=-c(?:\s|%20)*search_path/i,
  /[?&]search_path=/i,
];
/** Tests that feed the forbidden form as input only to verify it is rejected. */
const REJECTION_TESTS = new Set([
  "packages/db-multi/src/__tests__/unit/routing-guard.test.ts",
  "packages/db-multi/src/__tests__/unit/sql.test.ts",
  "packages/db-multi/src/__tests__/unit/copy.test.ts",
  "packages/db-multi/src/__tests__/unit/database-config.test.ts",
]);
const executesSearchPath = (text: string) => RUNTIME_FORMS.some((form) => form.test(text));

test("no source, SQL, fixture or config in the repository sets, resets or configures search_path", async () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const pattern of SCANNED)
    for await (const path of new Glob(pattern).scan({ cwd: REPO, dot: true })) {
      if (path.includes("node_modules/") || REJECTION_TESTS.has(path)) continue;
      scanned++;
      if (executesSearchPath(await Bun.file(join(REPO, path)).text())) offenders.push(path);
    }
  expect(scanned).toBeGreaterThan(100);
  expect(offenders).toEqual([]);
});

test("the guard recognises every runtime form and ignores prose", () => {
  for (const sample of [
    "SET search_path TO tenant_a",
    "reset search_path",
    "SET LOCAL search_path = tenant_a",
    "SELECT pg_catalog.set_config('search_path', '', false);",
    "ALTER ROLE app SET search_path = tenant_a",
    "postgres://h/app?options=-csearch_path%3Dtenant_a",
    "postgres://h/app?options=-c%20search_path%3Dtenant_a",
    "postgres://h/app?sslmode=require&search_path=tenant_a",
  ])
    expect(executesSearchPath(sample)).toBe(true);
  expect(executesSearchPath("- `search_path` is not used in any step; ROUTING_PARAMETERS = ['options', 'search_path']")).toBe(false);
});
