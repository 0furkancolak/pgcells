import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { nodeMigrations, platformMigrations } from "../../core/migrations/registry";
import { doctor } from "../../core/tools/doctor";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://admin:private-secret@primary.example.com/app";
const REPLICA = "postgres://admin:private-secret@replica.example.com/app";
const TIMEOUTS = "statement_timeout=5000,lock_timeout=1000,client_connection_check_interval=1000";
let pid = 1000;

type Replica = { inRecovery?: boolean; lagMs?: number; identity?: string; settings?: string; pooled?: boolean; fail?: boolean; regionRow?: { nodeRegion: string | null; region: string | null } };
function run(replica: Replica = {}) {
  const fake = fakeDriver((text, _params, pool) => {
    const onReplica = pool.url.includes("replica.example.com");
    if (!/^\s*(SELECT|SHOW)\b/.test(text)) throw new Error("Doctor must be read-only");
    if (onReplica && replica.fail) throw Object.assign(new Error(`unreachable ${pool.url}`), { code: "ECONNREFUSED" });
    if (text.includes("pg_backend_pid")) return [{ pid: onReplica ? (replica.pooled ? 7 : ++pid) : 100 + pool.index }]; // primary: a fixed pid per session (direct connection)
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: replica.inRecovery ?? true, caught_up: false, lag_ms: replica.lagMs ?? 30 }];
    if (text.includes("set_config")) return [{}];
    if (text.includes("_migrations")) return (text.includes("_node_") ? nodeMigrations : platformMigrations).map(({ id, checksum }) => ({ id, checksum }));
    if (text.includes("__moved_") || text.includes("platform.moves") || text.includes("information_schema.columns") || text.includes("region IS NOT NULL")) return [];
    if (text.includes("platform.replicas")) return [replica.regionRow ?? { nodeRegion: null, region: null }];
    if (text.includes("platform.nodes") || text.includes("node_identity")) return [{ database_id: onReplica ? (replica.identity ?? "db0") : "db0" }];
    if (text.includes("AS invalid")) return [{ invalid: 0, inactive: 0, moving: 0, recovery: 0 }];
    if (text.includes("standard_conforming_strings")) return [{ on: true }];
    if (text.includes("pg_db_role_setting")) return [{ settings: onReplica ? (replica.settings ?? TIMEOUTS) : TIMEOUTS }];
    throw new Error("Unexpected diagnostic query");
  });
  const app = createManagement(createConfig([PRIMARY], `db0=${REPLICA}`), { driver: fake.driver });
  return doctor(app).then(async (result) => {
    await app.close();
    expect(fake.pools.every((pool) => pool.closed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(JSON.stringify(result)).not.toContain("replica.example.com");
    return result;
  });
}
// `replica_region` is informational and covered by its own test below.
const replicaChecks = (result: Awaited<ReturnType<typeof run>>) => result.checks.filter((check) => check.target === "db0#1" && check.check !== "replica_region");
const outcome = (result: Awaited<ReturnType<typeof run>>) => Object.fromEntries(replicaChecks(result).map((check) => [check.check, check.ok]));

test("a healthy direct replica passes every check, so a valid configuration keeps doctor ok", async () => {
  const healthy = await run();
  expect(healthy.checks.filter((check) => !check.ok)).toEqual([]);
  expect(healthy.ok).toBe(true);
  expect(outcome(healthy)).toEqual({
    replica_reachable: true,
    replica_in_recovery: true,
    replica_lag: true,
    replica_identity: true,
    replica_runtime_timeouts: true,
    replica_pooled: true, // informational only: a direct URL does not make doctor fail
  });
});

test("a primary given as replica, a lagging replica, another cluster and missing timeouts each fail their own check", async () => {
  expect((await run({ inRecovery: false }).then(outcome)).replica_in_recovery).toBe(false);
  expect((await run({ lagMs: 60_000 }).then(outcome)).replica_lag).toBe(false);
  expect((await run({ identity: "db1" }).then(outcome)).replica_identity).toBe(false);
  expect((await run({ settings: "statement_timeout=1" }).then(outcome)).replica_runtime_timeouts).toBe(false);
  expect((await run({ pooled: true }).then(outcome)).replica_pooled).toBe(true);
  // Informational check: the direct and the pooled URL are reported under the same check name but with different detail.
  const detail = async (replica: Replica) => replicaChecks(await run(replica)).find((check) => check.check === "replica_pooled")?.detail;
  expect(await detail({ pooled: true })).toContain("goes to a transaction-mode pooler");
  expect(await detail({})).toContain("does not go to a transaction-mode pooler");
});

test("an unreachable replica fails replica_reachable and skips the rest, without leaking the URL", async () => {
  const result = await run({ fail: true });
  expect(outcome(result)).toEqual({ replica_reachable: false });
  expect(result.ok).toBe(false);
});

test("a configuration without replicas adds no replica checks", async () => {
  const fake = fakeDriver((text) => (text.includes("pg_backend_pid") ? [{ pid: 1 }] : []));
  const app = createManagement(createConfig([PRIMARY]), { driver: fake.driver });
  const result = await doctor(app);
  expect(result.checks.some((check) => check.check.startsWith("replica_"))).toBe(false);
  await app.close();
});

test("replica_region is informational: the directory row, else the database's region, with a warning when they differ", async () => {
  const detail = async (regionRow: { nodeRegion: string | null; region: string | null }) =>
    (await run({ regionRow })).checks.find((check) => check.check === "replica_region");
  expect(await detail({ nodeRegion: "eu-west", region: null })).toMatchObject({ target: "db0#1", ok: true, detail: "Replica region: eu-west (its database's region)." });
  expect(await detail({ nodeRegion: "eu-west", region: "eu-west" })).toMatchObject({ ok: true, detail: "Replica region: eu-west (from the directory)." });
  const mixed = await detail({ nodeRegion: "eu-west", region: "us-east" });
  expect(mixed).toMatchObject({ ok: true, detail: expect.stringContaining("Warning: its database is in eu-west") });
  expect(await detail({ nodeRegion: null, region: null })).toMatchObject({ ok: true, detail: "No region is recorded for this replica or its database." });
});
