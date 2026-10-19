import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../core/management";
import { replicaReport } from "../../core/tools/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

const REPLICA = "postgres://admin:replica-secret@replica.example:5432/app";
const handler = (lag: number) => (text: string) =>
  text.includes("pg_current_wal_lsn") ? [{ lsn: "0/1" }] : text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: false, lag_ms: lag }] : [];

test("the report lists each replica's health and lag with no URL, and ok is false when one is unusable", async () => {
  const fine = fakeDriver(handler(10));
  const m = createManagement(createConfig("postgres://admin:p@primary.example/app", [REPLICA]), { driver: fine.driver });
  const report = await replicaReport(m);
  expect(report).toMatchObject({ ok: true, maxLagMs: 5000, replicas: [{ replica: 1, up: true, lagMs: 10, usable: true }] });
  expect(JSON.stringify(report)).not.toContain("replica-secret");
  const lagging = fakeDriver(handler(999_999));
  const slow = await replicaReport(createManagement(createConfig("postgres://admin:p@primary.example/app", [REPLICA]), { driver: lagging.driver }));
  expect(slow.ok).toBe(false);
});

test("the short-lived runtime it opens is closed again; the management pool is left alone", async () => {
  const fake = fakeDriver(handler(10));
  const m = createManagement(createConfig("postgres://admin:p@primary.example/app", [REPLICA]), { driver: fake.driver });
  await replicaReport(m);
  expect(fake.pools.slice(1).every((pool) => pool.closed)).toBe(true);
  expect(fake.pools[0]?.closed).toBe(false);
  await m.close();
});

test("with no replica configured the report is empty and ok", async () => {
  const fake = fakeDriver();
  const m = createManagement(createConfig("postgres://admin:p@primary.example/app"), { driver: fake.driver });
  expect(await replicaReport(m)).toEqual({ ok: true, maxLagMs: 5000, replicas: [] });
});
