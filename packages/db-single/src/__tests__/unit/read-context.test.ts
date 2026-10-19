import { expect, test } from "bun:test";
import { createReader, type Queryable, runContext } from "../../core/context";
import { prepareQuery } from "../../core/sql/compiler";

const SCHEMA = "app_test";
const select = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const update = prepareQuery("UPDATE students SET name = $1::text WHERE id = $2::uuid");

/** Recording fake pool: `query` and `transaction(mode)`. */
function recorder(fail?: { code: string }) {
  const log: { text: string }[] = [];
  const modes: (string | undefined)[] = [];
  const db = {
    query: async (text: string) => {
      log.push({ text });
      if (fail?.code) throw Object.assign(new Error("boom"), fail);
      return [];
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>, options?: { mode?: string }) => {
      modes.push(options?.mode);
      return work(db);
    },
  };
  return { db, log, modes };
}

/** `replica`: the selected replica; `configured`: a replica is configured but (by default) not healthy. */
function fixture(options: { replica?: ReturnType<typeof recorder>; policy?: "primary" | "error"; configured?: boolean } = {}) {
  const primary = recorder();
  const downs: number[] = [];
  const picks: number[] = [];
  const router = {
    pick: async () => (picks.push(1), options.replica ? { db: options.replica.db as never, markDown: () => void downs.push(1) } : undefined),
  };
  const replicaUrls = options.replica || options.configured ? ["postgres://replica"] : [];
  const read = createReader({ primary: primary.db, replicaUrls } as never, router, options.policy ?? "primary", SCHEMA);
  const run = <T>(work: (db: Queryable) => Promise<T>, onWrite?: () => void) => runContext(primary.db as never, primary.db as never, SCHEMA, work, { onWrite });
  return { primary, downs, picks, read, run };
}

test("a read-only query runs on the picked replica, bound to the schema, and never touches the primary", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  await f.read((db) => db.query(select, ["id"]));
  expect(replica.log).toHaveLength(1);
  expect(replica.log[0]?.text).toContain(`"${SCHEMA}"`);
  expect(f.primary.log).toHaveLength(0);
  expect(f.primary.modes).toHaveLength(0);
});

test("a query that is not read-only is rejected before any database is touched", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  const error = (await f.read(async (db) => db.query(update, ["x", "id"])).catch((e: unknown) => e)) as { code: string };
  expect(error).toMatchObject({ code: "QUERY_NOT_READ_ONLY" });
  expect(replica.log).toHaveLength(0);
  expect(f.primary.log).toHaveLength(0);
});

test("with no replica configured the primary policy runs one plain statement: no transaction, no router pick", async () => {
  const f = fixture();
  await f.read((db) => db.query(select, ["id"]));
  expect(f.primary.modes).toEqual([]);
  expect(f.primary.log).toHaveLength(1);
  expect(f.picks).toHaveLength(0);
});

test("with configured replicas that are all unusable the primary policy keeps the READ ONLY transaction", async () => {
  const f = fixture({ configured: true });
  await f.read((db) => db.query(select, ["id"]));
  expect(f.picks).toHaveLength(1);
  expect(f.primary.modes).toEqual([" READ ONLY"]);
  expect(f.primary.log).toHaveLength(1);
});

test("the error policy raises REPLICA_UNAVAILABLE without touching any database, also when no replica is configured", async () => {
  const f = fixture({ policy: "error" });
  const error = (await f.read(async (db) => db.query(select, ["id"])).catch((e: unknown) => e)) as { code: string; message: string };
  expect(error).toMatchObject({ code: "REPLICA_UNAVAILABLE" });
  expect(error.message).not.toContain("postgres://");
  expect(f.primary.log).toHaveLength(0);
  expect(f.picks).toHaveLength(0);
});

test("the error policy with configured but unusable replicas also raises REPLICA_UNAVAILABLE", async () => {
  const f = fixture({ configured: true, policy: "error" });
  await expect(f.read(async (db) => db.query(select, ["id"]))).rejects.toMatchObject({ code: "REPLICA_UNAVAILABLE" });
  expect(f.primary.log).toHaveLength(0);
});

test("after a write in the same request the read goes to the primary even under the error policy", async () => {
  const replica = recorder();
  const f = fixture({ replica, policy: "error" });
  await f.read((db) => db.query(select, ["id"]), true);
  expect(replica.log).toHaveLength(0);
  expect(f.primary.modes).toEqual([]);
  expect(f.primary.log).toHaveLength(1);
  expect(f.picks).toHaveLength(0);
});

test("a connection error marks the replica down; a SQL error does not; both surface", async () => {
  const dead = recorder({ code: "ECONNRESET" });
  const f = fixture({ replica: dead });
  expect(await f.read((db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("ECONNRESET");
  expect(f.downs).toHaveLength(1);
  const timeout = recorder({ code: "57014" });
  const g = fixture({ replica: timeout });
  expect(await g.read((db) => db.query(select, ["id"])).catch((e: unknown) => (e as { code: string }).code)).toBe("57014");
  expect(g.downs).toHaveLength(0);
});

test("the read context expires after the work", async () => {
  const replica = recorder();
  const f = fixture({ replica });
  let escaped!: { query: (...args: never[]) => unknown };
  await f.read(async (db) => void (escaped = db as never));
  expect(() => escaped.query(select as never)).toThrow(expect.objectContaining({ code: "TRANSACTION_CLOSED" }));
});

test("a session pins reads to the first replica until it fails, then the next read picks again", async () => {
  const fail = { code: "" };
  const replica = recorder(fail);
  const picks: number[] = [];
  const primary = recorder();
  const router = { pick: async () => (picks.push(1), { db: replica.db as never, markDown: () => {} }) };
  const read = createReader({ primary: primary.db, replicaUrls: ["postgres://replica"] } as never, router, "primary", SCHEMA);
  const session = {};
  await read((db) => db.query(select, ["a"]), false, session);
  await read((db) => db.query(select, ["b"]), false, session);
  expect(picks).toHaveLength(1);
  fail.code = "ECONNRESET";
  await read((db) => db.query(select, ["c"]), false, session).catch(() => {});
  fail.code = "";
  await read((db) => db.query(select, ["d"]), false, session);
  expect(picks).toHaveLength(2);
  expect(replica.log).toHaveLength(4);
});

test("onWrite fires for writes (also inside transactions) and not for reads", async () => {
  const f = fixture();
  let writes = 0;
  const onWrite = () => void writes++;
  await f.run((db) => db.query(select, ["id"]), onWrite);
  expect(writes).toBe(0);
  await f.run((db) => db.transaction((tx) => tx.query(select, ["id"])), onWrite);
  expect(writes).toBe(0);
  await f.run((db) => db.query(update, ["x", "id"]), onWrite);
  expect(writes).toBe(1);
  await f.run((db) => db.transaction((tx) => tx.query(update, ["x", "id"])), onWrite);
  expect(writes).toBe(2);
});
