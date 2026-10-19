/** Runner'ın kilit içi sıralaması sahte sürücüyle: önkoşul kilit oturumunda denetlenir, drift yan etkiden önce çıkar, geri alma span'i. */
import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import type { Span } from "../../core/database";
import { createManagement } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import { compileMigrations, compileSeeds } from "../../core/migrations/source";
import { fakeDriver } from "../fixtures/fake-driver";

const migrations = compileMigrations([["20260101000001_a", "--up\nCREATE TABLE a (id integer PRIMARY KEY);\n--down\nDROP TABLE a;\n"]]);
const runner = createRunner({ migrations, seeds: compileSeeds([["20260101000002_s", "INSERT INTO a (id) VALUES (1);"]]) });
const APPLIED = migrations.map(({ id, checksum }) => ({ id, checksum }));

let port = 7300;
/** Kilit her zaman alınır, ledger'lar vardır; migration ledger'ı havuz başına `ledger(havuz)` döner (0: yönetim, 1: kilit oturumu). */
function management(ledger: (pool: number) => unknown[], onSpan?: (span: Span) => void) {
  const fake = fakeDriver((text, _params, pool) => {
    if (text.includes("pg_locks")) return [{ pid: 100 + pool.index, held: true }];
    if (text.includes("pg_try_advisory_lock")) return [{ locked: true }];
    if (text.includes("pg_advisory_unlock")) return [{ unlocked: true }];
    if (text.includes("pg_backend_pid")) return [{ pid: 100 + pool.index }];
    if (text.includes("current_database() AS name")) return [{ name: "app" }];
    if (text.includes("IS NOT NULL AS exists") || text.includes("pg_namespace")) return [{ exists: true }];
    if (text.includes('"_migrations" ORDER BY id')) return ledger(pool.index);
    return [];
  });
  const m = createManagement(createConfig(`postgres://admin@127.0.0.1:${port++}/app`), { driver: fake.driver, onSpan });
  return { m, fake };
}

test("seed re-checks pending migrations under the lock, not only before it", async () => {
  const { m, fake } = management((pool) => (pool === 0 ? APPLIED : []));
  await expect(runner.seed(m)).rejects.toMatchObject({ code: "MIGRATIONS_PENDING" });
  expect(fake.commands.some((command) => command.text.includes("_seeds"))).toBe(false);
  await m.close();
});

test("migrate reports drift before creating the schema or writing database defaults", async () => {
  const { m, fake } = management(() => [{ id: "20250101000001_gone", checksum: "x" }]);
  await expect(runner.migrate(m)).rejects.toMatchObject({ code: "MIGRATION_DRIFT" });
  expect(fake.commands.filter((command) => /CREATE SCHEMA|ALTER DATABASE|CREATE TABLE/.test(command.text))).toEqual([]);
  await m.close();
});

test("each rolled back migration reports a rollback span with its id", async () => {
  const spans: Span[] = [];
  const { m } = management(() => APPLIED, (span) => void spans.push(span));
  await runner.rollback(m);
  expect(spans.filter((span) => !span.name.startsWith("db.")).map((span) => [span.name, span.detail])).toEqual([["rollback", "20260101000001_a"]]);
  await m.close();
});
