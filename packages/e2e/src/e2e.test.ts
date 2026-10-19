/** End-to-end tests: `bun run test:e2e` brings up the stack, runs this file and does `down -v` in every case. Skipped without
 * `RUN_E2E=1`. The stack is driven from the host with docker compose commands and HTTP (Host: <tenant>.e2e.test); the tests run in
 * order on the same state. Measurements go to results/e2e-latest.json, the k6 summary to results/k6-summary.json. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Placement } from "@0furkancolak/pgcells";

const enabled = process.env.RUN_E2E === "1";
const e2e = enabled ? test : test.skip;
const DIR = join(import.meta.dir, "..");
const WORK = join(DIR, ".work"); // /work in the migrate container
const RESULTS = join(DIR, "results");
const BASE = "http://127.0.0.1:18080";
const MIGRATION_MODULE = "/repo/packages/e2e/src/app-migrations/legacy.ts";

const results: Record<string, Record<string, unknown>> = {};
const record = (scenario: string, values: Record<string, unknown>) => {
  results[scenario] = { ...results[scenario], ...values };
};

async function run(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd: DIR, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}
const compose = (...args: string[]) => run(["docker", "compose", "-p", "repo-e2e", ...args]);

/** CLI management command (direct URLs, compose network). Report events and the result are printed back to back: the last top-level JSON is the result. */
async function cli<T = Record<string, unknown>>(...args: string[]) {
  const started = Date.now();
  const { code, out, err } = await compose("run", "--rm", "--no-deps", "-T", "migrate", "bun", "run", "--cwd", "packages/db-multi", "cli", ...args);
  const lines = out.split("\n");
  const start = lines.findLastIndex((line) => /^[[{]/.test(line));
  const json = (start < 0 ? undefined : JSON.parse(lines.slice(start).join("\n"))) as T;
  const failure = err.split("\n").findLast((line) => line.startsWith('{"error"'));
  return { code, json, error: failure ? (JSON.parse(failure) as { error: string }).error : undefined, ms: Date.now() - started, out, err };
}

async function http<T = Record<string, unknown>>(host: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { Host: host.includes(".") ? host : `${host}.e2e.test`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // plain-text response
    }
    const cookies = res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    return { status: res.status, json: json as T, ms: ms(), cookies };
  } catch {
    return { status: 0, json: undefined as T, ms: ms(), cookies: "" };
  }
}

const count = async (tenant: string) => (await http<{ count: number }>(tenant, "GET", "/users/count")).json.count;
const psql = (service: "postgres-0" | "postgres-1", sql: string) =>
  compose("exec", "-T", service, "psql", "-U", "admin", "-d", "app", "-v", "ON_ERROR_STOP=1", "-Atc", sql);

/** Checks that the command (CLI, compose, psql) finished successfully; returns the result. */
function expectCliOk<T extends { code: number }>(result: T): T {
  expect(result.code).toBe(0);
  return result;
}

/** Waits until `check` is true; returns the elapsed ms. */
async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number, stepMs = 200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return Date.now() - started;
    await Bun.sleep(stepMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms: ${what}`);
}

beforeAll(async () => {
  if (!enabled) return;
  mkdirSync(WORK, { recursive: true });
  for (const entry of readdirSync(WORK)) rmSync(join(WORK, entry), { recursive: true, force: true });
  record("stack", { readyMs: await waitFor("/ready 200", async () => (await http("ready", "GET", "/ready")).status === 200, 120_000) });
});

afterAll(async () => {
  if (!enabled) return;
  const ids = (await compose("ps", "-q")).out.split("\n").filter(Boolean);
  const docker = async (...args: string[]) => (ids.length ? (await run(["docker", ...args, ...ids])).out.trim().split("\n") : []);
  const containers = {
    stats: await docker("stats", "--no-stream", "--format", "{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}"),
    state: await docker("inspect", "--format", "{{.Name}} oomKilled={{.State.OOMKilled}} restarts={{.RestartCount}}"),
    lockWaits: (await compose("logs", "--no-log-prefix", "postgres-0", "postgres-1")).out.split("\n").filter((line) => /still waiting|acquired .*lock after/.test(line)),
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, "e2e-latest.json"), `${JSON.stringify({ finishedAt: new Date().toISOString(), results, containers }, null, 1)}\n`);
});

e2e("provision: size-based placement, reserved id refused", async () => {
  const kadikoy = await cli<Placement>("provision", "kadikoy", "--size", "20");
  expectCliOk(kadikoy);
  expect(kadikoy.json).toMatchObject({ tenantId: "kadikoy", databaseId: "db0", status: "active", schemaName: "tenant_kadikoy" });
  // Load db0 = 20, db1 = 0: (0 + 10) / 1000 is the lowest ratio → db1.
  const moda = await cli<Placement>("provision", "moda", "--size", "10");
  expect(moda.json).toMatchObject({ databaseId: "db1", status: "active" });
  // db0 = 20, db1 = 10 → db1.
  const sisli = await cli<Placement>("provision", "sisli");
  expect(sisli.json).toMatchObject({ databaseId: "db1", status: "active" });

  const www = await cli("provision", "www");
  expect(www.code).toBe(1);
  expect(www.error).toBe("TENANT_RESERVED");
  const databases = await cli<{ databaseId: string; tenants: number; load: number }[]>("databases");
  expectCliOk(databases);
  expect(databases.json).toMatchObject([
    { databaseId: "db0", tenants: 1, load: 20 },
    { databaseId: "db1", tenants: 2, load: 11 },
  ]);
  expect((await http("kadikoy", "GET", "/users")).status).toBe(200);
  record("provision", { kadikoyMs: kadikoy.ms, modaMs: moda.ms, sisliMs: sisli.ms, databases: databases.json });
});

e2e("tenant isolation: same id in two tenants, unknown hosts", async () => {
  const id = crypto.randomUUID();
  // Same id → same derived email: 201 in both tenants, a repeat in the same tenant is 23505 → 409.
  expect((await http("kadikoy", "POST", "/users", { id, name: "Kadikoy user" })).status).toBe(201);
  expect((await http("moda", "POST", "/users", { id, name: "Moda user" })).status).toBe(201);
  expect((await http("kadikoy", "POST", "/users", { id, name: "again" })).status).toBe(409);

  expect((await http("kadikoy", "GET", `/users/${id}`)).json).toMatchObject({ id, name: "Kadikoy user" });
  expect((await http("moda", "GET", `/users/${id}`)).json).toMatchObject({ id, name: "Moda user" });
  expect((await http("sisli", "GET", `/users/${id}`)).status).toBe(404);

  const unknown = await http("yok.e2e.test", "GET", "/users");
  expect(unknown).toMatchObject({ status: 404, json: { error: "TENANT_NOT_FOUND" } });
  expect(await http("www.e2e.test", "GET", "/users")).toMatchObject({ status: 404, json: { error: "TENANT_NOT_FOUND" } });
  expect(await http("kadikoy.other.test", "GET", "/users")).toMatchObject({ status: 400, json: { error: "INVALID_TENANT_ID" } });
  expect(await http("a.kadikoy.e2e.test", "GET", "/users")).toMatchObject({ status: 400, json: { error: "INVALID_TENANT_ID" } });
});

e2e("Better Auth: sign-up/sign-in per tenant, sessions do not cross tenants", async () => {
  const user = { email: "ogretmen@kadikoy.example", password: "guclu-parola-123", name: "Teacher" };
  const signUp = await http("kadikoy", "POST", "/api/auth/sign-up/email", user);
  expect(signUp.status).toBe(200);
  const signIn = await http("kadikoy", "POST", "/api/auth/sign-in/email", { email: user.email, password: user.password });
  expect(signIn.status).toBe(200);
  expect(signIn.cookies).toContain("kadikoy.session_token=");
  expect(signIn.cookies).not.toContain("tenant_kadikoy.");

  expect(await http("kadikoy", "GET", "/me", undefined, { cookie: signIn.cookies })).toMatchObject({ status: 200, json: { email: user.email } });
  expect((await http("moda", "GET", "/me", undefined, { cookie: signIn.cookies })).status).toBe(401);
  expect((await http("moda", "POST", "/api/auth/sign-in/email", { email: user.email, password: user.password })).status).toBe(401);
  record("auth", { signUpMs: signUp.ms, signInMs: signIn.ms });
});

e2e("queue: enqueue → worker writes to tenant schema → visible via app; cron loop counts every tenant", async () => {
  const started = Date.now();
  const id = crypto.randomUUID();
  expect((await http("kadikoy", "POST", "/jobs/users", { id, name: "Queue user" })).status).toBe(202);
  await waitFor("job row", async () => (await http("kadikoy", "GET", `/users/${id}`)).status === 200, 20_000, 100);
  const queueToRowMs = Date.now() - started;
  expect((await http("moda", "GET", `/users/${id}`)).status).toBe(404);
  expect((await http("yok.e2e.test", "POST", "/jobs/users", { name: "x" })).status).toBe(404);

  const expected = await count("kadikoy");
  let cron: { at: string; ms: number; counts: Record<string, number | string> } | undefined;
  const cronMs = await waitFor(
    "cron counts",
    async () => {
      cron = JSON.parse((await compose("exec", "-T", "redis", "redis-cli", "GET", "g:e2e:cron")).out || "null");
      return !!cron && Date.parse(cron.at) > started && cron.counts.kadikoy === expected;
    },
    20_000,
    500,
  );
  expect(cron?.counts).toMatchObject({ kadikoy: expected, moda: 1, sisli: 0 });
  record("queue", { queueToRowMs, cronMs, cronTickMs: cron?.ms });
});

e2e("users import: JSONL with bcrypt hashes, rerun is idempotent, imported user signs in", async () => {
  const passwordHash = await Bun.password.hash("eski-parola", { algorithm: "bcrypt", cost: 4 });
  const rows = [
    { externalId: 1, email: "eski1@moda.example", name: "Old One", passwordHash },
    { externalId: "2", email: "ESKI2@moda.example", name: "Old Two" },
    { externalId: 3, email: "gecersiz-eposta" },
  ];
  writeFileSync(join(WORK, "users.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const first = await cli("users", "import", "moda", "--source", "eski-panel", "--file", "/work/users.jsonl");
  expectCliOk(first);
  expect(first.json).toMatchObject({ read: 3, invalid: 1, created: 2 });
  const again = await cli("users", "import", "moda", "--source", "eski-panel", "--file", "/work/users.jsonl");
  expect(again.json).toMatchObject({ created: 0, updated: 0, unchanged: 2 });

  expect((await http("moda", "POST", "/api/auth/sign-in/email", { email: "eski1@moda.example", password: "eski-parola" })).status).toBe(200);
  expect((await http("moda", "POST", "/api/auth/sign-in/email", { email: "eski1@moda.example", password: "yanlis" })).status).toBe(401);
  expect((await http("kadikoy", "POST", "/api/auth/sign-in/email", { email: "eski1@moda.example", password: "eski-parola" })).status).toBe(401);
  record("usersImport", { firstMs: first.ms, againMs: again.ms });
});

e2e("dump split + app-migrate: pg_dump file → tenant tables, dry-run writes nothing, rerun is idempotent", async () => {
  type Steps = { steps: { table: string; read: number; skipped: number; written: number }[] };
  const written = (result: Steps) => Object.fromEntries(result.steps.map((step) => [step.table, step.written]));
  const split = await cli<{ tables: Record<string, { rows: number }> }>("dump", "split", "/fixtures/legacy.sql", "/work/legacy");
  expectCliOk(split);
  expect(split.json.tables).toMatchObject({ uyeler: { rows: 2 }, dersler: { rows: 2 }, ogrenciler: { rows: 3 }, kayitlar: { rows: 4 } });

  const usersBefore = await count("kadikoy");
  const dry = await cli<Steps>("app-migrate", "kadikoy", "/work/legacy", "--file", MIGRATION_MODULE, "--dry-run");
  expectCliOk(dry);
  expect(written(dry.json)).toMatchObject({ ogrenciler: 0 });
  expect(await count("kadikoy")).toBe(usersBefore);

  const real = await cli<Steps>("app-migrate", "kadikoy", "/work/legacy", "--file", MIGRATION_MODULE);
  expectCliOk(real);
  expect(written(real.json)).toEqual({ uyeler: 1, ogrenciler: 3 });
  expect(real.json.steps[0]).toMatchObject({ read: 2, skipped: 1 });
  const again = await cli<Steps>("app-migrate", "kadikoy", "/work/legacy", "--file", MIGRATION_MODULE);
  expect(written(again.json)).toEqual({ uyeler: 0, ogrenciler: 0 });

  expect(await count("kadikoy")).toBe(usersBefore + 4);
  const names = (await http<{ name: string }[]>("kadikoy", "GET", "/users?limit=1000")).json.map((s) => s.name);
  expect(names).toEqual(expect.arrayContaining(["Ay\u015Fe Demir", "Mehmet Kaya", "Zeynep O'Brien"]));
  // Sign-in with the bcrypt hash from the dump (importedPasswords).
  expect((await http("kadikoy", "POST", "/api/auth/sign-in/email", { email: "veli@eski.example", password: "eski-parola" })).status).toBe(200);
  record("appMigrate", { splitMs: split.ms, dryRunMs: dry.ms, migrateMs: real.ms, rerunMs: again.ms });
});

e2e("backup: full set, incremental unchanged detection, export, restore refuses active tenant, disaster restore", async () => {
  type Backup = { id: string; full: boolean; tenants: number; written: number; unchanged: number; failed: number };
  type Manifest = { tenants: Record<string, { set: string; rows: number }> };
  const manifest = (id: string) => JSON.parse(readFileSync(join(WORK, "backups", id, "manifest.json"), "utf8")) as Manifest;
  // PostgreSQL statistics counters are flushed up to 10 s late by an idle backend (README): let the earlier writes settle.
  await Bun.sleep(11_000);
  const full = await cli<Backup>("backup", "/work/backups", "--full");
  expectCliOk(full);
  expect(full.json).toMatchObject({ full: true, tenants: 3, written: 3, unchanged: 0, failed: 0 });
  await Bun.sleep(1_100); // the set ID has one-second resolution
  const unchanged = await cli<Backup>("backup", "/work/backups");
  expect(unchanged.json).toMatchObject({ full: false, tenants: 3, written: 0, unchanged: 3, failed: 0 });

  for (let i = 0; i < 3; i++) expect((await http("moda", "POST", "/users", { name: `after backup ${i}` })).status).toBe(201);
  await Bun.sleep(11_000);
  const changed = await cli<Backup>("backup", "/work/backups");
  expect(changed.json).toMatchObject({ full: false, written: 1, unchanged: 2, failed: 0 });
  const sets = manifest(changed.json.id).tenants;
  expect(sets.moda?.set).toBe(changed.json.id);
  expect(sets.kadikoy?.set).toBe(full.json.id);
  expect(sets.moda?.rows).toBeGreaterThan(manifest(full.json.id).tenants.moda?.rows ?? 0);

  const exported = await cli<{ rows: number }>("export", "kadikoy", "/work/export-kadikoy");
  expectCliOk(exported);
  expect(exported.json.rows).toBeGreaterThan(0);
  const refused = await cli("restore", "kadikoy", "/work/export-kadikoy");
  expect(refused.code).toBe(1);
  expect(refused.error).toBe("TENANT_EXISTS");

  // Disaster simulation (psql, not the package API): sisli's schema and platform record are lost and it is restored from the backup.
  for (let i = 0; i < 5; i++) expect((await http("sisli", "POST", "/users", { name: `sisli ${i}` })).status).toBe(201);
  const before = await count("sisli");
  await Bun.sleep(1_100);
  const sisliSet = await cli<Backup>("backup", "/work/backups", "--full", "--tenants", "sisli");
  expect(sisliSet.json).toMatchObject({ written: 1, failed: 0 });
  expectCliOk(await psql("postgres-1", "DROP SCHEMA tenant_sisli CASCADE"));
  expectCliOk(await psql("postgres-0", "DELETE FROM platform.placements WHERE tenant_id = 'sisli'; DELETE FROM platform.tenants WHERE tenant_id = 'sisli'"));
  const gone = await waitFor("sisli 404", async () => (await http("sisli", "GET", "/users/count")).status === 404, 20_000);
  const restored = await cli<{ placement: Placement; rows: number }>("restore", "sisli", "/work/backups");
  expectCliOk(restored);
  expect(restored.json.placement).toMatchObject({ tenantId: "sisli", status: "active" });
  const back = await waitFor("sisli restored", async () => (await count("sisli")) === before, 20_000);
  record("backup", {
    fullMs: full.ms, incrementalUnchangedMs: unchanged.ms, incrementalChangedMs: changed.ms, exportMs: exported.ms,
    restoreMs: restored.ms, restoredRows: restored.json.rows, notFoundAfterLossMs: gone, servedAfterRestoreMs: back,
  });
});

e2e("readiness: db1 down → /ready 503 DATABASE_UNAVAILABLE, db0 tenants keep serving; db1 up → 200", async () => {
  expectCliOk(await compose("stop", "postgres-1"));
  // Every /ready call is recorded: when PgBouncer is left without a server, the answer arrives at the package's response deadline
  // (statementTimeoutMs 5 s + 1 s margin + at most a 250 ms scan interval + 500 ms cancel wait + margin).
  const READY_ANSWER_MAX_MS = 5_000 + 1_000 + 250 + 500 + 250;
  /** A "database down" answer takes only two forms, within the deadline: 503 DATABASE_UNAVAILABLE or 504 DATABASE_TIMEOUT.
   * TENANT_UNAVAILABLE, DATABASE_BUSY or a 503 without a code is a regression. */
  const downAnswer = ({ status, ms, error }: { status: number; ms: number; error?: string }) =>
    ((status === 503 && error === "DATABASE_UNAVAILABLE") || (status === 504 && error === "DATABASE_TIMEOUT")) && ms < READY_ANSWER_MAX_MS;
  const readyCalls: { status: number; ms: number; error?: string }[] = [];
  let downMs: number;
  let db0: Awaited<ReturnType<typeof http>>;
  let db1: Awaited<ReturnType<typeof http<{ error: string }>>>;
  let db1Again: Awaited<ReturnType<typeof http>>;
  try {
    downMs = await waitFor(
      "/ready 503 DATABASE_UNAVAILABLE",
      async () => {
        const res = await http<{ error?: string }>("ready", "GET", "/ready");
        readyCalls.push({ status: res.status, ms: res.ms, error: res.json?.error });
        return res.status === 503 && res.json.error === "DATABASE_UNAVAILABLE";
      },
      60_000,
    );
    expect(readyCalls.filter((call) => !downAnswer(call))).toEqual([]);
    db0 = await http("kadikoy", "GET", "/users/count");
    expect(db0.status).toBe(200);
    // A tenant of the down database does not hang; it gets a "database down" answer. Which one depends on PgBouncer: if it refuses
    // the down server or closes the connection, 503 DATABASE_UNAVAILABLE (08P01, ERR_POSTGRES_CONNECTION_CLOSED … collapse into this
    // code in the app); if it waits to connect, the package's response deadline → 504 DATABASE_TIMEOUT.
    db1 = await http<{ error: string }>("moda", "GET", "/users/count");
    expect(downAnswer({ ...db1, error: db1.json?.error }), JSON.stringify({ db1: { status: db1.status, ms: db1.ms, json: db1.json }, readyCalls })).toBe(true);
    db1Again = await http<{ error: string }>("moda", "GET", "/users/count");
    expect(downAnswer({ ...db1Again, error: (db1Again.json as { error?: string } | undefined)?.error }), JSON.stringify({ status: db1Again.status, ms: db1Again.ms, json: db1Again.json })).toBe(true);
  } finally {
    // Even if an assertion fails, db1 comes back: later scenarios (move, restart, k6) do not fail in a chain because of the down database.
    expectCliOk(await compose("start", "postgres-1"));
  }

  const upMs = await waitFor("/ready 200", async () => (await http("ready", "GET", "/ready")).status === 200, 90_000, 500);
  const modaMs = await waitFor("moda 200", async () => (await http("moda", "GET", "/users/count")).status === 200, 90_000, 500);
  record("readiness", {
    downDetectedMs: downMs, readyCalls, db0TenantStatus: db0.status, db1TenantStatus: db1.status, db1TenantError: db1.json.error,
    db1FirstRequestMs: db1.ms, db1SecondRequestMs: db1Again.ms, readyAfterStartMs: upMs, db1TenantRecoveredMs: upMs + modaMs,
  });
});

e2e("move under traffic: writers drained, CLI move kadikoy → db1, cache refresh, no rows lost", async () => {
  const before = await count("kadikoy");
  const ids: string[] = [];
  const failures: number[] = [];
  const writeFor = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const id = crypto.randomUUID();
      const res = await http("kadikoy", "POST", "/users", { id, name: "writer" });
      if (res.status === 201) ids.push(id);
      else failures.push(res.status);
    }
  };
  await writeFor(3_000);
  const beforeMove = ids.length;

  // The writers have stopped; reads continue throughout the move.
  let reading = true;
  const reads: Record<string, number> = {};
  const reader = (async () => {
    while (reading) {
      const res = await http("kadikoy", "GET", "/users/count");
      reads[res.status] = (reads[res.status] ?? 0) + 1;
      await Bun.sleep(50);
    }
  })();
  const baseline = await cli("status", "kadikoy"); // compose run + CLI startup (to separate it from the move duration)
  const move = await cli<{ status: string }>("move", "kadikoy", "db1", "--writers-drained");
  const moved = Date.now();
  expectCliOk(move);
  expect(move.json.status).toBe("completed");
  // After the placement becomes `migrating`, the move waits placementCacheWaitMs (30 s) so that the caches expire.
  expect(move.ms).toBeGreaterThanOrEqual(30_000);
  const refreshMs = await waitFor("app resolves db1", async () => (await http<{ databaseId: string }>("kadikoy", "GET", "/where")).json.databaseId === "db1", 30_000, 100);
  reading = false;
  await reader;

  // During the move, reads either return the old (unchanged) data or, once the cache has expired, 503 TENANT_UNAVAILABLE; no errors.
  expect(Object.keys(reads).filter((status) => !["200", "503"].includes(status))).toEqual([]);
  await writeFor(3_000);
  expect(failures).toEqual([]);
  expect(await count("kadikoy")).toBe(before + ids.length);
  for (const id of ids) expect((await http("kadikoy", "GET", `/users/${id}`)).status).toBe(200);
  // The source schema is not dropped automatically; it keeps the rows from the moment of the move.
  expect((await psql("postgres-0", "SELECT count(*) FROM tenant_kadikoy.users")).out.trim()).toBe(String(before + beforeMove));
  // The worker sees the new database too.
  const jobId = crypto.randomUUID();
  expect((await http("kadikoy", "POST", "/jobs/users", { id: jobId, name: "job after move" })).status).toBe(202);
  await waitFor("job after move", async () => (await http("kadikoy", "GET", `/users/${jobId}`)).status === 200, 20_000);
  record("move", { moveResult: move.json, cliBaselineMs: baseline.ms, moveCliMs: move.ms,refreshAfterMoveMs: refreshMs, placementCacheWaitMs: 30_000, cacheBoundMs: 5_000 + 2_000, rowsBeforeMove: beforeMove, rowsAfterMove: ids.length - beforeMove, readsDuringMove: reads, sinceMoveMs: Date.now() - moved });
});

e2e("restart resilience: PgBouncer restart, Redis down (fail-open) and back", async () => {
  expectCliOk(await compose("restart", "pgbouncer"));
  const restarted = Date.now();
  let failed = 0;
  await waitFor(
    "requests after PgBouncer restart",
    async () => {
      const ok = (await http("moda", "GET", "/users/count")).status === 200;
      if (!ok) failed++;
      return ok;
    },
    30_000,
    100,
  );
  const pgbouncerMs = Date.now() - restarted;
  for (let i = 0; i < 20; i++) expect((await http(i % 2 ? "moda" : "kadikoy", "GET", "/users/count")).status).toBe(200);

  expectCliOk(await compose("stop", "redis"));
  const warm = await http("kadikoy", "GET", "/users/count");
  expect(warm.status).toBe(200);
  await Bun.sleep(2_500); // the local placement entry (localTtlMs 2000) expires: Redis is unreachable, so it reads from the database
  const cold = await http("kadikoy", "GET", "/users/count");
  expect(cold.status).toBe(200);
  const insert = await http("kadikoy", "POST", "/users", { name: "redis down" });
  expect(insert.status).toBe(201);

  expectCliOk(await compose("start", "redis"));
  const started = Date.now();
  const jobId = crypto.randomUUID();
  await waitFor("enqueue after Redis start", async () => (await http("kadikoy", "POST", "/jobs/users", { id: jobId, name: "redis back" })).status === 202, 30_000, 500);
  await waitFor("job row after Redis start", async () => (await http("kadikoy", "GET", `/users/${jobId}`)).status === 200, 30_000, 200);
  record("restart", { pgbouncerRecoveryMs: pgbouncerMs, failedRequestsDuringPgbouncerRestart: failed, redisDownWarmMs: warm.ms, redisDownColdMs: cold.ms, redisDownInsertMs: insert.ms, queueRecoveredAfterRedisStartMs: Date.now() - started });
});

e2e("k6: 200 rps for 10 s on read and insert routes", async () => {
  if (!Bun.which("k6")) {
    record("k6", { skipped: "k6 is not installed" });
    console.warn("k6 not installed; skipping load test");
    return;
  }
  mkdirSync(RESULTS, { recursive: true });
  const summaryFile = join(RESULTS, "k6-summary.json");
  const before = await count("moda");
  const k6 = await run(["k6", "run", "--quiet", "--summary-export", summaryFile, "k6/load.js"], { BASE_URL: BASE, READ_TENANT: "kadikoy", INSERT_TENANT: "moda" });
  type Metric = Record<string, number>;
  const { metrics } = JSON.parse(readFileSync(summaryFile, "utf8")) as { metrics: Record<string, Metric> };
  const route = (name: string) => ({
    requests: metrics[`iterations{route:${name}}`]?.count,
    failedRate: metrics[`http_req_failed{route:${name}}`]?.value,
    p50Ms: metrics[`http_req_duration{route:${name}}`]?.med,
    p95Ms: metrics[`http_req_duration{route:${name}}`]?.["p(95)"],
    p99Ms: metrics[`http_req_duration{route:${name}}`]?.["p(99)"],
    maxMs: metrics[`http_req_duration{route:${name}}`]?.max,
  });
  const inserted = metrics.inserted?.count ?? 0;
  const summary = { exitCode: k6.code, read: route("read"), insert: route("insert"), inserted, droppedIterations: metrics.dropped_iterations?.count ?? 0 };
  record("k6", summary);
  expect(summary.read.failedRate).toBeLessThan(0.01);
  expect(summary.insert.failedRate).toBeLessThan(0.01);
  expect(await count("moda")).toBe(before + inserted);
});
