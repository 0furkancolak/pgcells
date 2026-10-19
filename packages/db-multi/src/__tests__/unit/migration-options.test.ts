import { expect, test } from "bun:test";
import { parseOptions } from "../../core/cli";

test("migration CLI parses bounded overrides and explicit failure policy", () => {
  expect(
    parseOptions([
      "--db",
      "db0,db1",
      "--concurrency",
      "16",
      "--per-db-concurrency",
      "8",
      "--dry-run",
      "--continue-on-error",
    ]),
  ).toEqual({
    databaseIds: ["db0", "db1"],
    concurrency: 16,
    perDatabaseConcurrency: 8,
    dryRun: true,
    continueOnError: true,
  });
  for (const args of [
    ["--concurrency", "0"],
    ["--concurrency", "129"],
    ["--per-db-concurrency", "1.5"],
    ["--db", ""],
    ["--db", "db0,db0"],
    ["--db", "shared_01"],
    ["--db"],
    ["--typo"],
    ["--concurrency", "2", "--concurrency", "3"],
  ])
    expect(() => parseOptions(args)).toThrow();
});
