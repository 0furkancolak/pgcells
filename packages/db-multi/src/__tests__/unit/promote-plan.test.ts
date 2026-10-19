import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { promotePlan } from "../../core/tools/promote";
import { fakeDriver } from "../fixtures/fake-driver";

const PRIMARY = "postgres://admin:private-secret@primary.example.com/app";
const REPLICA = "postgres://admin:private-secret@replica.example.com/app";
const TIMEOUTS = "statement_timeout=5000,lock_timeout=1000,client_connection_check_interval=1000";

type Setup = { primaryDown?: boolean; replicaDown?: boolean; inRecovery?: boolean; lagMs?: number; identity?: string; settings?: string };
function open(setup: Setup = {}) {
  const fake = fakeDriver((text, _params, pool) => {
    const onReplica = pool.url.includes("replica.example.com");
    if (!/^\s*(SELECT|SHOW)\b/.test(text)) throw new Error("promote plan must be read-only");
    if (onReplica ? setup.replicaDown : setup.primaryDown) throw Object.assign(new Error(`unreachable ${pool.url}`), { code: "ECONNREFUSED" });
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: setup.inRecovery ?? true, caught_up: setup.lagMs === 0, lag_ms: setup.lagMs ?? 30 }];
    if (text.includes("node_identity")) return [{ database_id: setup.identity ?? "db0" }];
    if (text.includes("pg_db_role_setting")) return [{ settings: setup.settings ?? TIMEOUTS }];
    return [];
  });
  const app = createManagement(createConfig([PRIMARY], `db0=${REPLICA}`), { driver: fake.driver });
  return { app, fake };
}
const byName = (plan: Awaited<ReturnType<typeof promotePlan>>) => Object.fromEntries(plan.checks.map((check) => [check.check, check.ok]));

test("a healthy, caught-up replica of a reachable primary is a planned switchover with the steps in order", async () => {
  const { app, fake } = open({ lagMs: 0 });
  const plan = await promotePlan(app, "db0", 1);
  expect(plan.ok).toBe(true);
  expect(plan.mode).toBe("switchover");
  expect(byName(plan)).toEqual({ replica_reachable: true, replica_in_recovery: true, replica_identity: true, replica_lag: true, replica_runtime_timeouts: true, primary_reachable: true });
  expect(plan.steps.join("\n")).toMatch(/drain|stop/i);
  expect(plan.steps.join("\n")).toContain("DATABASE_URLS");
  expect(plan.steps.join("\n")).toContain("doctor");
  expect(JSON.stringify(plan)).not.toContain("private-secret");
  expect(JSON.stringify(plan)).not.toContain("replica.example.com");
  expect(fake.pools.every((pool) => pool.closed || pool.url === PRIMARY)).toBe(true);
  await app.close();
});

test("an unreachable primary makes it a failover, with a warning to fence the old primary", async () => {
  const { app } = open({ primaryDown: true });
  const plan = await promotePlan(app, "db0", 1);
  expect(plan.mode).toBe("failover");
  expect(plan.checks.find((check) => check.check === "primary_reachable")?.ok).toBe(false);
  expect(plan.steps.join("\n")).toMatch(/fence|isolate|cannot come back/i);
  await app.close();
});

test("each blocking problem makes the plan not ok: down, already a primary, another cluster's data, lag, missing timeouts", async () => {
  expect(byName(await promotePlan(open({ replicaDown: true }).app, "db0", 1)).replica_reachable).toBe(false);
  const primary = await promotePlan(open({ inRecovery: false }).app, "db0", 1);
  expect(primary.ok).toBe(false);
  expect(byName(primary).replica_in_recovery).toBe(false);
  expect((await promotePlan(open({ identity: "db1" }).app, "db0", 1)).ok).toBe(false);
  expect(byName(await promotePlan(open({ lagMs: 60_000 }).app, "db0", 1)).replica_lag).toBe(false);
  expect(byName(await promotePlan(open({ settings: "statement_timeout=0" }).app, "db0", 1)).replica_runtime_timeouts).toBe(false);
});

test("the replica must exist: an unknown ordinal or a database without replicas is refused", async () => {
  const { app } = open();
  await expect(promotePlan(app, "db0", 2)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await expect(promotePlan(app, "db0", 0)).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await expect(promotePlan(app, "db5", 1)).rejects.toMatchObject({ code: "DATABASE_NOT_FOUND" });
  await app.close();
});
