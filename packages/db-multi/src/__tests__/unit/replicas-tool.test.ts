import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { replicaReport } from "../../core/tools/replicas";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://app:secret-pw@primary.example.com/app";
const REPLICA = "postgres://app:secret-pw@replica.example.com/app";

function open(handler: Parameters<typeof fakeDriver>[0], replicas: string | string[] = `db0=${REPLICA}`) {
  const fake = fakeDriver(handler);
  const app = createManagement(createConfig([PRIMARY], replicas), { driver: fake.driver });
  return { app, fake };
}
const healthy = (text: string) => {
  if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
  if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: false, lag_ms: 40 }];
  return [];
};

test("replicaReport lists each replica by number with its lag, and opens and closes its own pools", async () => {
  const { app, fake } = open(healthy);
  const opened = fake.pools.length; // yönetimin kendi platform havuzu `app.close()`'a kadar açık kalır
  const report = await replicaReport(app);
  expect(report).toEqual({
    ok: true,
    maxLagMs: 5000,
    replicas: [{ databaseId: "db0", replica: 1, up: true, inRecovery: true, lagMs: 40, usable: true }],
  });
  expect(fake.pools.length).toBeGreaterThan(opened);
  expect(fake.pools.slice(opened).every((pool) => pool.closed)).toBe(true);
  await app.close();
});

test("a lagging or unreachable replica makes ok false and never leaks URLs, hosts or passwords", async () => {
  const lagging = open((text) => (text.includes("pg_is_in_recovery") ? [{ in_recovery: true, caught_up: false, lag_ms: 90_000 }] : healthy(text)));
  expect((await replicaReport(lagging.app)).ok).toBe(false);
  const broken = open((text, _params, pool) => {
    if (pool.url.includes("replica.example.com")) throw Object.assign(new Error(`cannot reach ${pool.url} as secret-pw`), { code: "ECONNREFUSED" });
    return healthy(text);
  });
  const report = await replicaReport(broken.app);
  expect(report.ok).toBe(false);
  expect(report.replicas[0]).toMatchObject({ up: false, usable: false, error: "ECONNREFUSED" });
  const text = JSON.stringify(report);
  for (const secret of ["secret-pw", "replica.example.com", "primary.example.com", "postgres://"]) expect(text).not.toContain(secret);
});

test("no configured replicas is ok with an empty list", async () => {
  const { app } = open(healthy, []);
  expect(await replicaReport(app)).toMatchObject({ ok: true, replicas: [] });
});
