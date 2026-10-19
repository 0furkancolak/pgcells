import { afterAll, beforeAll, expect } from "bun:test";
import { createConfig } from "../../core/config";
import type { Database } from "../../core/database";
import { openSession } from "../../core/locks";
import { createManagement } from "../../core/management";
import { createRunner } from "../../core/migrations/runner";
import { createDb } from "../../core/runtime";
import { createTestManagement, drivers, enabled, failure, integration, pooledConfig, writeRuntimeDefaults } from "./helpers";

const opened: { close(): Promise<void> }[] = [];
afterAll(() => Promise.all(opened.map((db) => db.close())));
beforeAll(() => (enabled ? writeRuntimeDefaults() : undefined));

const VALUES = `SELECT 9007199254740993::int8 AS i8, 1.25::numeric AS n, 5::int4 AS i4, 1.5::float8 AS f,
  '2024-01-02'::date AS d, '2024-01-02 03:04:05.123+00'::timestamptz AS tz, '{"a":1}'::json AS j, '{"b":2}'::jsonb AS jb,
  '00000000-0000-4000-8000-000000000001'::uuid AS u, '\\x00ff'::bytea AS by, true AS b, ARRAY['x','y']::text[] AS ta,
  ARRAY[1,2]::int4[] AS ia, '1 day'::interval AS iv, '10:00'::time AS tm, NULL::text AS nothing,
  $1::timestamptz AS ptz, $2::date AS pd, $3::bytea AS pby, $4::int8 AS pbig`;

/** Dört sürücü de PgBouncer transaction pooling üzerinden aynı JavaScript değerlerini döndürür. */
for (const [name, driver] of Object.entries(drivers)) {
  const runtime = () => {
    const db = createDb(pooledConfig(), { driver, poolMax: 2 });
    opened.push(db);
    return db.pools.primary as Database;
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
    expect(await failure(db.transaction((tx) => tx.query("SELECT pg_sleep(1)"), { statementTimeoutMs: 50 }))).toBe("DATABASE_TIMEOUT");
    // `migrate`in yazdığı veritabanı varsayılanı havuzdaki backend'lere uygulanır; SET LOCAL sızmaz.
    expect(await db.pool.query("SELECT current_setting('statement_timeout') AS value")).toEqual([{ value: "5s" }]);
  });

  integration(`${name}: management on a transaction-pooled URL fails fast`, async () => {
    // Yeni bir URL yazımı: işlem başına doğrudan-bağlantı önbelleği yoklamayı gizleyemez.
    const m = createManagement(createConfig(`${pooledConfig().url}?application_name=pooled_${name}`), { driver });
    opened.push(m);
    expect(await failure(openSession(m))).toBe("DIRECT_CONNECTION_REQUIRED");
    expect(await failure(createRunner({ migrations: [], seeds: [] }).migrate(m))).toBe("DIRECT_CONNECTION_REQUIRED");
  });
}

integration("management opens a lock session on the direct URL", async () => {
  const m = createTestManagement();
  try {
    const session = await openSession(m);
    expect(session.pid).toBeGreaterThan(0);
    await session.close();
  } finally {
    await m.close();
  }
});
