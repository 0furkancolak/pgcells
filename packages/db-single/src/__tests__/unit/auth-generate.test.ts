/** `generateAuthMigration`: paketin migration'larını geçici schema'ya yeniden oynatır; CONCURRENTLY index transaction dışında çalışır,
 * iptal dosya yazmaz ve geçici schema her yolda düşürülür (düşürme hatası asıl hatayı gizlemez). */
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import authOptions from "../fixtures/auth-options";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { compileMigrations } from "../../core/migrations/source";
import { generateAuthMigration } from "../../core/tools/auth";
import { fakeDriver, type Handler } from "../fixtures/fake-driver";

const registry = {
  migrations: compileMigrations([
    ["20260101000001_notes", "--up\nCREATE TABLE notes (id integer PRIMARY KEY, body text);\n--down\nDROP TABLE notes;\n"],
    ["20260101000002_notes_index", "--up\nCREATE INDEX CONCURRENTLY notes_body_idx ON notes (body);\n--down\nDROP INDEX CONCURRENTLY notes_body_idx;\n"],
  ]),
  seeds: [],
};

function run(handler: Handler, options: { signal?: AbortSignal; root?: string } = {}) {
  const fake = fakeDriver(handler);
  const m = createManagement(createConfig("postgres://admin:secret-pw@127.0.0.1:7100/app"), { driver: fake.driver });
  const result = generateAuthMigration({ db: m, options: authOptions, registry, root: "/nonexistent", ...options }).catch((error: unknown) => error as Error);
  return { fake, result: result.finally(() => m.close()) };
}
const texts = (fake: ReturnType<typeof fakeDriver>) => fake.commands.map((command) => command.text);

test("a CREATE INDEX CONCURRENTLY migration is replayed outside a transaction, so auth generate does not fail with 25001", async () => {
  const { fake, result } = run((text) => {
    if (text.includes("information_schema")) throw new Error("stop after the replay");
    return [];
  });
  await result;
  const all = texts(fake);
  const at = all.findIndex((text) => text.includes("CREATE INDEX CONCURRENTLY"));
  expect(at).toBeGreaterThan(0);
  expect(all[at - 1]).not.toMatch(/^BEGIN/);
  expect(all[at + 1]).not.toBe("COMMIT");
  // Sıradan DDL transaction'da kalır.
  expect(all[all.findIndex((text) => text.includes("CREATE TABLE")) - 1]).toMatch(/^BEGIN/);
});

test("an interrupt before the file is written cancels the run and still drops the temporary schema", async () => {
  const abort = new AbortController();
  const { fake, result } = run((text) => {
    if (text.includes("information_schema")) abort.abort();
    return [];
  }, { signal: abort.signal });
  expect(await result).toMatchObject({ code: "MIGRATION_CANCELLED" });
  expect(texts(fake).some((text) => text.startsWith("DROP SCHEMA"))).toBe(true);
});

test("an interrupt during the replay stops it between migrations: nothing more is replayed, no file is written, the schema is dropped", async () => {
  const abort = new AbortController();
  const root = await mkdtemp(join(tmpdir(), "single-auth-abort-"));
  try {
    const { fake, result } = run(
      (text) => {
        if (text.includes("CREATE TABLE")) abort.abort();
        return [];
      },
      { signal: abort.signal, root },
    );
    expect(await result).toMatchObject({ code: "MIGRATION_CANCELLED" });
    const all = texts(fake);
    expect(all.some((text) => text.includes("CREATE INDEX CONCURRENTLY"))).toBe(false);
    expect(all.some((text) => text.includes("information_schema"))).toBe(false);
    expect(all.some((text) => text.startsWith("DROP SCHEMA"))).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing schema drop does not replace the original error", async () => {
  const { result } = run((text) => {
    if (text.includes("information_schema")) throw Object.assign(new Error("original failure"), { code: "40001" });
    if (text.startsWith("DROP SCHEMA")) throw Object.assign(new Error("drop failed"), { code: "42501" });
    return [];
  });
  expect((await result as Error).message).toContain("40001");
});
