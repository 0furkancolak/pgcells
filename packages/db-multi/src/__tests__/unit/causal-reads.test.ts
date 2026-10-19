/** Causal reads: a read that carries a write token waits (bounded) for the replica to replay it, and otherwise goes to the primary. */
import { expect, test } from "bun:test";
import { createWithTenantRead } from "../../core/tenants/context";
import { prepareQuery } from "../../core/sql/compiler";
import { tenantSchema } from "../../core/tenants/model";

const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const placement = {
  tenantId: "demo-tenant",
  kind: "tenant" as const,
  databaseId: "one",
  schemaName: tenantSchema("demo-tenant"),
  status: "active" as const,
  schemaVersion: 3,
  placementVersion: 1,
};

/** A database whose replay position can be changed: the replica answers the replay check from `replayed`. */
function node(role: "primary" | "replica", state: { replayed: () => boolean; fail?: { code: string } } = { replayed: () => true }) {
  const log: string[] = [];
  const db = {
    query: async (text: string, params?: readonly unknown[]) => {
      log.push(text);
      if (state.fail) throw Object.assign(new Error("boom"), state.fail);
      if (text.includes("pg_last_wal_replay_lsn")) {
        log.push(`token=${String(params?.[0])}`);
        return [{ ok: state.replayed() }];
      }
      return [];
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return { db, log, role, reads: () => log.filter((text) => text.includes("students")).length, checks: () => log.filter((text) => text.includes("pg_last_wal_replay_lsn")).length };
}

function fixture(replica: ReturnType<typeof node> | undefined, options: { policy?: "primary" | "error"; causalWaitMs?: number } = {}) {
  const primary = node("primary");
  const downs: number[] = [];
  const router = { pick: async () => (replica ? { db: replica.db as never, markDown: () => void downs.push(1) } : undefined) };
  const withTenantRead = createWithTenantRead({ node: () => primary.db } as never, { get: async () => placement }, router, options.policy ?? "primary", undefined, undefined, options.causalWaitMs ?? 200);
  return { primary, withTenantRead, downs };
}
const TOKEN = "0/3000060";
const read = (f: ReturnType<typeof fixture>, after?: string) => f.withTenantRead.forPlacement(placement, (db) => db.query(select, ["id"]), false, undefined, after === undefined ? undefined : { after });

test("a replica that has replayed the token serves the read at once", async () => {
  const replica = node("replica");
  const f = fixture(replica);
  await read(f, TOKEN);
  expect(replica.checks()).toBe(1);
  expect(replica.log).toContain(`token=${TOKEN}`);
  expect(replica.reads()).toBe(1);
  expect(f.primary.reads()).toBe(0);
});

test("a replica that catches up within the wait serves the read, after polling", async () => {
  let polls = 0;
  const replica = node("replica", { replayed: () => ++polls >= 3 });
  const f = fixture(replica);
  await read(f, TOKEN);
  expect(replica.checks()).toBe(3);
  expect(replica.reads()).toBe(1);
  expect(f.primary.reads()).toBe(0);
});

test("a replica that does not catch up within causalWaitMs hands the read to the primary, after waiting about that long", async () => {
  const replica = node("replica", { replayed: () => false });
  const f = fixture(replica, { causalWaitMs: 60 });
  const start = performance.now();
  await read(f, TOKEN);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(50);
  expect(elapsed).toBeLessThan(400);
  expect(replica.reads()).toBe(0);
  expect(f.primary.reads()).toBe(1);
});

test("the fallback to the primary also holds under the error policy: a token read is never refused for lag", async () => {
  const f = fixture(node("replica", { replayed: () => false }), { policy: "error", causalWaitMs: 20 });
  await read(f, TOKEN);
  expect(f.primary.reads()).toBe(1);
});

test("without a token nothing is checked and the read is as before", async () => {
  const replica = node("replica", { replayed: () => false });
  const f = fixture(replica);
  await read(f);
  expect(replica.checks()).toBe(0);
  expect(replica.reads()).toBe(1);
});

test("with no usable replica a token read goes to the primary, and a bad token is refused before any database is touched", async () => {
  const f = fixture(undefined);
  await read(f, TOKEN);
  expect(f.primary.reads()).toBe(1);
  const replica = node("replica");
  const g = fixture(replica);
  for (const bad of ["", "abc", "0/G", "1", "0/3000060; DROP", "00000000000/1"])
    await expect(read(g, bad)).rejects.toMatchObject({ code: "INVALID_QUERY" });
  expect(replica.log).toHaveLength(0);
  expect(g.primary.log).toHaveLength(0);
});

test("a replica that fails the replay check is marked down and the primary answers", async () => {
  const replica = node("replica", { replayed: () => true, fail: { code: "ECONNRESET" } });
  const f = fixture(replica);
  await read(f, TOKEN);
  expect(f.downs).toHaveLength(1);
  expect(f.primary.reads()).toBe(1);
});

test("a write earlier in the same request keeps reads on the primary and skips the replica check", async () => {
  const replica = node("replica");
  const f = fixture(replica);
  await f.withTenantRead.forPlacement(placement, (db) => db.query(select, ["id"]), true, undefined, { after: TOKEN });
  expect(replica.log).toHaveLength(0);
  expect(f.primary.reads()).toBe(1);
});
