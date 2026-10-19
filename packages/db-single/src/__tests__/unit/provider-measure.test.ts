import { expect, test } from "bun:test";
import { AppError } from "../../core/errors";
import { alterDatabase, deadline, describe as describeError, privileges, probe, scrub } from "../provider/measure";
import { fakeDriver } from "../fixtures/fake-driver";

const urls = ["postgres://postgres.abcdefgh:s3cr%40t-pw@aws-0-eu.pooler.supabase.com:5432/postgres", "postgres://app:plain-pw@ep-cool-1.eu.neon.tech/neondb"];

test("scrub removes full URLs, passwords (raw and decoded), hosts and project-ref users", () => {
  const text = "connect failed postgres://app:plain-pw@ep-cool-1.eu.neon.tech/neondb; host aws-0-eu.pooler.supabase.com user postgres.abcdefgh pw s3cr@t-pw / s3cr%40t-pw";
  const result = scrub(text, urls);
  for (const secret of ["plain-pw", "ep-cool-1.eu.neon.tech", "aws-0-eu.pooler.supabase.com", "postgres.abcdefgh", "s3cr@t-pw", "s3cr%40t-pw"]) expect(result).not.toContain(secret);
  expect(result).toContain("connect failed");
});

test("scrub keeps the plain 'postgres' role name readable", () => {
  expect(scrub('permission denied for role "postgres"', ["postgres://postgres:pw12@h.example/db"])).toContain('role "postgres"');
});

test("describe prefixes the stable error code, scrubs the message and bounds its length", () => {
  expect(describeError(new AppError("DATABASE_TIMEOUT", "timed out at ep-cool-1.eu.neon.tech"), urls)).toBe("DATABASE_TIMEOUT: timed out at [hidden]");
  expect(describeError(new Error("x".repeat(1000)), urls).length).toBe(300);
  expect(describeError("plain string", urls)).toBe("OPERATION_FAILED: plain string");
});

const admin = "postgres://app:pw-admin@db.example.com/app";
const runtime = "postgres://app:pw-admin@pooler.example.com/app";
const ctx = (fake: ReturnType<typeof fakeDriver>) => ({ driver: fake.driver, urls: [admin, runtime] });
const texts = (fake: ReturnType<typeof fakeDriver>) => fake.commands.map((command) => command.text);

test("alterDatabase sets a probe value, sees it in fresh sessions and puts the stored value back", async () => {
  const fake = fakeDriver((text) =>
    text.includes("pg_db_role_setting") ? [{ name: "app", stored: "statement_timeout=5000" }] : text.includes("current_setting") ? [{ value: "7777ms" }] : [],
  );
  expect(await alterDatabase(ctx(fake), admin, runtime)).toEqual({ allowed: true, newSession: true, throughRuntime: true });
  const alters = texts(fake).filter((text) => text.startsWith("ALTER DATABASE"));
  expect(alters).toEqual([`ALTER DATABASE "app" SET statement_timeout TO '7777ms'`, `ALTER DATABASE "app" SET statement_timeout TO '5000'`]);
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
});

test("alterDatabase resets the setting when none was stored and reports a rejected ALTER without touching anything", async () => {
  const none = fakeDriver((text) => (text.includes("pg_db_role_setting") ? [{ name: "app", stored: null }] : text.includes("current_setting") ? [{ value: "7777ms" }] : []));
  await alterDatabase(ctx(none), admin, runtime);
  expect(texts(none).filter((text) => text.startsWith("ALTER DATABASE")).at(-1)).toBe(`ALTER DATABASE "app" RESET statement_timeout`);

  const denied = fakeDriver((text) => {
    if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: null }];
    if (text.startsWith("ALTER DATABASE")) throw Object.assign(new Error("permission denied to set parameter at pooler.example.com"), { code: "42501" });
    return [];
  });
  const result = await alterDatabase(ctx(denied), admin, runtime);
  expect(result).toEqual({ allowed: false, error: "42501: permission denied to set parameter at [hidden]" });
  expect(texts(denied).filter((text) => text.startsWith("ALTER DATABASE"))).toHaveLength(1);
});

test("alterDatabase restores even when a session check fails, and hands over the SQL when the restore itself fails", async () => {
  const broken = fakeDriver((text) => {
    if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: "statement_timeout=5000" }];
    if (text.includes("current_setting")) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
    return [];
  });
  const result = await alterDatabase(ctx(broken), admin, runtime);
  expect(result.allowed).toBe(true);
  expect(result.error).toBe("ECONNRESET: boom");
  expect(texts(broken).at(-1)).toBe(`ALTER DATABASE "app" SET statement_timeout TO '5000'`);

  let alters = 0;
  const stuck = fakeDriver((text) => {
    if (text.includes("pg_db_role_setting")) return [{ name: "app", stored: "statement_timeout=5000" }];
    if (text.startsWith("ALTER DATABASE") && ++alters === 2) throw new Error("connection lost");
    return text.includes("current_setting") ? [{ value: "7777ms" }] : [];
  });
  expect((await alterDatabase(ctx(stuck), admin, runtime)).restoreSql).toBe(`ALTER DATABASE "app" SET statement_timeout TO '5000'`);
});

