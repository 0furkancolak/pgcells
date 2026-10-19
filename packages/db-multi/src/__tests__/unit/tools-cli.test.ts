import { expect, test } from "bun:test";
import { parseOptions } from "../../core/cli";

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

test("tool options: bounded sizes and counts, boolean --full, string lists and conflict policy", () => {
  expect(parseOptions(["--size", "40", "--full", "--tenants=abc,shop-1"], ["--size", "--full", "--tenants"])).toEqual({ size: 40, full: true, tenants: "abc,shop-1" });
  expect(parseOptions(["--capacity=5000", "--keep", "7", "--batch-size", "250"], ["--capacity", "--keep", "--batch-size"])).toEqual({
    capacity: 5000,
    keep: 7,
    batchSize: 250,
  });
  // `--from-url` is a switch: the URL is not written to argv, it is asked for via hidden input.
  expect(parseOptions(["--source", "legacy", "--on-conflict", "link", "--from-url"], ["--source", "--on-conflict", "--from-url"])).toEqual({
    source: "legacy",
    onConflict: "link",
    fromUrl: true,
  });
  expect(code(() => parseOptions(["--from-url=postgres://u:p@h/db"], ["--from-url"]))).toBe("USAGE");
  expect(parseOptions(["--per-db-concurrency", "3"], ["--per-db-concurrency"])).toEqual({ perDatabaseConcurrency: 3 });
  for (const [args, allowed] of [
    [["--size", "0"], ["--size"]],
    [["--size", "101"], ["--size"]],
    [["--capacity", "1000001"], ["--capacity"]],
    [["--keep", "x"], ["--keep"]],
  ] as const)
    expect(code(() => parseOptions(args, allowed)), args.join(" ")).toBe("INVALID_CONFIG");
  expect(code(() => parseOptions(["--full"], ["--size"]))).toBe("USAGE");
});
