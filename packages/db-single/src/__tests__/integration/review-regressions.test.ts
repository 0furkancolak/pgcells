import { expect } from "bun:test";
import type { Driver } from "../../core/driver";
import { createRunner } from "../../core/migrations/runner";
import { compileMigrations } from "../../core/migrations/source";
import { createDb } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { createTestManagement, driver, dropSchema, failure, integration, managementDriver, pooledConfig, q, raw, roundTrip, testSchema, writeRuntimeDefaults } from "./helpers";

integration("database-default server timeouts cancel lock waits and long statements through PgBouncer", async () => {
  await writeRuntimeDefaults();
  const [blocker, schema] = [raw(), testSchema()];
  const db = createDb(pooledConfig(), { driver, schema });
  try {
    await blocker.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "locked")} (id integer)`);
    let release!: () => void;
    let locked!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const ready = new Promise<void>((resolve) => (locked = resolve));
    const lock = blocker.transaction(async (tx) => {
      await tx.exec(`LOCK TABLE ${q(schema, "locked")} IN ACCESS EXCLUSIVE MODE`);
      locked();
      await wait;
    });
    try {
      await ready;
      const started = performance.now();
      // Runtime defaults written by `migrate`: lock_timeout 1s, statement_timeout 5s.
      expect(["55P03", "DATABASE_TIMEOUT"]).toContain((await failure(db.query(prepareQuery("SELECT id FROM locked")))) ?? "");
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      release();
      await lock;
    }
    const started = performance.now();
    expect(await failure(db.pools.primary.query("SELECT pg_sleep(10)"))).toBe("DATABASE_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(8000);
    expect(await db.pools.primary.query("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
  } finally {
    await db.close();
    await dropSchema(blocker, schema);
    await blocker.close();
  }
});

/** Driver that opens every reserved connection with a local time zone, date style and interval style: the backup must not depend on these session settings.
 * After every COMMIT the connection's time zone is written to `zones`: the export's canonical form must stay transaction-local. */
const localFormats = (zones: string[]): Driver => (url, options) => {
  const pool = managementDriver(url, options);
  return {
    ...pool,
    reserve: async () => {
      const reserved = await pool.reserve();
      await reserved.exec("SET TimeZone TO 'America/New_York'; SET DateStyle TO 'SQL, DMY'; SET IntervalStyle TO 'iso_8601'");
      return {
        ...reserved,
        exec: async (sql) => {
          await reserved.exec(sql);
          if (sql === "COMMIT") zones.push((await reserved.query<{ zone: string }>("SELECT current_setting('TimeZone') AS zone"))[0]?.zone ?? "");
        },
      };
    },
  };
};

integration("export is canonical under a session with another time zone, date style and interval style, and leaves that session untouched", async () => {
  const registry = {
    migrations: compileMigrations([
      [
        "20260101000001_events",
        `--up
CREATE TABLE events (occurred_at timestamptz DEFAULT '2026-01-01 12:34:56+00'::timestamptz CHECK (occurred_at >= '2025-01-01 00:00:00+00'::timestamptz), day date DEFAULT '2026-01-02'::date, duration interval CHECK (duration >= '1 hour'::interval));
--down
DROP TABLE events;
`,
      ],
    ]),
    seeds: [],
  };
  const schema = testSchema();
  const zones: string[] = [];
  const [plain, local, admin] = [createTestManagement({ schema }), createTestManagement({ schema, driver: localFormats(zones) }), raw()];
  try {
    await createRunner(registry).migrate(plain);
    await admin.exec(`INSERT INTO ${q(schema, "events")} (occurred_at, duration) VALUES ('2026-01-01 12:34:56+00', interval '1 day 2 hours')`);
    const { before, after } = await roundTrip(local, plain, registry);
    expect(after).toEqual(before);
    expect(await admin.query(`SELECT occurred_at AT TIME ZONE 'UTC' AS at, day::text AS day, duration::text AS duration FROM ${q(schema, "events")}`)).toEqual([
      { at: new Date("2026-01-01T12:34:56.000Z"), day: "2026-01-02", duration: "1 day 02:00:00" },
    ]);
    // The canonical form is transaction-local like `SET LOCAL`: after COMMIT the session returns to its own time zone.
    expect(zones.length).toBeGreaterThan(0);
    expect(zones.every((zone) => zone === "America/New_York")).toBe(true);
  } finally {
    await Promise.all([plain.close(), local.close()]);
    await dropSchema(admin, schema);
    await admin.close();
  }
});
