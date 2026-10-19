/** Fault injection (toxiproxy): what the application sees when the pooler, a cell or the network between them fails, and how fast it recovers.
 * The measured bounds are the ones docs/guides/connections.md quotes. */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { failoverClass, retryable } from "../../core/failover";
import { bootstrap, provisionTenant } from "../../management";
import { createDatabase } from "../../index";
import { createTestManagement, createUser, driver, enabled, listUsers, removeTenants, uniqueEmail } from "./helpers";
import { available, faultConfig, pgbouncerConsole, proxy, resetFaults, until } from "./fault-fixture";

const run = enabled ? test : test.skip;
/** Other projects on the machine may run services with the same names: only this compose project's containers count. */
const composeDirectory = join(import.meta.dir, "../../..");
const prefix = `fault-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const onDb0 = `${prefix}-a`;
const onDb1 = `${prefix}-b`;
/** The application's statement timeout in these tests; the answer deadline is this + 1 s, and a cancel waits at most 0.5 s more. */
const STATEMENT_MS = 2000;
const BOUND_MS = STATEMENT_MS + 1500;
let management: ReturnType<typeof createTestManagement>;
const opened: ReturnType<typeof createDatabase>[] = [];
const open = (options: Record<string, unknown> = {}) => {
  const db = createDatabase(faultConfig(), { driver, statementTimeoutMs: STATEMENT_MS, poolMax: 5, ...options });
  opened.push(db);
  return db;
};
const add = (db: ReturnType<typeof createDatabase>, tenant: string) => db.withTenant(tenant, (t) => t.query(createUser, [crypto.randomUUID(), "fault", uniqueEmail()]));
const read = (db: ReturnType<typeof createDatabase>, tenant: string) => db.withTenant(tenant, (t) => t.query(listUsers, [5, 0]));
/** Runs `work`, returns its error (or undefined) and how long it took. */
async function timed(work: () => Promise<unknown>) {
  const start = performance.now();
  const error = await work().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { error, ms: performance.now() - start };
}

beforeAll(async () => {
  if (!enabled) return;
  if (!(await available())) throw new Error("toxiproxy is not reachable on 127.0.0.1:8474; start it with `docker compose up -d toxiproxy pgbouncer-faults`");
  await resetFaults();
  management = createTestManagement();
  await bootstrap(management);
  await provisionTenant(management, onDb0, "db0");
  await provisionTenant(management, onDb1, "db1");
});
afterEach(async () => {
  if (enabled) await resetFaults();
});
afterAll(async () => {
  if (!enabled) return;
  await resetFaults().catch(() => {});
  for (const db of opened) await db.close().catch(() => {});
  await removeTenants(management, prefix).catch(() => {});
  await management.close();
});

/** Both tenants cached and a server connection open on each cell, so a test breaks the data path, not the directory. */
async function warm(db: ReturnType<typeof createDatabase>) {
  await db.ready();
  await add(db, onDb0);
  await add(db, onDb1);
}
const code = (error: unknown) => (error as { code?: string } | undefined)?.code;

run("a cell whose pooler-to-PostgreSQL leg is cut: the first request times out within the documented bound, later ones fail fast and are classified, the other cell is untouched, recovery is quick", async () => {
  const db = open();
  await warm(db);
  await proxy("pooler-pg0").disable();
  const first = await timed(() => add(db, onDb0));
  expect(code(first.error)).toBe("DATABASE_TIMEOUT");
  expect(first.ms).toBeGreaterThan(STATEMENT_MS);
  expect(first.ms).toBeLessThan(BOUND_MS + 400); // answer deadline (statement + 1 s) + cancel wait (0.5 s)
  // PgBouncer caches the failed server login for `server_login_retry`, so later requests are answered at once with a pooler error.
  const later = await timed(() => add(db, onDb0));
  expect(failoverClass(later.error)).toBe("pooler-reset");
  expect(retryable(later.error)).toBe(true);
  expect(later.ms).toBeLessThan(500);
  expect((await timed(() => add(db, onDb1))).error).toBeUndefined();
  await proxy("pooler-pg0").enable();
  expect(await until(() => add(db, onDb0), 10_000)).toBeLessThan(5000);
});

run("a partition between pooler and PostgreSQL (data stalls, nothing closes): requests end with DATABASE_TIMEOUT within the bound, and the cell recovers when the partition heals", async () => {
  const db = open();
  await warm(db);
  await proxy("pooler-pg0").toxic("timeout", { timeout: 0 }, "downstream");
  await proxy("pooler-pg0").toxic("timeout", { timeout: 0 }, "upstream");
  const stalled = await timed(() => add(db, onDb0));
  expect(code(stalled.error)).toBe("DATABASE_TIMEOUT");
  expect(stalled.ms).toBeLessThan(BOUND_MS + 400);
  expect(failoverClass(stalled.error)).toBe("timeout");
  expect(retryable(stalled.error)).toBe(false); // the statement may have run
  expect((await timed(() => add(db, onDb1))).error).toBeUndefined();
  await proxy("pooler-pg0").reset();
  await until(() => add(db, onDb0), 20_000);
});

run("added latency on the pooler-to-PostgreSQL leg shows up as latency, not as errors, until it exceeds the deadline", async () => {
  const db = open();
  await warm(db);
  await proxy("pooler-pg0").toxic("latency", { latency: 300 });
  const slow = await timed(() => read(db, onDb0));
  expect(slow.error).toBeUndefined();
  expect(slow.ms).toBeGreaterThan(250);
  expect(slow.ms).toBeLessThan(STATEMENT_MS);
  await proxy("pooler-pg0").reset();
  await proxy("pooler-pg0").toxic("latency", { latency: 6000 });
  const tooSlow = await timed(() => read(db, onDb0));
  expect(code(tooSlow.error)).toBe("DATABASE_TIMEOUT");
  expect(tooSlow.ms).toBeLessThan(BOUND_MS + 400);
});

run("the pooler goes down and comes back: requests fail with classified, retryable errors while it is down and succeed again shortly after it is up", async () => {
  const db = open();
  await warm(db);
  const id = (await Bun.$`docker ps -q --filter label=com.docker.compose.service=pgbouncer-faults --filter label=com.docker.compose.project.working_dir=${composeDirectory}`.text()).trim();
  expect(id).not.toBe("");
  await Bun.$`docker stop -t 2 ${id}`.quiet();
  try {
    const during: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const outcome = await timed(() => add(db, onDb0));
      expect(outcome.error, "the pooler is down: the request must fail").toBeDefined();
      expect(outcome.ms).toBeLessThan(BOUND_MS + 400);
      during.push(outcome.error);
    }
    for (const error of during) expect(failoverClass(error), `unclassified: ${String(error)}`).toBeDefined();
    expect(during.every((error) => failoverClass(error) === "unreachable" && retryable(error))).toBe(true); // no connection within the acquire deadline
  } finally {
    await Bun.$`docker start ${id}`.quiet();
  }
  const recovered = await until(() => add(db, onDb0), 30_000, 100);
  expect(recovered).toBeLessThan(15_000);
  expect((await timed(() => add(db, onDb1))).error).toBeUndefined();
});

run("after RECONNECT the database-level statement_timeout still applies to the new server connections", async () => {
  // The server-side default (bootstrap) is 5000 ms; the application deadline here is longer so that the server's 57014 is what ends the statement.
  const db = open({ statementTimeoutMs: 6000 });
  await warm(db);
  const pgbouncer = pgbouncerConsole();
  try {
    await pgbouncer.query("RECONNECT");
  } finally {
    await pgbouncer.close();
  }
  const start = performance.now();
  await expect(db.pools.node("db0").query("SELECT pg_sleep(8)")).rejects.toMatchObject({ code: "DATABASE_TIMEOUT" });
  const elapsed = performance.now() - start;
  expect(elapsed).toBeGreaterThan(4500);
  expect(elapsed).toBeLessThan(6500);
});

run("a connection storm: the process sheds load with DATABASE_BUSY, the pooler queues the rest (cl_waiting) and everything accepted completes", async () => {
  // Four processes with 5 connections each against a server pool of 5 per database: the pooler has to queue.
  const processes = Array.from({ length: 4 }, () => open({ poolMax: 5, statementTimeoutMs: 6000 }));
  await Promise.all(processes.map((db) => db.ready()));
  const pgbouncer = pgbouncerConsole();
  let maxWaiting = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const pools = await pgbouncer.query<{ database: string; cl_waiting: number }>("SHOW POOLS").catch(() => []);
      for (const pool of pools) if (pool.database === "db0") maxWaiting = Math.max(maxWaiting, Number(pool.cl_waiting));
      await Bun.sleep(50);
    }
  })();
  try {
    const results = await Promise.all(
      processes.flatMap((db) => Array.from({ length: 80 }, () => timed(() => db.pools.node("db0").query("SELECT pg_sleep(0.1)")))),
    );
    const busy = results.filter((result) => code(result.error) === "DATABASE_BUSY").length;
    const failed = results.filter((result) => result.error && code(result.error) !== "DATABASE_BUSY");
    expect(failed.map((result) => String(result.error))).toEqual([]);
    expect(busy).toBeGreaterThan(0);
    expect(busy).toBeLessThan(results.length);
    expect(processes.reduce((sum, db) => sum + (db.stats().databases.db0?.busyRejected ?? 0), 0)).toBe(busy);
    expect(maxWaiting).toBeGreaterThan(0);
  } finally {
    sampling = false;
    await sampler;
    await pgbouncer.close();
  }
});

run("a rolling deploy: the old generation drains while the new one takes over, with no failed request", async () => {
  const old = open();
  await warm(old);
  const next = open();
  await warm(next);
  let current = old;
  let stop = false;
  const failures: unknown[] = [];
  let served = 0;
  const traffic = Array.from({ length: 6 }, async () => {
    while (!stop) {
      try {
        await add(current, onDb0);
        served++;
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Bun.sleep(300);
  current = next; // the load balancer stops sending to the old generation ...
  const closing = old.close({ drain: true, timeoutMs: 5000 }); // ... which finishes what it started
  await Bun.sleep(600);
  stop = true;
  await Promise.all(traffic);
  expect(await closing).toEqual({ drained: true, remaining: 0 });
  expect(failures.map(String)).toEqual([]);
  expect(served).toBeGreaterThan(20);
  await expect(add(old, onDb0)).rejects.toMatchObject({ code: "DATABASE_CLOSED" });
});
