import { expect, test } from "bun:test";
import { createConfig } from "../../core/config";
import { createManagement } from "../../management";
import { nodeMigrations, platformMigrations } from "../../core/migrations/registry";
import { doctor } from "../../core/tools/doctor";
import { fakeDriver } from "../fixtures/fake-driver";

let port = 8000;
let runtimePid = 1000;
function fixture(options: { broken?: boolean; pooled?: boolean; identity?: string; consoleMode?: string; timeouts?: string; console?: Record<string, string | null>; maxConnections?: number } = {}) {
  const fake = fakeDriver((text, _params, pool) => {
    if (!/^\s*(SELECT|SHOW)\b/.test(text)) throw new Error("Doctor must be read-only");
    if (options.broken) throw new Error(`credentials leaked: ${pool.url}`);
    if (text.includes("pg_backend_pid")) {
      // Runtime URL'si sınaması: aynı havuzda iki bağlantı; pooler tek oturum, doğrudan her sorguda yeni oturum.
      if (pool.url.includes("pooler.example")) return [{ pid: 7 }];
      if (pool.url.includes("direct.example")) return [{ pid: ++runtimePid }];
      return [{ pid: options.pooled ? 1 : 100 + pool.index }];
    }
    if (text.includes("set_config")) return [{}];
    if (text.includes("_migrations"))
      return (text.includes("_node_") ? nodeMigrations : platformMigrations).map(({ id, checksum }) => ({ id, checksum }));
    if (text.includes("__moved_") || text.includes("platform.moves")) return [];
    if (text.includes("platform.nodes") || text.includes("node_identity"))
      return [{ database_id: options.identity ?? "db0" }];
    if (text.includes("AS invalid")) return [{ invalid: 0, inactive: 0, moving: 0, recovery: 0 }];
    if (text.includes("standard_conforming_strings")) return [{ on: true }];
    if (text.includes("pg_db_role_setting")) return [{ settings: options.timeouts ?? "statement_timeout=5000,lock_timeout=1000,client_connection_check_interval=1000" }];
    if (text === "SHOW CONFIG")
      return [
        { key: "unset_option", value: null },
        { key: "pool_mode", value: options.consoleMode ?? "transaction" },
        ...Object.entries({ query_wait_timeout: "8", max_client_conn: "1000", default_pool_size: "20", ...options.console }).map(([key, value]) => ({ key, value })),
      ];
    if (text.includes("max_connections")) return [{ max_connections: options.maxConnections ?? 200, reserved: 3 }];
    throw new Error("Unexpected diagnostic query");
  });
  const app = createManagement(createConfig([`postgres://admin:private-secret@localhost:${port++}/app`]), {
    driver: fake.driver,
  });
  return { app, fake };
}

async function run(options: Parameters<typeof fixture>[0], pgbouncerUrl?: string) {
  const { app, fake } = fixture(options);
  const result = await doctor(app, { pgbouncerUrl, consoleDriver: fake.driver });
  await app.close();
  expect(fake.pools.every((pool) => pool.closed)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-secret");
  return result;
}

test("doctor is read-only and passes a healthy direct configuration", async () => {
  const result = await run({});
  expect(result.checks.filter((check) => !check.ok)).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.externalChecks.every((check) => check.status === "unverified")).toBe(true);
});

test("doctor reports pooled management URLs, reordered databases and missing runtime timeouts", async () => {
  expect((await run({ pooled: true })).checks).toContainEqual(
    expect.objectContaining({ target: "db0", check: "direct_connection", ok: false }),
  );
  expect((await run({ identity: "db1" })).checks).toContainEqual(
    expect.objectContaining({ check: "database_identity", ok: false }),
  );
  expect((await run({ timeouts: "statement_timeout=0" })).checks).toContainEqual(
    expect.objectContaining({ check: "runtime_timeouts", ok: false }),
  );
});

test("doctor redacts connection failures", async () => {
  const result = await run({ broken: true });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("postgres://");
});

test("an invalid optional PgBouncer URL is a redacted diagnostic failure", async () => {
  const result = await run({}, "https://private-secret/pgbouncer");
  expect(result.checks).toContainEqual(expect.objectContaining({ target: "pgbouncer", ok: false }));
});

