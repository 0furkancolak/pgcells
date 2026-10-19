import { expect, test } from "bun:test";
import { createWithTenant, createWithTenantRead } from "../../core/tenants/context";
import { prepareQuery } from "../../core/sql/compiler";
import { tenantSchema } from "../../core/tenants/model";

const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const update = prepareQuery("UPDATE students SET name = $1::text WHERE id = $2::uuid");
const placement = {
  tenantId: "demo-tenant",
  kind: "tenant" as const,
  databaseId: "one",
  schemaName: tenantSchema("demo-tenant"),
  status: "active" as const,
  schemaVersion: 3,
  placementVersion: 1,
};

/** Recording fake pool: `query` and `transaction(mode)`. */
function recorder(fail?: { code: string }) {
  const log: { text: string; tenantId?: string }[] = [];
  const modes: (string | undefined)[] = [];
  const db = {
    query: async (text: string, _params?: readonly unknown[], tenantId?: string) => {
      log.push({ text, tenantId });
      if (fail) throw Object.assign(new Error("boom"), fail);
      return [];
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>, options?: { mode?: string }) => {
      modes.push(options?.mode);
      return work(db);
    },
  };
  return { db, log, modes };
}

function fixture(options: { replica?: ReturnType<typeof recorder> | undefined; policy?: "primary" | "error" } = {}) {
  const primary = recorder();
  const downs: number[] = [];
  const router = { pick: async () => (options.replica ? { db: options.replica.db as never, markDown: () => void downs.push(1) } : undefined) };
  const pools = { node: () => primary.db } as never;
  const placements = { get: async () => placement };
  return {
    primary,
    downs,
    withTenantRead: createWithTenantRead(pools, placements, router, options.policy ?? "primary"),
    withTenant: createWithTenant(pools, placements),
  };
}

test("a read-only query runs on the picked replica, bound to the tenant schema, and never touches the primary", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  await f.withTenantRead("demo-tenant", (db) => db.query(select, ["id"]));
  expect(replica.log).toHaveLength(1);
  expect(replica.log[0]?.text).toContain(`"${placement.schemaName}"`);
  expect(replica.log[0]?.tenantId).toBe("demo-tenant");
  expect(f.primary.log).toHaveLength(0);
  expect(f.primary.modes).toHaveLength(0);
});

test("a query that is not read-only is rejected before any database is touched", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  const error = (await f.withTenantRead("demo-tenant", async (db) => db.query(update, ["x", "id"])).catch((e: unknown) => e)) as { code: string };
  expect(error).toMatchObject({ code: "QUERY_NOT_READ_ONLY" });
  expect(replica.log).toHaveLength(0);
  expect(f.primary.log).toHaveLength(0);
});

test("with no usable replica the primary policy runs each query in a READ ONLY transaction", async () => {
  const f = fixture();
  await f.withTenantRead("demo-tenant", (db) => db.query(select, ["id"]));
  expect(f.primary.modes).toEqual([" READ ONLY"]);
  expect(f.primary.log).toHaveLength(1);
});

test("the error policy raises REPLICA_UNAVAILABLE without touching any database, also when no replica is configured", async () => {
  const f = fixture({ policy: "error" });
  const error = (await f.withTenantRead("demo-tenant", async (db) => db.query(select, ["id"])).catch((e: unknown) => e)) as { code: string; message: string };
  expect(error).toMatchObject({ code: "REPLICA_UNAVAILABLE" });
  expect(error.message).not.toContain("postgres://");
  expect(f.primary.log).toHaveLength(0);
});

test("after a write in the same request the read goes to the primary even under the error policy", async () => {
  const replica = recorder();
  const f = fixture({ replica, policy: "error" });
  await f.withTenantRead.forPlacement(placement, (db) => db.query(select, ["id"]), true);
  expect(replica.log).toHaveLength(0);
  expect(f.primary.modes).toEqual([" READ ONLY"]);
});

test("a connection error marks the replica down; a SQL error does not; both surface", async () => {
  const dead = recorder({ code: "ECONNRESET" });
  const f = fixture({ replica: dead });
  expect(await f.withTenantRead("demo-tenant", (db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("ECONNRESET");
  expect(f.downs).toHaveLength(1);
  const timeout = recorder({ code: "57014" });
  const g = fixture({ replica: timeout });
  expect(await g.withTenantRead("demo-tenant", (db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("57014");
  expect(g.downs).toHaveLength(0);
});

test("only tenant-scope queries run and the context expires after the work", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  const nodeQuery = prepareQuery("SELECT 1", "node");
  expect(await f.withTenantRead("demo-tenant", async (db) => db.query(nodeQuery)).catch((e: unknown) => (e as { code: string }).code)).toBe("QUERY_SCOPE");
  let escaped!: { query: (...args: never[]) => unknown };
  await f.withTenantRead("demo-tenant", async (db) => void (escaped = db as never));
  expect(() => escaped.query(select as never)).toThrow(expect.objectContaining({ code: "TRANSACTION_CLOSED" }));
});

test("onWrite fires for writes (also inside transactions) and not for reads", async () => {
  const f = fixture();
  let writes = 0;
  const onWrite = () => void writes++;
  await f.withTenant.forPlacement(placement, (db) => db.query(select, ["id"]), onWrite);
  expect(writes).toBe(0);
  await f.withTenant.forPlacement(placement, (db) => db.transaction((tx) => tx.query(select, ["id"])), onWrite);
  expect(writes).toBe(0);
  await f.withTenant.forPlacement(placement, (db) => db.query(update, ["x", "id"]), onWrite);
  expect(writes).toBe(1);
  await f.withTenant.forPlacement(placement, (db) => db.transaction((tx) => tx.query(update, ["x", "id"])), onWrite);
  expect(writes).toBe(2);
});
