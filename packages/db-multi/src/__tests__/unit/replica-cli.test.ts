import { expect, test } from "bun:test";
import { parseOptions, replicaEntries, splitArguments } from "../../core/cli";

test("--from-replica is a value-less switch accepted by backup and export", () => {
  expect(parseOptions(["--from-replica"], ["--from-replica"])).toEqual({ fromReplica: true });
  expect(() => parseOptions(["--from-replica=1"], ["--from-replica"])).toThrow("--from-replica takes no value");
  expect(splitArguments({ usage: "<tenant> <dir> [--from-replica]", flags: ["--from-replica"] }, ["abc", "out", "--from-replica"])).toEqual({
    positional: ["abc", "out"],
    options: ["--from-replica"],
  });
});

test("replicaEntries validates db<N>=postgres://… entries and never echoes the value", () => {
  expect(replicaEntries("db0=postgres://u:p@h:5432/app, db1=postgresql://u:p@h2/app")).toBe("db0=postgres://u:p@h:5432/app,db1=postgresql://u:p@h2/app");
  for (const bad of ["postgres://u:secret-pw@h/app", "db0=http://u:secret-pw@h/app", "x=postgres://u:secret-pw@h/app", "db0=", ""]) {
    const error = (() => {
      try {
        replicaEntries(bad);
      } catch (e) {
        return e as { code: string; message: string };
      }
    })();
    expect(error?.code).toBe("USAGE");
    expect(error?.message).not.toContain("secret-pw");
  }
});
