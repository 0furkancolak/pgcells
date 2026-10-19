import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFree, pruneBackups } from "../../core/tools/backup";

async function root(sets: Record<string, boolean>) {
  const dir = await mkdtemp(join(tmpdir(), "single-prune-"));
  for (const [id, complete] of Object.entries(sets)) {
    await mkdir(join(dir, id));
    if (complete) await writeFile(join(dir, id, "backup.json"), "{}");
  }
  return dir;
}

test("prune keeps the newest N complete sets, removes older ones and never touches incomplete or foreign folders", async () => {
  const dir = await root({ "20260101000001": true, "20260101000002": true, "20260101000003": true, "20260101000004": false });
  await mkdir(join(dir, "notes"));
  try {
    expect(await pruneBackups(dir, 2)).toEqual({ kept: ["20260101000002", "20260101000003"], removed: ["20260101000001"] });
    expect((await readdir(dir)).sort()).toEqual(["20260101000002", "20260101000003", "20260101000004", "notes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune accepts a numeric string, refuses 0 and non-numbers, and an empty or missing root is a no-op", async () => {
  const dir = await root({ "20260101000001": true });
  try {
    expect(await pruneBackups(dir, "5")).toEqual({ kept: ["20260101000001"], removed: [] });
    for (const bad of [0, "x", 1001]) await expect(pruneBackups(dir, bad)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(await pruneBackups(join(dir, "missing"), 1)).toEqual({ kept: [], removed: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prune never removes the set the same run just wrote, even when a clock step made it the oldest", async () => {
  const dir = await root({ "20260101000001": true, "20260101000002": true, "20260101000003": true });
  try {
    expect(await pruneBackups(dir, 1, "20260101000001")).toEqual({ kept: ["20260101000001", "20260101000003"], removed: ["20260101000002"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing target is BACKUP_EXISTS without blaming a .partial; a leftover .partial is named, also for a target written with a trailing slash", async () => {
  const dir = await root({});
  try {
    await mkdir(join(dir, "x"));
    await expect(assertFree(join(dir, "x"))).rejects.toMatchObject({ code: "BACKUP_EXISTS", message: expect.not.stringContaining(".partial") });
    await mkdir(join(dir, "y.partial"));
    for (const target of [join(dir, "y"), `${join(dir, "y")}/`])
      await expect(assertFree(target)).rejects.toMatchObject({ code: "BACKUP_EXISTS", message: expect.stringContaining(".partial") });
    await assertFree(join(dir, "z"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
