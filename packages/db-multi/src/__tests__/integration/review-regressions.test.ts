import { expect } from "bun:test";
import { connect } from "../../core/database";
import { bootstrap } from "../../management";
import { fingerprint } from "../../core/tools/copy";
import { createTestRuntime, directConfig, driver, failure, integration, q, raw } from "./helpers";

integration("database-default server timeouts cancel platform lock waits and long statements through PgBouncer", async () => {
  const app = createTestRuntime();
  const blocker = raw();
  try {
    await bootstrap(app.management);
    let release!: () => void;
    let locked!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const lock = blocker.transaction(async (tx) => {
      await tx.exec("LOCK TABLE platform.placements IN ACCESS EXCLUSIVE MODE");
      locked();
      await wait;
    });
    try {
      await ready;
      const started = performance.now();
      // Runtime defaults written by bootstrap: lock_timeout 1s, statement_timeout 5s.
      expect(["55P03", "DATABASE_TIMEOUT"]).toContain((await failure(app.platform.get("demo-tenant"))) ?? "");
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      release();
      await lock;
    }
    const started = performance.now();
    expect(await failure(app.pools.platform.query("SELECT pg_sleep(10)"))).toBe("DATABASE_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(8000);
    expect(await app.pools.platform.query("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
  } finally {
    await blocker.close();
    await app.close();
  }
});

integration("fingerprint canonicalizes session timestamp and interval formatting", async () => {
  const url = directConfig().nodes[0]?.url ?? "";
  const session = async (settings: string) => {
    const pool = driver(url, { max: 1, idleTimeoutSeconds: 60, maxLifetimeSeconds: 600, connectTimeoutSeconds: 10 });
    await pool.exec(settings);
    return connect(pool, { deadlineMs: 30000, timeouts: { statementTimeoutMs: 30000, lockTimeoutMs: 1000 }, maxPending: 8 });
  };
  const utc = await session("SET TimeZone TO 'UTC'; SET DateStyle TO 'ISO, YMD'; SET IntervalStyle TO 'postgres'");
  const local = await session(
    "SET TimeZone TO 'America/New_York'; SET DateStyle TO 'SQL, DMY'; SET IntervalStyle TO 'iso_8601'",
  );
  const schema = `tenant_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await utc.exec(
      `CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "events")} (occurred_at timestamptz DEFAULT '2026-01-01 12:34:56+00'::timestamptz CHECK (occurred_at >= '2025-01-01 00:00:00+00'::timestamptz), duration interval); INSERT INTO ${q(schema, "events")} VALUES ('2026-01-01 12:34:56+00', interval '1 day 2 hours')`,
    );
    expect(await fingerprint(utc, schema)).toBe(await fingerprint(local, schema));
    expect(await local.pool.query("SELECT current_setting('TimeZone') AS zone")).toEqual([{ zone: "America/New_York" }]);
  } finally {
    await utc.exec(`DROP SCHEMA ${q(schema)} CASCADE`);
    await Promise.all([utc.close(), local.close()]);
  }
});
