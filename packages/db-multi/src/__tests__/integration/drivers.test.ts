import { afterAll, expect } from "bun:test";
import { createConfig } from "../../core/config";
import type { Database } from "../../core/database";
import { createManagement, migrateTenant } from "../../management";
import { openSession } from "../../core/operations/locks";
import { createDatabase } from "../../index";
import { drivers, failure, integration, pooledConfig } from "./helpers";

const opened: { close(): Promise<unknown> }[] = [];
afterAll(() => Promise.all(opened.map((db) => db.close())));

const VALUES = `SELECT 9007199254740993::int8 AS i8, 1.25::numeric AS n, 5::int4 AS i4, 1.5::float8 AS f,
  '2024-01-02'::date AS d, '2024-01-02 03:04:05.123+00'::timestamptz AS tz, '{"a":1}'::json AS j, '{"b":2}'::jsonb AS jb,
  '00000000-0000-4000-8000-000000000001'::uuid AS u, '\\x00ff'::bytea AS by, true AS b, ARRAY['x','y']::text[] AS ta,
  ARRAY[1,2]::int4[] AS ia, '1 day'::interval AS iv, '10:00'::time AS tm, NULL::text AS nothing,
  $1::timestamptz AS ptz, $2::date AS pd, $3::bytea AS pby, $4::int8 AS pbig`;

/** Every driver, through PgBouncer transaction pooling, returns the same JavaScript values. */
for (const [name, driver] of Object.entries(drivers)) {
  const runtime = () => {
    const db = createDatabase(pooledConfig(), { driver, poolMax: 2 });
    opened.push(db);
    return db.pools.platform as Database;
  };

  integration(`${name}: value types match across drivers (PgBouncer transaction pooling)`, async () => {
    const at = new Date("2026-09-15T00:00:00.000Z");
    const [row] = await runtime().query(VALUES, [at, at, new Uint8Array([1, 2]), "12"]);
    expect(row).toEqual({
      i8: "9007199254740993",
      n: "1.25",
      i4: 5,
      f: 1.5,
      d: new Date("2024-01-02T00:00:00.000Z"),
      tz: new Date("2024-01-02T03:04:05.123Z"),
      j: { a: 1 },
      jb: { b: 2 },
      u: "00000000-0000-4000-8000-000000000001",
      by: Buffer.from([0, 255]),
      b: true,
      ta: ["x", "y"],
      ia: [1, 2],
      iv: "1 day",
      tm: "10:00:00",
      nothing: null,
      ptz: at,
      pd: new Date("2026-09-15T00:00:00.000Z"),
      pby: Buffer.from([1, 2]),
      pbig: "12",
    });
  });

  integration(`${name}: database-default and SET LOCAL timeouts and SQLSTATE codes work through PgBouncer`, async () => {
    const db = runtime();
    const [setting] = await db.transaction((tx) => tx.query("SELECT current_setting('statement_timeout') AS value"));
    expect(setting).toEqual({ value: "5s" });
    expect(await failure(db.query("SELECT 1/0"))).toBe("22012");
    expect(await failure(db.transaction((tx) => tx.query("SELECT pg_sleep(1)"), { statementTimeoutMs: 50 }))).toBe(
      "DATABASE_TIMEOUT",
    );
    // Bootstrap's database default applies to pooled backends; SET LOCAL does not leak.
    expect(await db.pool.query("SELECT current_setting('statement_timeout') AS value")).toEqual([{ value: "5s" }]);
  });

  integration(`${name}: management on a transaction-pooled URL fails fast`, async () => {
    // A fresh URL spelling so the per-process direct-connection cache cannot hide the probe.
    const urls = pooledConfig().nodes.map((node) => `${node.url}?application_name=pooled_${name}`);
    const management = createManagement(createConfig(urls), { driver });
    opened.push(management);
    expect(await failure(openSession(management, "db0"))).toBe("DIRECT_CONNECTION_REQUIRED");
    expect(await failure(migrateTenant(management, "pooled-probe"))).toBe("DIRECT_CONNECTION_REQUIRED");
  });
}
