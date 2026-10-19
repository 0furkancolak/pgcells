import { describe, expect, test } from "bun:test";
import { pendingMigrations, rollbackTargets } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";

const list = compileMigrations([
  ["20260101000001_a", "--up\nCREATE TABLE a (id integer PRIMARY KEY);\n--down\nDROP TABLE a;\n"],
  ["20260101000002_b", "--up\nCREATE TABLE b (id integer PRIMARY KEY);\n--down\nDROP TABLE b;\n"],
  ["20260101000003_c", "--up\nCREATE TABLE c (id integer PRIMARY KEY);\n--down\n"],
]);
const history = (count: number) => list.slice(0, count).map(({ id, checksum }) => ({ id, checksum }));

describe("migration planner", () => {
  test("the immutable list yields the unapplied suffix", () => {
    expect(pendingMigrations([], list).map((m) => m.id)).toEqual(list.map((m) => m.id));
    expect(pendingMigrations(history(2), list).map((m) => m.id)).toEqual(["20260101000003_c"]);
    expect(pendingMigrations(history(3), list)).toHaveLength(0);
  });
  test("checksum drift, unknown history, duplicates and holes are errors, never silent migrations", () => {
    expect(() => pendingMigrations([{ id: list[0]?.id ?? "", checksum: "changed" }], list)).toThrow("Unknown or modified migration");
    expect(() => pendingMigrations([{ id: "20990101000000_unknown", checksum: "x" }], list)).toThrow(expect.objectContaining({ code: "MIGRATION_DRIFT" }));
    expect(() => pendingMigrations([...history(1), ...history(1)], list)).toThrow("Duplicate");
    const second = list[1];
    expect(() => pendingMigrations([{ id: second?.id ?? "", checksum: second?.checksum ?? "" }], list)).toThrow("gap");
    expect(() => pendingMigrations(history(1).map((h) => ({ ...h, checksum: "x" })), list, "SEED_DRIFT")).toThrow(expect.objectContaining({ code: "SEED_DRIFT" }));
  });
  test("one definition binds to any schema", () => {
    expect(list[0]?.up.bind("app_a").join("\n")).toContain('"app_a".a');
    expect(list[0]?.up.bind("app_b").join("\n")).not.toContain('"app_a"');
  });
});

describe("rollbackTargets", () => {
  test("steps and to pick the newest applied migrations, newest first", () => {
    const applied = list.slice(0, 2);
    expect(rollbackTargets(applied, {}).map((m) => m.id)).toEqual(["20260101000002_b"]);
    expect(rollbackTargets(applied, { steps: 2 }).map((m) => m.id)).toEqual(["20260101000002_b", "20260101000001_a"]);
    expect(rollbackTargets(applied, { to: "20260101000001_a" }).map((m) => m.id)).toEqual(["20260101000002_b"]);
  });
  test("bad targets are refused before any DDL", () => {
    const applied = list.slice(0, 2);
    expect(() => rollbackTargets(applied, { steps: 1, to: "20260101000001_a" })).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(() => rollbackTargets(applied, { steps: 3 })).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(() => rollbackTargets(applied, { steps: 0 })).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(() => rollbackTargets(applied, { to: "20260101000009_nope" })).toThrow(expect.objectContaining({ code: "MIGRATION_NOT_APPLIED" }));
    expect(() => rollbackTargets(list, { steps: 1 })).toThrow(expect.objectContaining({ code: "MIGRATION_IRREVERSIBLE" }));
  });
});
