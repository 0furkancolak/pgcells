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
  const opened = fake.pools.length; // the management's own platform pool stays open until `app.close()`
  const report = await replicaReport(app);
  expect(report).toEqual({
    ok: true,
    maxLagMs: 5000,
    replicas: [{ databaseId: "db0", replica: 1, up: true, inRecovery: true, lagMs: 40, usable: true, region: null }],
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

test("the report says where each replica lives: its own row, else its node's region", async () => {
  const { app } = open(
    (text) => (text.includes("platform.replicas") ? [{ databaseId: "db0", nodeRegion: "eu-west", ordinal: 2, region: "us-east" }] : healthy(text)),
    [`db0=${REPLICA}`, `db0=postgres://app:secret-pw@replica2.example.com/app`],
  );
  const report = await replicaReport(app);
  expect(report.replicas.map((replica) => [replica.replica, replica.region])).toEqual([[1, "eu-west"], [2, "us-east"]]);
  await app.close();
});

test("setReplicaRegion validates the address and the replica count, and writes or removes the row", async () => {
  const written: unknown[][] = [];
  const { app } = open((text, params) => {
    if (text.startsWith("INSERT INTO platform.replicas") || text.startsWith("DELETE FROM platform.replicas")) written.push([text.split(" ")[0], ...params]);
    return text.startsWith("INSERT") ? [{ region: params[2] }] : [];
  });
  const { setReplicaRegion } = await import("../../core/tools/replicas");
  expect(await setReplicaRegion(app, "db0#1", "eu-west")).toEqual({ replica: "db0#1", region: "eu-west" });
  expect(await setReplicaRegion(app, "db0#1", "none")).toEqual({ replica: "db0#1", region: null });
  expect(written).toEqual([["INSERT", "db0", 1, "eu-west"], ["DELETE", "db0", 1]]);
  for (const [address, code] of [["db0", "USAGE"], ["db0#9", "USAGE"], ["db0#2", "INVALID_CONFIG"], ["db5#1", "DATABASE_NOT_FOUND"]] as const)
    await expect(setReplicaRegion(app, address, "eu-west")).rejects.toMatchObject({ code });
  await expect(setReplicaRegion(app, "db0#1", "EU West")).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await app.close();
});

test("no configured replicas is ok with an empty list", async () => {
  const { app } = open(healthy, []);
  expect(await replicaReport(app)).toMatchObject({ ok: true, replicas: [] });
});
