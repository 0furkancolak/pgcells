import { expect, jest, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { restoreSchema } from "../../core/tools/backup";
import { fakeDriver } from "../fixtures/fake-driver";

const facts = { major: 17, locale: "{}", extensions: "[]" };
const meta = {
  format: 1,
  schema: "public",
  takenAt: "2026-01-01T00:00:00.000Z",
  facts,
  shape: {
    tables: [{ name: "_migrations" }],
    columns: [{ table: "_migrations", name: "id", type: "text", identity: "", generated: "", notNull: true, expression: null, sequence: null }],
    sequences: [],
    constraints: [],
    indexes: [],
    states: [],
  },
  tables: [{ name: "_migrations", file: "0.jsonl.gz", rows: 0 }],
};
/** Real timers: to wait for file I/O to progress after the fake timers are installed. */
const realImmediate = setImmediate;

async function backupDir(format = meta.format) {
  const dir = await mkdtemp(join(tmpdir(), "single-restore-"));
  await writeFile(join(dir, "backup.json"), JSON.stringify({ ...meta, format }));
  await writeFile(join(dir, "0.jsonl.gz"), Bun.gzipSync(""));
  return dir;
}

/** Catalog responses for setting up into an empty target; `count` is the answer to the table row-count query. */
const restoreCatalog = (count: () => unknown[] | Promise<unknown[]> = () => [{ n: 0 }]) =>
  fakeDriver((text, _params, pool) => {
    if (text.includes("pg_locks")) return [{ pid: 100 + pool.index, held: true }];
    if (text.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
    if (text.includes("current_database() AS name")) return [{ name: "app" }];
    if (text.includes("current_schemas")) return [{ safe: true }];
    if (text.includes("NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class")) return [{ empty: true }];
    if (text.includes("server_version_num")) return [facts];
    if (text.includes("pg_backend_pid")) return [{ pid: 100 + pool.index }];
    if (text.includes("count(*)")) return count();
    return [];
  });

test("restore reads backup format 1 (before enums were stored) and format 2; any other format is BACKUP_INVALID", async () => {
  for (const format of [1, 2, 3]) {
    const dir = await backupDir(format);
    const m = createManagement(createConfig("postgres://admin@127.0.0.1:7900/app"), { driver: restoreCatalog().driver });
    try {
      const outcome = await restoreSchema(m, dir, { registry: { migrations: [], seeds: [] } }).then(
        (result) => result.rows,
        (error: { code: string }) => error.code,
      );
      expect(outcome, `format ${format}`).toBe(format === 3 ? "BACKUP_INVALID" : 0);
    } finally {
      await m.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a restore statement slower than the 35 s management watchdog completes: the restore session widens its watchdog", async () => {
  const dir = await backupDir();
  let reached = false;
  const fake = restoreCatalog(() => {
    reached = true;
    // A 40 s statement instead of an hour-long one: it exceeds the default 35 s watchdog.
    return new Promise<{ n: number }[]>((resolve) => setTimeout(() => resolve([{ n: 0 }]), 40_000));
  });
  const m = createManagement(createConfig("postgres://admin@127.0.0.1:7900/app"), { driver: fake.driver });
  try {
    jest.useFakeTimers();
    const restored = restoreSchema(m, dir, { registry: { migrations: [], seeds: [] } }).then(
      (result) => result,
      (error: { code: string }) => error.code,
    );
    for (const stop = performance.now() + 3000; !reached && performance.now() < stop; ) await new Promise((resolve) => realImmediate(resolve));
    (jest as unknown as { advanceTimersByTime(ms: number): void }).advanceTimersByTime(40_001);
    expect(await restored).toMatchObject({ rows: 0, migrationsApplied: [] });
  } finally {
    jest.useRealTimers();
    await m.close();
    await rm(dir, { recursive: true, force: true });
  }
});
