import { expect, test } from "bun:test";
import type { PoolOptions } from "../../core/driver";
import { createPgDriver, type PgModule, type PgPoolConfig } from "../../core/pg-pool";

type Listener = (...args: unknown[]) => void;
const url = "postgres://app:pw@db.example.com/app";
const options: PoolOptions = { max: 4, idleTimeoutSeconds: 20, maxLifetimeSeconds: 300, connectTimeoutSeconds: 10 };

class Emitter {
  listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
class FakeClient extends Emitter {
  released: unknown[] = [];
  queries: { text: string; values?: unknown[] }[] = [];
  query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    return Promise.resolve({ rows: [{ a: 1 }], rowCount: 3 });
  }
  release(arg?: unknown) {
    this.released.push(arg);
  }
}

function fakeModule() {
  const pools: FakePool[] = [];
  class FakePool extends Emitter {
    clients: FakeClient[] = [];
    queries: { text: string; values?: unknown[] }[] = [];
    ended = 0;
    endResult: Promise<void> = Promise.resolve();
    constructor(public config: PgPoolConfig) {
      super();
      pools.push(this);
    }
    query(text: string, values?: unknown[]) {
      this.queries.push({ text, values });
      return Promise.resolve({ rows: [{ a: 1 }], rowCount: 3 });
    }
    async connect() {
      const client = new FakeClient();
      this.clients.push(client);
      this.emit("connect", client);
      return client;
    }
    end() {
      this.ended++;
      return this.endResult;
    }
  }
  const module = { Pool: FakePool, types: { getTypeParser: (oid: number) => `parser-${oid}` } } as unknown as PgModule;
  return { module, pools };
}

test("pool options map to the pg config and queries return rows with the affected count", async () => {
  const { module, pools } = fakeModule();
  const pool = createPgDriver(module)(url, options);
  expect(pools[0]?.config).toMatchObject({ connectionString: url, max: 4, idleTimeoutMillis: 20_000, maxLifetimeSeconds: 300, connectionTimeoutMillis: 10_000 });
  const rows = await pool.query("SELECT $1::timestamptz", [new Date("2026-01-02T03:04:05.000Z")]);
  expect(rows).toEqual([{ a: 1 }]);
  expect(rows.count).toBe(3);
  expect(pools[0]?.queries[0]?.values).toEqual(["2026-01-02T03:04:05.000Z"]);
  await pool.exec("CREATE TABLE t(id int)");
  expect(pools[0]?.queries[1]).toEqual({ text: "CREATE TABLE t(id int)", values: undefined });
});

test("date parses to UTC midnight, interval stays text and every other type goes to the module", () => {
  const { module, pools } = fakeModule();
  createPgDriver(module)(url, options);
  const { types } = (pools[0] as { config: PgPoolConfig }).config;
  expect(types.getTypeParser(1082)).toBeInstanceOf(Function);
  expect((types.getTypeParser(1082) as (value: string) => unknown)("2024-01-02")).toEqual(new Date("2024-01-02T00:00:00Z"));
  expect((types.getTypeParser(1186) as (value: string) => unknown)("1 day")).toBe("1 day");
  expect(types.getTypeParser(23)).toBe("parser-23");
});

test("a released connection returns to the pool, a discarded or broken one is thrown away", async () => {
  const { module, pools } = fakeModule();
  const pool = createPgDriver(module)(url, options);
  const [first, second, third] = [await pool.reserve(), await pool.reserve(), await pool.reserve()];
  first.release();
  second.release(true);
  pools[0]?.clients[2]?.emit("error", new Error("socket reset"));
  third.release();
  expect(pools[0]?.clients.map((client) => client.released)).toEqual([[false], [true], [true]]);
});

test("onClose runs once per client that ends and an idle pool error does not throw", async () => {
  const { module, pools } = fakeModule();
  let closed = 0;
  const pool = createPgDriver(module)(url, { ...options, onClose: () => closed++ });
  const reserved = await pool.reserve();
  pools[0]?.clients[0]?.emit("end");
  expect(closed).toBe(1);
  reserved.release();
  expect(() => pools[0]?.emit("error", new Error("idle client error"))).not.toThrow();
});

test("cancel exists only when the driver was given one, and it receives the client and URL", async () => {
  const { module, pools } = fakeModule();
  expect("cancel" in (await createPgDriver(module)(url, options).reserve())).toBe(false);
  const calls: unknown[][] = [];
  const reserved = await createPgDriver(module, { cancel: (client, target) => calls.push([client, target]) })(url, options).reserve();
  reserved.cancel?.();
  expect(calls).toEqual([[pools[1]?.clients[0], url]]);
});

test("close ends the pool once and returns within the bound even when end() never settles", async () => {
  const { module, pools } = fakeModule();
  const pool = createPgDriver(module)(url, options);
  (pools[0] as { endResult: Promise<void> }).endResult = new Promise(() => {});
  const started = performance.now();
  await pool.close(20);
  await pool.close(20);
  expect(performance.now() - started).toBeLessThan(500);
  expect(pools[0]?.ended).toBe(1);
});
