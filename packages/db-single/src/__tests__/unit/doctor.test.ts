import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import type { Registry } from "../../core/migrations/registry";
import { compileMigrations } from "../../core/migrations/source";
import { doctor } from "../../core/tools/doctor";
import { fakeDriver } from "../fixtures/fake-driver";

const registry: Registry = {
  migrations: compileMigrations([
    ["20260101000001_a", "--up\nCREATE TABLE a (id integer PRIMARY KEY);\n--down\nDROP TABLE a;\n"],
    ["20260101000002_b", "--up\nCREATE TABLE b (id integer PRIMARY KEY);\n--down\nDROP TABLE b;\n"],
  ]),
  seeds: [],
};
const SETTINGS = "statement_timeout=5000,lock_timeout=1000,client_connection_check_interval=1000";

let port = 8000;
let runtimePid = 1000;
type Options = { broken?: boolean; pooled?: boolean; schemaMissing?: boolean; applied?: number; drift?: boolean; timeouts?: string; consoleMode?: string; replicaInRecovery?: boolean; replicaLag?: number };
/** Doctor yalnızca okur: SELECT/SHOW dışındaki her deyim testi düşürür. */
function fixture(options: Options = {}, replicas: string[] = []) {
  const fake = fakeDriver((text, _params, pool) => {
    if (!/^\s*(SELECT|SHOW)\b/.test(text)) throw new Error("Doctor must be read-only");
    if (options.broken) throw new Error(`credentials leaked: ${pool.url}`);
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/1" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: options.replicaInRecovery ?? true, caught_up: false, lag_ms: options.replicaLag ?? 10 }];
    if (text.includes("pg_backend_pid")) {
      if (pool.url.includes("pooler.example")) return [{ pid: 7 }];
      if (pool.url.includes("direct.example")) return [{ pid: ++runtimePid }];
      return [{ pid: options.pooled ? 1 : 100 + pool.index }];
    }
    if (text.includes("set_config")) return [{}];
    if (text.includes("to_regclass")) return [{ exists: true }];
    if (text.includes("_migrations")) return registry.migrations.slice(0, options.applied ?? 2).map(({ id, checksum }) => ({ id, checksum: options.drift ? "edited" : checksum }));
    if (text.includes("pg_namespace")) return [{ exists: !options.schemaMissing }];
    if (text.includes("standard_conforming_strings")) return [{ on: true }];
    if (text.includes("pg_db_role_setting")) return [{ settings: options.timeouts ?? SETTINGS }];
    if (text === "SHOW CONFIG") return [{ key: "unset_option", value: null }, { key: "pool_mode", value: options.consoleMode ?? "transaction" }];
    throw new Error("Unexpected diagnostic query");
  });
  const m = createManagement(createConfig(`postgres://admin:private-secret@localhost:${port++}/app`, replicas), { driver: fake.driver });
  return { m, fake };
}
const byName = (report: Awaited<ReturnType<typeof doctor>>, check: string) => report.checks.find((entry) => entry.check === check);

test("a healthy database passes every check and reports only what SQL cannot prove as unverified", async () => {
  const { m } = fixture();
  const report = await doctor(m, { registry });
  expect(report.ok).toBe(true);
  expect(report.checks.map((c) => [c.target, c.check])).toEqual([
    ["database", "direct_connection"], ["database", "string_literals"], ["database", "runtime_timeouts"], ["database", "schema"], ["database", "migrations"],
  ]);
  expect(report.externalChecks.map((c) => c.check)).toContain("pooled_runtime");
  expect(report.externalChecks.every((c) => c.status === "unverified")).toBe(true);
  await m.close();
});

test("pending migrations, drift, a missing schema, missing timeouts and a pooler in front of management each fail their own check", async () => {
  for (const [options, check] of [
    [{ applied: 1 }, "migrations"],
    [{ drift: true }, "migrations"],
    [{ schemaMissing: true }, "schema"],
    [{ timeouts: "statement_timeout=1" }, "runtime_timeouts"],
    [{ pooled: true }, "direct_connection"],
  ] as const) {
    const { m } = fixture(options);
    const report = await doctor(m, { registry });
    expect(report.ok, check).toBe(false);
    expect(byName(report, check)?.ok, check).toBe(false);
    await m.close();
  }
  const { m } = fixture({ applied: 1 });
  expect(byName(await doctor(m, { registry }), "migrations")?.detail).toContain("20260101000002_b");
  await m.close();
});

test("a failing inspection becomes a check carrying only the error code, never the driver message", async () => {
  const { m } = fixture({ broken: true });
  const report = await doctor(m, { registry });
  expect(report.ok).toBe(false);
  const text = JSON.stringify(report);
  expect(text).toContain("inspection");
  expect(text).not.toContain("credentials leaked");
  expect(text).not.toContain("private-secret");
  await m.close();
});

test("--pooled-url proves a transaction pooler or a direct URL and removes the generic pooled_runtime note", async () => {
  const pooled = await doctor(fixture().m, { registry, pooledUrl: "postgres://u:p@pooler.example/app" });
  expect(byName(pooled, "pooled_runtime")?.ok).toBe(true);
  expect(pooled.externalChecks.map((c) => c.check)).not.toContain("pooled_runtime");
  const direct = await doctor(fixture().m, { registry, pooledUrl: "postgres://u:p@direct.example/app" });
  expect(byName(direct, "pooled_runtime")?.ok).toBe(false);
  expect(direct.ok).toBe(false);
});

test("each replica gets its own targeted checks; a URL that is not a replica fails replica_in_recovery; no URL leaks", async () => {
  const replica = "postgres://admin:replica-secret@replica.example:5432/app";
  const healthy = fixture({}, [replica]);
  const report = await doctor(healthy.m, { registry });
  const mine = report.checks.filter((c) => c.target === "replica#1").map((c) => c.check);
  expect(mine).toEqual(["replica_reachable", "replica_in_recovery", "replica_lag", "replica_runtime_timeouts"]);
  expect(report.ok).toBe(true);
  expect(JSON.stringify(report)).not.toContain("replica-secret");
  const primary = fixture({ replicaInRecovery: false }, [replica]);
  const bad = await doctor(primary.m, { registry });
  expect(bad.checks.find((c) => c.target === "replica#1" && c.check === "replica_in_recovery")?.ok).toBe(false);
  expect(bad.ok).toBe(false);
  const lagging = fixture({ replicaLag: 999_999 }, [replica]);
  expect((await doctor(lagging.m, { registry })).checks.find((c) => c.check === "replica_lag")?.ok).toBe(false);
});

test("the PgBouncer console URL must be postgres://…/pgbouncer; the global pool mode must be transaction", async () => {
  const { m } = fixture();
  const consoleDriver = fakeDriver((text) => (text === "SHOW CONFIG" ? [{ key: "pool_mode", value: "session" }] : [])).driver;
  const wrongMode = await doctor(m, { registry, pgbouncerUrl: "postgres://admin:pw@127.0.0.1:6432/pgbouncer", consoleDriver });
  expect(byName(wrongMode, "global_pool_mode")?.ok).toBe(false);
  const badUrl = await doctor(m, { registry, pgbouncerUrl: "postgres://admin:pw@127.0.0.1:6432/app", consoleDriver });
  expect(byName(badUrl, "inspection")).toMatchObject({ target: "pgbouncer", ok: false });
  expect(JSON.stringify(badUrl)).not.toContain("pw@");
  await m.close();
});