test("PgBouncer config may contain unset values; only the pool mode is interpreted", async () => {
  for (const mode of ["transaction", "session"]) {
    const result = await run({ consoleMode: mode }, "postgres://admin:private-secret@localhost/pgbouncer");
    expect(result.ok).toBe(mode === "transaction");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ target: "pgbouncer", check: "global_pool_mode", ok: mode === "transaction" }),
    );
  }
});

const runtimeUrl = (host: string) => `postgres://admin:private-secret@${host}:6432/app`;

test("doctor --pooled-urls: a runtime URL on a transaction pooler passes pooled_runtime, a direct one fails it", async () => {
  for (const [host, ok] of [["pooler.example", true], ["direct.example", false]] as const) {
    const { app, fake } = fixture({});
    const result = await doctor(app, { pooledUrls: runtimeUrl(host) });
    await app.close();
    expect(result.checks).toContainEqual(expect.objectContaining({ target: "db0", check: "pooled_runtime", ok }));
    expect(result.externalChecks.map((item) => item.check)).not.toContain("pooled_runtime");
    expect(fake.pools.every((pool) => pool.closed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-secret");
  }
});

test("without --pooled-urls the pooled runtime requirement is reported as unverified and does not change ok", async () => {
  const result = await run({});
  expect(result.ok).toBe(true);
  expect(result.externalChecks).toContainEqual(expect.objectContaining({ check: "pooled_runtime", status: "unverified" }));
  expect(result.checks.map((item) => item.check)).not.toContain("pooled_runtime");
});

test("--pooled-urls must list exactly one URL per database", async () => {
  const { app } = fixture({});
  await expect(doctor(app, { pooledUrls: `${runtimeUrl("pooler.example")},${runtimeUrl("direct.example")}` })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  await app.close();
});

test("the effective_pgbouncer_mode note applies only when PgBouncer is used", async () => {
  const result = await run({});
  expect(result.externalChecks.find((item) => item.check === "effective_pgbouncer_mode")?.detail).toStartWith("If PgBouncer is used");
});

test("timeout_alignment: PgBouncer's query_wait_timeout must exceed statementTimeoutMs + 1.5 s (0 disables the wait limit)", async () => {
  const url = "postgres://admin:private-secret@localhost/pgbouncer";
  for (const [wait, ok] of [["8", true], ["6", false], ["0", true], ["120", true]] as const) {
    const result = await run({ console: { query_wait_timeout: wait } }, url);
    expect(result.checks).toContainEqual(expect.objectContaining({ target: "pgbouncer", check: "timeout_alignment", ok }));
  }
  // The default of 5000 ms needs more than 6.5 s: 7 s passes, 6 s fails.
  expect((await run({ console: { query_wait_timeout: "7" } }, url)).checks).toContainEqual(expect.objectContaining({ check: "timeout_alignment", ok: true }));
});

test("connection_budget: the pooler's and PostgreSQL's real sizes are checked against the deployment shape", async () => {
  const url = "postgres://admin:private-secret@localhost/pgbouncer";
  const budget = { appInstances: 40, poolMax: 5, poolers: 2 };
  const check = async (options: Parameters<typeof fixture>[0], shape = budget) => {
    const { app, fake } = fixture(options);
    const result = await doctor(app, { pgbouncerUrl: url, consoleDriver: fake.driver, budget: shape });
    await app.close();
    expect(JSON.stringify(result)).not.toContain("private-secret");
    return result.checks.find((item) => item.check === "connection_budget");
  };
  expect(await check({})).toMatchObject({ target: "db0", ok: true, detail: expect.stringContaining("200/1000 client connections") });
  expect(await check({ maxConnections: 60 })).toMatchObject({ ok: false, detail: expect.stringContaining("server connections") });
  expect(await check({}, { ...budget, appInstances: 400 })).toMatchObject({ ok: false, detail: expect.stringContaining("client connections") });
});

test("the connection budget needs the pooler console: without --pgbouncer-url it is a usage error, and no budget means no budget check", async () => {
  const { app } = fixture({});
  await expect(doctor(app, { budget: { appInstances: 1, poolMax: 1, poolers: 1 } })).rejects.toMatchObject({ code: "USAGE" });
  await app.close();
  expect((await run({}, "postgres://admin:private-secret@localhost/pgbouncer")).checks.map((item) => item.check)).not.toContain("connection_budget");
});
