import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createDb, type DbOptions } from "../../core/runtime";
import { fakeDriver } from "../fixtures/fake-driver";

const url = "postgres://app:secret-pw@localhost:6432/one";

/** `pid()` is the answer to every `pg_backend_pid` query; `SELECT 1` is the reachability check. */
function fixture(pid: () => number | Error, reachable: () => void = () => {}) {
  const fake = fakeDriver((text) => {
    if (text.includes("pg_backend_pid")) {
      const value = pid();
      if (value instanceof Error) throw value;
      return [{ pid: value }];
    }
    if (text === "SELECT 1") reachable();
    return [];
  });
  const open = (options: Omit<DbOptions, "driver"> = {}) => createDb(createConfig(url), { driver: fake.driver, ...options });
  const probes = () => fake.commands.filter((command) => command.text.includes("pg_backend_pid")).length;
  return { fake, open, probes };
}

test("ready() refuses a direct connection with POOLER_REQUIRED and reveals no connection detail", async () => {
  let n = 0;
  const { open } = fixture(() => ++n);
  const db = open();
  const error = await db.ready().then(
    () => undefined,
    (reason: unknown) => reason as { code: string; message: string },
  );
  expect(error?.code).toBe("POOLER_REQUIRED");
  expect(error?.message).not.toContain("secret-pw");
  expect(error?.message).not.toContain("localhost");
  await db.close();
});

test("a pooler passes and the result is kept: later ready() calls do not probe again", async () => {
  const { open, probes } = fixture(() => 7);
  const db = open();
  await db.ready();
  expect(probes()).toBe(2);
  await db.ready();
  await db.ready();
  expect(probes()).toBe(2);
  await db.close();
});

test("pooler: 'assumed' skips the probe but still checks the database answers", async () => {
  let n = 0;
  let pings = 0;
  const { open, probes } = fixture(() => ++n, () => void pings++);
  const db = open({ pooler: "assumed" });
  await db.ready();
  expect(probes()).toBe(0);
  expect(pings).toBe(1);
  await db.close();
});

test("a failed probe is not kept: the next ready() tries again", async () => {
  let pooled = false;
  let n = 0;
  const { open } = fixture(() => (pooled ? 7 : ++n));
  const db = open();
  await expect(db.ready()).rejects.toMatchObject({ code: "POOLER_REQUIRED" });
  pooled = true;
  await db.ready();
  await db.close();
});

test("two health checks calling ready() at once share one probe", async () => {
  const { open, probes } = fixture(() => 7);
  const db = open();
  await Promise.all([db.ready(), db.ready()]);
  expect(probes()).toBe(2);
  await db.close();
});

test("with poolMax 1 the probe uses its own two-connection pool and leaves the runtime pool alone", async () => {
  const { fake, open } = fixture(() => 7);
  const db = open({ poolMax: 1 });
  await db.ready();
  expect(fake.pools.some((pool) => pool.options.max === 2)).toBe(true);
  expect(fake.pools.filter((pool) => pool.options.max === 1).every((pool) => !pool.closed)).toBe(true);
  await db.close();
});

test("an unreachable database is DATABASE_UNAVAILABLE without host or credentials, with or without the probe", async () => {
  const refused = () => {
    throw Object.assign(new Error("refused secret-pw"), { code: "ECONNREFUSED" });
  };
  for (const options of [{}, { pooler: "assumed" as const }]) {
    const { open } = fixture(() => 7, refused);
    const db = open(options);
    const error = (await db.ready().catch((e: unknown) => e)) as { code: string; message: string };
    expect(error.code).toBe("DATABASE_UNAVAILABLE");
    expect(error.message).not.toContain("secret-pw");
    expect(error.message).not.toContain("localhost");
    await db.close();
  }
  const { open } = fixture(() => Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  const db = open();
  await expect(db.ready()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
  await db.close();
});

test("a pooler value other than verified or assumed is INVALID_CONFIG, never a silently skipped probe", () => {
  const { open, fake } = fixture(() => 1);
  for (const pooler of ["Verified", "off", "", true, 0, null]) expect(() => open({ pooler: pooler as never })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  expect(fake.pools).toHaveLength(0);
});

test("server errors such as failed authentication or a missing database surface without the user or database name", async () => {
  const failures = [
    { errno: "28P01", message: 'password authentication failed for user "app"' },
    { errno: "3D000", message: 'database "one" does not exist' },
  ];
  for (const failure of failures)
    for (const [pid, reachable] of [
      [() => 7, () => { throw Object.assign(new Error(failure.message), failure); }],
      [() => Object.assign(new Error(failure.message), failure), () => {}],
    ] as const) {
      const { open } = fixture(pid, reachable);
      const db = open();
      const error = (await db.ready().catch((e: unknown) => e)) as { code: string; message: string };
      expect(error.code).toBe("DATABASE_UNAVAILABLE");
      expect(error.message).toContain(failure.errno);
      expect(error.message).not.toContain('"app"');
      expect(error.message).not.toContain('"one"');
      await db.close();
    }
});
