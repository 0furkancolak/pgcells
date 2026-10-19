import { describe, expect, test } from "bun:test";
import {
  nodeMigrations,
  pendingMigrations,
  platformMigrations,
  tenantMigrations,
} from "../../core/migrations/registry";

const history = (registry: typeof tenantMigrations) =>
  registry.map((m) => ({ id: m.id, checksum: m.checksum }));

describe("migration planner", () => {
  test("one immutable definition serves every tenant", () => {
    expect(pendingMigrations([], tenantMigrations).map((m) => m.id)).toEqual(
      tenantMigrations.map((m) => m.id),
    );
    const first = tenantMigrations[0];
    if (!first) throw new Error("Missing first migration");
    expect(
      pendingMigrations(
        [{ id: first.id, checksum: first.checksum }],
        tenantMigrations,
      ).length,
    ).toBe(tenantMigrations.length - 1);
  });
  test("rejects checksum drift and unknown history instead of silently migrating", () => {
    expect(() =>
      pendingMigrations(
        [{ id: "20260901083015_initial", checksum: "modified" }],
        tenantMigrations,
      ),
    ).toThrow();
    expect(() =>
      pendingMigrations(
        [{ id: "20990101083015_unknown", checksum: "x" }],
        tenantMigrations,
      ),
    ).toThrow();
  });
  test("rejects holes in applied history", () => {
    const second = tenantMigrations[1];
    if (!second) throw new Error("Missing second migration");
    expect(() =>
      pendingMigrations(
        [{ id: second.id, checksum: second.checksum }],
        tenantMigrations,
      ),
    ).toThrow();
  });
});

test("SQL migrations detect edited sources and bind per tenant schema", () => {
  const applied = history(tenantMigrations);
  expect(pendingMigrations(applied, tenantMigrations)).toHaveLength(0);
  const changed = tenantMigrations.map((m) => ({
    ...m,
    checksum: "changed-source",
  }));
  expect(() => pendingMigrations(applied, changed)).toThrow(
    "modified migration",
  );
  expect(
    tenantMigrations[0]?.up
      .bind("tenant_a1111111111111111111111111111111")
      .join("\n"),
  ).toContain('"tenant_a1111111111111111111111111111111"');
  expect(
    tenantMigrations[0]?.up
      .bind("tenant_b2222222222222222222222222222222")
      .join("\n"),
  ).not.toContain('"tenant_a1111111111111111111111111111111"');
});

test("platform registries are transactional, bind to platform and share drift rules", () => {
  for (const registry of [platformMigrations, nodeMigrations]) {
    expect(registry.every((m) => !m.concurrentIndex && !m.concurrentDrop)).toBe(true);
    expect(pendingMigrations(history(registry), registry)).toHaveLength(0);
    expect(() =>
      pendingMigrations([{ id: "20260915155443_platform", checksum: "x" }], registry),
    ).toThrow("modified migration");
    expect(() =>
      pendingMigrations(
        [...history(registry), { id: "20990101083015_unknown", checksum: "x" }],
        registry,
      ),
    ).toThrow("Unknown");
  }
  const control = platformMigrations[0]?.up.bind("platform").join("\n");
  expect(control).toContain('CREATE TABLE "platform".placements');
  expect(control).toContain('REFERENCES "platform".tenants');
  expect(control).toContain('tenant_id COLLATE "pg_catalog"."C"');
  expect(() => platformMigrations[0]?.up.bind("public")).toThrow(
    "invalid tenant schema",
  );
});
