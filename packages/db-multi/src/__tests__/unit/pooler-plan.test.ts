import { expect, test } from "bun:test";
import { connectionBudget } from "../../core/tools/pooler-plan";

/** The worked example of docs/guides/connections.md (section 3): the guide and this test must keep the same numbers. */
const workedExample = { appInstances: 40, poolMax: 5, poolers: 2, defaultPoolSize: 20, maxClientConn: 1000, maxConnections: 200, rps: 5000, latencyMs: 2 };

test("the guide's worked example produces the guide's numbers", () => {
  const plan = connectionBudget(workedExample);
  expect(plan.ok).toBe(true);
  expect(plan.violations).toEqual([]);
  expect(plan.clients).toEqual({ load: 200, limit: 1000 });
  expect(plan.servers).toEqual({ load: 64, limit: 177, application: 40, management: 4, maintenance: 20 });
  expect(plan.flow).toEqual({ needed: 10, available: 40, ceilingRps: 20000 });
});

test("replicas multiply client connections, because each replica has its own pool in the same pooler", () => {
  expect(connectionBudget({ ...workedExample, replicasPerNode: 2 }).clients.load).toBe(600);
});

test("every pooler instance counts toward server connections, and each distinct db/user pair has its own server pool", () => {
  const plan = connectionBudget({ ...workedExample, poolers: 4, distinctDbUsers: 2 });
  expect(plan.servers.application).toBe(160);
  expect(plan.servers.load).toBe(184);
});

test("each violated inequality is reported on its own, and the plan is not ok", () => {
  const clients = connectionBudget({ ...workedExample, appInstances: 400 });
  expect(clients.ok).toBe(false);
  expect(clients.violations).toEqual([expect.stringContaining("client connections")]);

  const servers = connectionBudget({ ...workedExample, maxConnections: 60 });
  expect(servers.violations).toEqual([expect.stringContaining("server connections")]);

  const flow = connectionBudget({ ...workedExample, rps: 50_000 });
  expect(flow.violations).toEqual([expect.stringContaining("concurrent statements")]);
  expect(flow.flow?.needed).toBe(100);
});

test("the boundary is inclusive: exactly at the limit passes, one over fails", () => {
  // clients limit = 1000 × 2 × 0.5 ... per the guide it is maxClientConn × poolers × 0.5 = 1000
  expect(connectionBudget({ ...workedExample, appInstances: 200 }).clients).toEqual({ load: 1000, limit: 1000 });
  expect(connectionBudget({ ...workedExample, appInstances: 200 }).ok).toBe(true);
  expect(connectionBudget({ ...workedExample, appInstances: 201 }).ok).toBe(false);
});

test("the flow inequality is only evaluated when both rps and latency are given", () => {
  const { rps: _rps, ...withoutRps } = workedExample;
  expect(connectionBudget(withoutRps).flow).toBeUndefined();
  expect(connectionBudget({ ...workedExample, latencyMs: undefined }).flow).toBeUndefined();
});

test("inputs must be positive integers (zero latency is a division by zero, not infinite capacity)", () => {
  for (const bad of [{ appInstances: 0 }, { poolMax: -1 }, { poolers: 1.5 }, { latencyMs: 0 }, { rps: Number.NaN }])
    expect(() => connectionBudget({ ...workedExample, ...bad })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(() => connectionBudget({ ...workedExample, maxConnections: 3 })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
