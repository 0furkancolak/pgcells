import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeDriver } from "../fixtures/fake-driver";
import { driverName, verify } from "../provider/verify";

const management = "postgres://app:pw-one@db0.example.com/app";
const runtime = "postgres://app:pw-one@pool0.example.com/app";
const timing = { afterMs: 1, waitMs: 20, pollMs: 1, gapMs: 1 };

const handler = (text: string, _params: readonly unknown[], pool: { url: string }) => {
  if (text.includes("pg_backend_pid()") && text.includes("AS pid")) return [{ pid: pool.url.includes("pool") ? 7 : Math.random() }];
  if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: null }];
  if (text.includes("current_setting")) return [{ value: "7777ms" }];
  if (text.includes("has_database_privilege")) return [{ create_schema: true, superuser: false }];
  if (text.includes("pg_stat_activity")) return [{ n: 0 }];
  if (text.includes("version()")) return [{ server: "PostgreSQL 16.4 on x86_64" }];
  return [];
};

test("verify measures the database once and the report never carries URLs, hosts, users or passwords", async () => {
  const fake = fakeDriver(handler);
  const report = await verify(fake.driver, "bun", management, runtime, new Date("2026-10-03T10:00:00Z"), timing);
  expect(report).toMatchObject({ generatedAt: "2026-10-03T10:00:00.000Z", driver: "bun", server: "PostgreSQL 16.4 on x86_64" });
  expect(report.database.probe.runtime).toEqual({ transactionPooler: true });
  expect(report.database.probe.management).toEqual({ transactionPooler: false });
  expect(report.database.alterDatabase).toMatchObject({ allowed: true, newSession: true });
  const text = JSON.stringify(report);
  for (const secret of ["pw-one", "db0.example.com", "pool0.example.com", "postgres://"]) expect(text).not.toContain(secret);
});

test("driverName defaults to bun, accepts the four drivers and rejects anything else", () => {
  expect(driverName([])).toBe("bun");
  expect(driverName(["--driver", "pg"])).toBe("pg");
  expect(driverName(["--driver", "neon"])).toBe("neon");
  expect(driverName(["--driver=postgres"])).toBe("postgres");
  expect(() => driverName(["--driver", "mysql"])).toThrow(expect.objectContaining({ code: "USAGE" }));
  expect(() => driverName(["--driver"])).toThrow(expect.objectContaining({ code: "USAGE" }));
});

test("the verify CLI reports a failure as one JSON line without a stack trace or secrets", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../provider/verify.ts")], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URLS: "postgres://app:secret-pw@127.0.0.1:1/app" },
    stdin: new Blob(["not-a-url\n"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  const last = stderr.trim().split("\n").at(-1) ?? "";
  expect(JSON.parse(last)).toEqual({ error: "USAGE", message: "Runtime URL is not a valid postgres:// URL" });
  expect(stderr).not.toMatch(/secret-pw|\bat .*\(/);
});

test("verify measures the replica when a replica URL is given, and the report still carries no URL or host", async () => {
  const fake = fakeDriver((text, params, pool) => {
    if (text.includes("pg_current_wal_lsn")) return [{ lsn: "0/3000000" }];
    if (text.includes("pg_is_in_recovery")) return [{ in_recovery: true, caught_up: false, lag_ms: 12 }];
    if (text.startsWith("SHOW max_standby_streaming_delay")) return [{ max_standby_streaming_delay: "30s" }];
    if (text.startsWith("SHOW hot_standby_feedback")) return [{ hot_standby_feedback: "off" }];
    return handler(text, params, pool);
  });
  const report = await verify(fake.driver, "bun", management, runtime, new Date("2026-10-03T10:00:00Z"), timing, "postgres://app:pw-r0@replica0.example.com/app");
  expect(report.database.replica).toEqual({ inRecovery: true, lagMs: [12, 12, 12], maxStandbyStreamingDelay: "30s", hotStandbyFeedback: "off" });
  const text = JSON.stringify(report);
  for (const secret of ["pw-r0", "replica0.example.com"]) expect(text).not.toContain(secret);
});

test("a failing replica measurement becomes a scrubbed error entry, not an exception", async () => {
  const fake = fakeDriver((text, params, pool) => {
    if (pool.url.includes("replica0")) throw new Error(`cannot connect to ${pool.url} password pw-r0`);
    return handler(text, params, pool);
  });
  const report = await verify(fake.driver, "bun", management, runtime, new Date(), timing, "postgres://app:pw-r0@replica0.example.com/app");
  expect(report.database.replica).toMatchObject({ error: expect.any(String) });
  expect(JSON.stringify(report)).not.toContain("pw-r0");
});
