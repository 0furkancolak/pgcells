/** Komut satırında yanlışlıkla yazılan bir URL (parolalı) hiçbir hata iletisinde yer almaz: ileti değeri değil, kuralı söyler. */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions } from "../../core/cli";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import { rollbackTargets } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { assertFree, restoreSchema } from "../../core/tools/backup";
import { fakeDriver } from "../fixtures/fake-driver";

const URL_VALUE = "postgres://user:secret@host/db";
const registry = { migrations: compileMigrations([["20260101000001_a", "--up\nCREATE TABLE a (id integer PRIMARY KEY);\n--down\nDROP TABLE a;\n"]]), seeds: [] };


test("a URL typed as a migration id, backup set, backup folder or option never appears in the error", async () => {
  const root = await mkdtemp(join(tmpdir(), "single-echo-"));
  const typed = join(root, "postgres:", "user:secret@host", "db");
  await mkdir(typed, { recursive: true });
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_locks")) return [{ pid: 100 + pool.index, held: true }];
    if (text.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
    if (text.includes("pg_backend_pid")) return [{ pid: 100 + pool.index }];
    if (text.includes("current_database() AS name")) return [{ name: "app" }];
    if (text.includes("pg_namespace")) return [{ exists: true }];
    return [];
  });
  const m = createManagement(createConfig("postgres://admin@127.0.0.1:7950/app"), { driver: fake.driver });
  const cases: [string, string, () => unknown][] = [
    ["baseline <id>", "MIGRATION_NOT_PENDING", () => createRunner(registry).baseline(m, URL_VALUE)],
    ["--to <id>", "MIGRATION_NOT_APPLIED", () => rollbackTargets(registry.migrations, { to: URL_VALUE })],
    ["--set <id>", "BACKUP_NOT_FOUND", () => restoreSchema(m, root, { set: URL_VALUE, registry })],
    ["backup folder", "BACKUP_EXISTS", () => assertFree(typed)],
    ["unknown option", "USAGE", () => parseOptions([`--${URL_VALUE}`], ["--keep"])],
  ];
  try {
    for (const [label, code, work] of cases) {
      const error = (await Promise.resolve().then(work).catch((caught: unknown) => caught)) as Error;
      expect(error, label).toMatchObject({ code });
      expect(error.message, label).not.toMatch(/secret|user|host|postgres/);
    }
  } finally {
    await m.close();
    await rm(root, { recursive: true, force: true });
  }
});
