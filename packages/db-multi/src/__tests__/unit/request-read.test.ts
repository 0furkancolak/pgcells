import { expect, test } from "bun:test";
import { createWithTenant, createWithTenantRead } from "../../core/tenants/context";
import { prepareQuery } from "../../core/sql/compiler";
import { tenantSchema } from "../../core/tenants/model";
import { createDbScope } from "../../middleware";

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

function scope() {
  const primary: string[] = [];
  const replica: string[] = [];
  const make = (log: string[]) => {
    const db = {
      query: async (text: string) => {
        log.push(text);
        return [];
      },
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    };
    return db;
  };
  const primaryDb = make(primary);
  const replicaDb = make(replica);
  const pools = { node: () => primaryDb } as never;
  const placements = { get: async () => placement };
  const router = { pick: async () => ({ db: replicaDb as never, markDown: () => {} }) };
  const db = {
    placement: () => placement,
    withTenant: createWithTenant(pools, placements),
    withTenantRead: createWithTenantRead(pools, placements, router, "primary"),
  };
  return { request: createDbScope(db as never, "demo-tenant"), primary, replica };
}

test("tenantRead reads from the replica until the request writes, then stays on the primary", async () => {
  const { request, primary, replica } = scope();
  await request.tenantRead.query(select, ["id"]);
  expect([replica.length, primary.length]).toEqual([1, 0]);
  await request.tenant.query(select, ["id"]); // a read does not count as a write
  await request.tenantRead.query(select, ["id"]);
  expect(replica).toHaveLength(2);
  await request.tenant.query(update, ["x", "id"]);
  await request.tenantRead.query(select, ["id"]);
  expect(replica).toHaveLength(2);
  expect(primary.filter((text) => text.startsWith("SELECT"))).toHaveLength(2); // select (tenant) + select (tenantRead, primary'de)
});

test("a write inside a transaction also pins later reads to the primary; a read-only transaction does not", async () => {
  const a = scope();
  await a.request.tenant.transaction((tx) => tx.query(select, ["id"]));
  await a.request.tenantRead.query(select, ["id"]);
  expect(a.replica).toHaveLength(1);
  const b = scope();
  await b.request.tenant.transaction((tx) => tx.query(update, ["x", "id"]));
  await b.request.tenantRead.query(select, ["id"]);
  expect(b.replica).toHaveLength(0);
});

test("scopes do not share write state and tenantRead exposes only query", async () => {
  const a = scope();
  const b = scope();
  await a.request.tenant.query(update, ["x", "id"]);
  await b.request.tenantRead.query(select, ["id"]);
  expect(b.replica).toHaveLength(1);
  expect(Object.keys(a.request.tenantRead)).toEqual(["query"]);
});

/** A fake with two replicas: `pick` hands out one in turn; `fail` fails that replica's query with a connection error. */
function twoReplicas(options: { failFirst?: boolean } = {}) {
  const logs: string[][] = [[], []];
  let failFirst = options.failFirst ?? false;
  const dbs = logs.map((log, index) => {
    const db = {
      query: async (text: string) => {
        log.push(text);
        if (index === 0 && failFirst) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
        return [];
      },
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    };
    return db;
  });
  let turn = 0;
  const router = { pick: async () => ({ db: dbs[turn++ % 2] as never, markDown: () => {} }) };
  const pools = { node: () => dbs[0] } as never;
  const placements = { get: async () => placement };
  const db = {
    placement: () => placement,
    withTenant: createWithTenant(pools, placements),
    withTenantRead: createWithTenantRead(pools, placements, router, "primary"),
  };
  return { request: createDbScope(db as never, "demo-tenant"), logs, heal: () => void (failFirst = false) };
}

test("reads in one request scope stay on the replica the first read picked", async () => {
  const { request, logs } = twoReplicas();
  await request.tenantRead.query(select, ["id"]);
  await request.tenantRead.query(select, ["id"]);
  await request.tenantRead.query(select, ["id"]);
  expect(logs.map((log) => log.length)).toEqual([3, 0]);
  const other = twoReplicas();
  await other.request.tenantRead.query(select, ["id"]);
  await other.request.tenantRead.query(select, ["id"]);
  expect(other.logs.map((log) => log.length)).toEqual([2, 0]);
});

test("after the pinned replica fails with a connection error the next read picks again", async () => {
  const { request, logs, heal } = twoReplicas({ failFirst: true });
  expect(await request.tenantRead.query(select, ["id"]).catch((e: unknown) => (e as { code: string }).code)).toBe("ECONNRESET");
  heal();
  await request.tenantRead.query(select, ["id"]);
  expect(logs.map((log) => log.length)).toEqual([1, 1]); // the second read re-picked: the other replica
});
