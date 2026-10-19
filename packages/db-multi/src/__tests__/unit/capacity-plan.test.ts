import { expect, test } from "bun:test";
import { capacityPlan } from "../../core/tools/capacity-plan";

/** The worked example of docs/guides/capacity.md: the guide and this test must keep the same numbers. */
const million = { targetRps: 1_000_000, readShare: 0.8, perProcessRps: 15_000, perCellRps: 20_000, utilization: 0.6, tenants: 20_000, tenantsPerCell: 1500 };

test("the guide's worked example: one million statements per second", () => {
  const plan = capacityPlan(million);
  expect(plan).toMatchObject({
    appInstances: 112,
    cells: 17,
    replicasPerCell: 4,
    postgresServers: 85,
    writeRps: 200_000,
    readRps: 800_000,
    limitedBy: "writes",
  });
  expect(plan.perCell).toEqual({ writeRps: 11_765, readRps: 47_059, tenants: 1176 });
});

test("without replicas every statement lands on the primaries", () => {
  const plan = capacityPlan({ ...million, readShare: 0.8, replicasAllowed: false });
  expect(plan.replicasPerCell).toBe(0);
  expect(plan.cells).toBe(Math.ceil(1_000_000 / (20_000 * 0.6)));
  expect(plan.limitedBy).toBe("statements");
});

test("tenant count can be what sizes the fleet", () => {
  const plan = capacityPlan({ ...million, targetRps: 10_000, tenants: 50_000 });
  expect(plan.cells).toBe(34);
  expect(plan.limitedBy).toBe("tenants");
});

test("more replicas than a node can have (8) means more cells instead", () => {
  const plan = capacityPlan({ ...million, readShare: 0.99, perCellRps: 5_000, tenants: 100 });
  expect(plan.replicasPerCell).toBeLessThanOrEqual(8);
  expect(plan.notes.join(" ")).toContain("more cells");
});

test("a small deployment still needs at least two app instances and one cell", () => {
  const plan = capacityPlan({ targetRps: 50, readShare: 0, perProcessRps: 10_000, perCellRps: 9_000, utilization: 0.6 });
  expect(plan.appInstances).toBe(2);
  expect(plan.cells).toBe(1);
  expect(plan.replicasPerCell).toBe(0);
});

test("inputs must be positive and the utilization a fraction", () => {
  for (const bad of [{ targetRps: 0 }, { perProcessRps: -1 }, { perCellRps: Number.NaN }, { utilization: 0 }, { utilization: 1.5 }, { readShare: 1.2 }, { tenantsPerCell: 0 }])
    expect(() => capacityPlan({ ...million, ...bad })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
});