test("privileges reads the database and role rights and tries one extension inside a rolled-back transaction", async () => {
  const fake = fakeDriver((text) => {
    if (text.includes("has_database_privilege")) return [{ create_schema: true, superuser: false }];
    if (text.includes("pg_available_extensions")) return [{ name: "citext" }];
    return [];
  });
  expect(await privileges(ctx(fake), admin)).toEqual({ createSchema: true, superuser: false, extension: { name: "citext", allowed: true } });
  const trial = texts(fake).filter((text) => /^(BEGIN|CREATE EXTENSION|ROLLBACK)/.test(text));
  expect(trial).toEqual(["BEGIN", 'CREATE EXTENSION "citext"', "ROLLBACK"]);

  const denied = fakeDriver((text) => {
    if (text.includes("has_database_privilege")) return [{ create_schema: true, superuser: false }];
    if (text.includes("pg_available_extensions")) return [{ name: "citext" }];
    if (text.startsWith("CREATE EXTENSION")) throw Object.assign(new Error("permission denied to create extension at db.example.com"), { code: "42501" });
    return [];
  });
  expect((await privileges(ctx(denied), admin)).extension).toEqual({ name: "citext", allowed: false, error: "42501: permission denied to create extension at [hidden]" });
  expect(texts(denied).at(-1)).toBe("ROLLBACK");
});

test("probe reports the pooler verdict and turns driver errors into scrubbed text", async () => {
  expect(await probe(ctx(fakeDriver(() => [{ pid: 7 }])), runtime)).toEqual({ transactionPooler: true });
  let pid = 0;
  expect(await probe(ctx(fakeDriver(() => [{ pid: ++pid }])), admin)).toEqual({ transactionPooler: false });
  const failing = fakeDriver(() => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND db.example.com"), { code: "ENOTFOUND" });
  });
  expect(await probe(ctx(failing), admin)).toEqual({ error: "ENOTFOUND: getaddrinfo ENOTFOUND [hidden]" });
});

const timing = { afterMs: 5, waitMs: 60, pollMs: 5 };
const activity = (counts: number[]) => {
  let call = 0;
  return fakeDriver((text) => (text.includes("pg_stat_activity") ? [{ n: counts[Math.min(call++, counts.length - 1)] }] : []));
};

test("deadline starts a tagged sleep on the runtime URL, discards the connection and waits for the server to drop it", async () => {
  const fake = activity([1, 1, 0]);
  const result = await deadline(ctx(fake), runtime, admin, timing);
  expect(result).toMatchObject({ observedRunning: true, cancelDefined: true });
  expect(result.serverStoppedAfterMs).toBeGreaterThan(0);
  const [sleep] = fake.commands.filter((command) => command.text.includes("pg_sleep"));
  expect(sleep?.url).toBe(runtime);
  expect(sleep?.text).toMatch(/SET LOCAL statement_timeout = 0; SET LOCAL client_connection_check_interval = 1000; SELECT pg_sleep\(120\) \/\* verify-provider-[0-9a-f-]{36} \*\//);
  const pool = fake.pools.find((item) => item.url === runtime);
  expect(pool).toMatchObject({ discarded: 1, cancels: 1 });
  expect(fake.pools.every((item) => item.closed)).toBe(true);
});

test("deadline reports no server stop when the backend keeps running, and 'not observed' when the sleep never showed up", async () => {
  const stuck = await deadline(ctx(activity([1])), runtime, admin, timing);
  expect(stuck).toMatchObject({ observedRunning: true, serverStoppedAfterMs: null });
  const never = activity([0]);
  const result = await deadline(ctx(never), runtime, admin, timing);
  expect(result).toMatchObject({ observedRunning: false, serverStoppedAfterMs: null });
  expect(never.pools.find((item) => item.url === runtime)?.discarded).toBe(1);
});

test("deadline turns a failing activity query (no visibility) into an error instead of a stop", async () => {
  const fake = fakeDriver((text) => {
    if (text.includes("pg_stat_activity")) throw Object.assign(new Error("permission denied for view pg_stat_activity"), { code: "42501" });
    return [];
  });
  const result = await deadline(ctx(fake), runtime, admin, timing);
  expect(result).toMatchObject({ observedRunning: false, serverStoppedAfterMs: null, error: "42501: permission denied for view pg_stat_activity" });
  expect(fake.pools.find((item) => item.url === runtime)?.discarded).toBe(1);
});

test("alterDatabase turns a failing first query (unreachable management URL) into a scrubbed error instead of rejecting", async () => {
  const fake = fakeDriver(() => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND db.example.com"), { code: "ENOTFOUND" });
  });
  expect(await alterDatabase(ctx(fake), admin, runtime)).toEqual({ allowed: false, error: "ENOTFOUND: getaddrinfo ENOTFOUND [hidden]" });
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
});
