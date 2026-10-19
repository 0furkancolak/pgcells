/** Scale benchmark (`bun run bench:scale`): data generation, queries, migrations, seeds and tenant moves. Phases (`--phase`):
 *  tenants  on the load cluster (after `bench --phase setup`: 10,000 tenants): migrateAll with nothing pending (xact deltas against an idle
 *           window of the same length), demo provision/reset, migrateAll with one new pending migration at concurrency 16 and 64,
 *           seedAll with a new install seed, bulk seed on a 1M-row tenant, `tools move` of 1M- and 10M-row tenants
 *  big      per size (`--sizes`; rows = `users` rows) on a clean cluster: load time per `--load-tiers`
 *           and disk size, then runtime queries and migrations on the big tenant per `--tiers` (constant default,
 *           rewrite, CREATE INDEX CONCURRENTLY under k6 writes, migrate-down)
 * Bench-specific migrations and seeds never touch src/migrations or src/seeds: each experiment runs from a temporary copy of the package
 * ($BENCH_RAW_DIR/packages/<name>) with extra files and regenerated lists; the copy's own scale.ts runs the step
 * (`--child`), so the imported registry is the copy's. Row generation is server-side psql (bypasses the API); queries,
 * provision, migration, seed and move go through the package.
 * 1B (separate run): --phase big --sizes 1000000000 --tiers T4 --load-tiers T4 --storage /Volumes/DEVNAFRU/repo-db-bench-1b */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createConfig, createDatabase, errorCode, type PreparedQuery } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import {
  bootstrap, createManagement, type Management, type ManagementOptions, migrateAll, migrateTenant, prepareQuery, provisionTenant, resetDemoTenant,
  rollbackTenant, seedAll, seedTenant,
} from "@0furkancolak/pgcells/management";
import {
  dataDirSize, diffStat, directUrls, diskFree, distribution, environment, IMAGES, k6, list, loadResult, log, messageOf, NAMES, PACKAGE_DIR,
  pgStat, psql, psqlScript, RAW_DIR, RESULTS_DIR, round, rowsSql, saveResult, segment, sh, shAsync, stamp, startApp, startBouncer, startPostgres,
  stopAll, stopContainer, type TierName, TIERS, timeIt, uuidOf,
} from "./lib";

const { values: flags } = parseArgs({
  options: {
    child: { type: "string" },
    phase: { type: "string", default: "tenants,big" },
    run: { type: "string" },
    tiers: { type: "string", default: "T4,T2" },
    sizes: { type: "string", default: "1000000,10000000,100000000" },
    "load-tiers": { type: "string", default: "T2,T4" },
    "max-t2-load-rows": { type: "string", default: "10000000" },
    storage: { type: "string" },
    "min-free-gib": { type: "string", default: "20" },
    "migration-timeout-ms": { type: "string", default: "3600000" },
    driver: { type: "string", default: "bun" },
    "load-volume": { type: "string", default: "repo-db-bench-load" },
    "scale-volume": { type: "string", default: "repo-db-bench-scale" },
    keep: { type: "boolean", default: false },
  },
});
const RAISED: ManagementOptions = { migrationStatementTimeoutMs: Number(flags["migration-timeout-ms"]) };
const label = (rows: number) => (rows >= 1e9 ? `${rows / 1e9}b` : `${rows / 1e6}m`);

// ---- Child steps (run inside the package copy) -----------------------------------------

type StepName = "migrate-tenant" | "rollback" | "migrate-all" | "seed-all" | "seed-tenant" | "provision" | "provision-demo" | "reset-demo" | "move";
type ChildStep = {
  step: StepName;
  urls: string[];
  tenant?: string;
  tenants?: string[];
  database?: string;
  steps?: number;
  concurrency?: number;
  perDatabaseConcurrency?: number;
  options?: ManagementOptions;
};
type ChildResult = {
  ms: number;
  wallMs: number;
  error?: string;
  output?: unknown;
  events: { perTenant?: ReturnType<typeof distribution>; failedByCode: Record<string, number>; migrationsStarted: number; sessionsAcquired: number; steps: unknown[] };
  maxRssMiB: number;
  locks?: { maxLocks: number; maxWaitingLocks: number; maxClientBackends: number; samples: number };
};
type ChildEvent = Record<string, unknown>;

/** Shared inputs of the child steps: management, step, tenant, event reporter, bulk options and a per-tenant stopwatch. */
function childContext(m: Management, step: ChildStep, events: ChildEvent[]) {
  const report = (event: ChildEvent) => void events.push(event);
  return {
    m, step, report,
    tenant: step.tenant ?? "",
    batch: { concurrency: step.concurrency, perDatabaseConcurrency: step.perDatabaseConcurrency, continueOnError: true, report },
    timed: async (work: (id: string) => Promise<unknown>) => {
      const ms: number[] = [];
      for (const id of step.tenants ?? []) ms.push(await timeIt(() => work(id)));
      return distribution(ms);
    },
  };
}
type ChildContext = ReturnType<typeof childContext>;

const CHILD_STEPS: Record<StepName, (context: ChildContext) => Promise<unknown>> = {
  "migrate-tenant": ({ m, tenant, report }) => migrateTenant(m, tenant, { report }),
  rollback: ({ m, tenant, step, report }) => rollbackTenant(m, tenant, { steps: step.steps, report }),
  "migrate-all": ({ m, batch }) => migrateAll(m, batch),
  "seed-all": ({ m, batch }) => seedAll(m, { ...batch, profile: "install" }),
  "seed-tenant": ({ m, tenant, report }) => seedTenant(m, tenant, { report }),
  provision: ({ m, step, timed }) => timed((id) => provisionTenant(m, id, step.database)),
  "provision-demo": ({ m, step, timed }) => timed((id) => provisionTenant(m, id, step.database, { demo: true })),
  "reset-demo": ({ m, timed }) => timed((id) => resetDemoTenant(m, id)),
  move: async ({ m, tenant, step }) => {
    // Programmatic fallback path with raised management timeouts; the CLI (`tools move`) cannot pass options.
    const { startMove } = await import("../../core/tools/move");
    const move = await startMove(m, tenant, step.database ?? "", true);
    return { status: move.status, phase: move.phase };
  },
};

async function childMain(json: string) {
  const step = JSON.parse(json) as ChildStep;
  const m = createManagement(createConfig(step.urls), { driver: bunDriver, ...step.options });
  const events: ChildEvent[] = [];
  let output: unknown;
  let error: string | undefined;
  const started = performance.now();
  try {
    output = await CHILD_STEPS[step.step](childContext(m, step, events));
  } catch (e) {
    error = errorCode(e) ?? messageOf(e);
  } finally {
    await m.close().catch(() => {});
  }
  const ms = performance.now() - started;
  const result = {
    ms: round(ms, 1), error, output, events: eventSummary(step, events),
    // On macOS Bun reports maxRSS in bytes (getrusage), on Linux in KiB.
    maxRssMiB: round(process.resourceUsage().maxRSS / (process.platform === "darwin" ? 1048576 : 1024), 1),
  };
  console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
}

/** Per-tenant durations from the report events, errors by code, started migrations, sessions taken and (for a single tenant) steps. */
function eventSummary(step: ChildStep, events: ChildEvent[]) {
  const tenantDone = events.filter((e) => e.status === "succeeded" && !e.migration && !e.seed && typeof e.durationMs === "number");
  const failedByCode: Record<string, number> = {};
  for (const e of events.filter((e) => e.status === "failed" && !e.migration && !e.seed)) failedByCode[String(e.error)] = (failedByCode[String(e.error)] ?? 0) + 1;
  return {
    perTenant: tenantDone.length ? distribution(tenantDone.map((e) => e.durationMs as number)) : undefined, failedByCode,
    migrationsStarted: events.filter((e) => e.status === "started" && e.migration).length,
    sessionsAcquired: events.filter((e) => e.status === "session-acquired").length,
    steps: step.tenant ? events.filter((e) => (e.migration || e.seed) && e.status !== "started").map((e) => ({ id: e.migration ?? e.seed, status: e.status, durationMs: e.durationMs, error: e.error })) : [],
  };
}

/** Runs the step with the package at `pkg`; unless `pollLocks` is false, samples pg_locks / client backends every second. */
async function child(pkg: string, step: Omit<ChildStep, "urls">, { pollLocks = true } = {}): Promise<ChildResult> {
  log(`  child ${step.step} ${step.tenant ?? ""} ${step.concurrency ?? ""} (${pkg === PACKAGE_DIR ? "package" : pkg.split("/").at(-1)})`);
  const started = Date.now();
  const proc = Bun.spawn(["bun", join(pkg, "src/__tests__/bench/scale.ts"), "--child", JSON.stringify({ ...step, urls: directUrls() })], { cwd: pkg, stdout: "pipe", stderr: "pipe" });
  const locks = { maxLocks: 0, maxWaitingLocks: 0, maxClientBackends: 0, samples: 0 };
  let running = true;
  const poller = (async () => {
    while (running && pollLocks) {
      const out = await psqlScript("db0", "SELECT (SELECT count(*) FROM pg_locks), (SELECT count(*) FROM pg_locks WHERE NOT granted), (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend');").catch(() => "");
      const [all, waiting, backends] = out.trim().split("|").map(Number);
      if (all !== undefined && !Number.isNaN(all)) {
        locks.maxLocks = Math.max(locks.maxLocks, all);
        locks.maxWaitingLocks = Math.max(locks.maxWaitingLocks, waiting ?? 0);
        locks.maxClientBackends = Math.max(locks.maxClientBackends, backends ?? 0);
        locks.samples++;
      }
      await Bun.sleep(1000);
    }
  })();
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  running = false;
  await poller;
  const line = out.split("\n").findLast((l) => l.startsWith("BENCH_RESULT "));
  if (!line) throw new Error(`child ${step.step} exited ${code}: ${err.slice(-1500)}`);
  const result = { ...(JSON.parse(line.slice("BENCH_RESULT ".length)) as ChildResult), wallMs: Date.now() - started, ...(pollLocks && { locks }) };
  log(`  → ${result.ms} ms${result.error ? ` error ${result.error}` : ""}`);
  return result;
}

/** Package copy with extra tenant migrations / install seeds and regenerated lists (cached by name). */
function benchPackage(name: string, migrations: readonly (readonly [string, string])[], seeds: readonly (readonly [string, string])[] = []) {
  if (!migrations.length && !seeds.length) return PACKAGE_DIR;
  const root = join(RAW_DIR, "packages", name);
  if (existsSync(join(root, ".ready"))) return root;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  sh(["rsync", "-a", "--exclude", "node_modules", "--exclude", "dist", "--exclude", ".env", "--exclude", "src/__tests__/bench/results", `${PACKAGE_DIR}/`, `${root}/`]);
  symlinkSync(realpathSync(join(PACKAGE_DIR, "node_modules")), join(root, "node_modules"));
  for (const [id, sql] of migrations) writeFileSync(join(root, "src/migrations/tenant", `${id}.sql`), sql);
  for (const [id, sql] of seeds) writeFileSync(join(root, "src/seeds/install", `${id}.sql`), sql);
  sh(["bun", "src/core/sql/codegen.ts"], { cwd: root });
  writeFileSync(join(root, ".ready"), new Date().toISOString());
  return root;
}
const migration = (id: string, up: string, down: string) => [id, `--up\n${up}\n\n--down\n${down}\n`] as const;

// ---- Results ----------------------------------------------------------------------------

type Json = Record<string, unknown>;
interface ScaleResult {
  schema: string;
  run: string;
  startedAt: string;
  updatedAt?: string;
  environment: ReturnType<typeof environment>;
  settings: Json;
  tenants: Record<string, Json>;
  big: Record<string, Json & { tiers: Record<string, Json>; load: Record<string, Json>; notes: string[] }>;
  failures: { step: string; error: string; at: string }[];
  skipped: { step: string; reason: string }[];
  estimates: Json[];
  notes: string[];
}
const run = flags.run ?? stamp();
const file = join(RESULTS_DIR, `${run}-scale.json`);
let result: ScaleResult;
const save = () => {
  result.updatedAt = new Date().toISOString();
  saveResult(file, result);
};
/** Runs a named step once (resumable); errors are recorded, not thrown. */
async function step(bucket: Json, key: string, work: () => Promise<unknown>) {
  const existing = bucket[key] as Json | undefined;
  if (existing && !existing.stepError) return existing;
  log(`step ${key}`);
  const started = Date.now();
  let value: Json;
  try {
    value = { ...((await work()) as Json), stepSeconds: round((Date.now() - started) / 1000, 1) };
  } catch (error) {
    const message = messageOf(error, 800);
    value = { stepError: message, stepSeconds: round((Date.now() - started) / 1000, 1) };
    result.failures.push({ step: key, error: message, at: new Date().toISOString() });
    log(`STEP FAILED ${key}: ${message}`);
  }
  bucket[key] = value;
  save();
  return value;
}
const childFailed = (r: Json) => {
  if (r.error) result.failures.push({ step: String(r.label ?? "child"), error: String(r.error), at: new Date().toISOString() });
};

let pgTier: string | undefined;
async function ensurePostgres(tier: TierName, storage: string) {
  if (pgTier === `${tier}:${storage}` && sh(["docker", "inspect", "-f", "{{.State.Running}}", NAMES.pg], { allowFail: true }).out === "true") return;
  stopAll();
  const { readyMs } = await startPostgres(tier, storage);
  pgTier = `${tier}:${storage}`;
  log(`PostgreSQL ${tier} on ${storage} ready in ${readyMs} ms`);
}
const count = (db: string, sql: string) => Number(psql(db, sql));
const schemaOf = (tenant: string) => psql("db0", `SELECT schema_name FROM platform.placements WHERE tenant_id='${tenant}'`);
const databaseOf = (tenant: string) => psql("db0", `SELECT database_id FROM platform.placements WHERE tenant_id='${tenant}'`);

// ---- Phase: tenants (load cluster) -----------------------------------------------------

const userMigration = (k: number) =>
  migration(`20260921${String(k).padStart(2, "0")}0000_bench_users_c${k}`, `ALTER TABLE users ADD COLUMN c${k} text;`, `ALTER TABLE users DROP COLUMN c${k};`);
const SEEDS = [
  ["20260921200314_bench_seed_user_a", "INSERT INTO users (name, email) VALUES ('Bench seed A', 'bench-seed-a@bench.test');\n"],
  ["20260921210841_bench_seed_user_b", "INSERT INTO users (name, email) VALUES ('Bench seed B', 'bench-seed-b@bench.test');\n"],
  ["20260921221506_bench_bulk_email_verified", "UPDATE users SET email_verified = true WHERE NOT email_verified;\n"],
] as const;
const MOVE_TENANT = "move-1m";
/** Package copy with the first `migrations` users migration and the first `seeds` bench seed. */
const tenantsPackage = (migrations: number, seeds: number) =>
  benchPackage(`tenants-m${migrations}-s${seeds}`, Array.from({ length: migrations }, (_, i) => userMigration(i + 1)), SEEDS.slice(0, seeds));
/** Number of bench migrations / seeds applied across tiers; each tier continues where the previous one left off. */
type Applied = { migrations: number; seeds: number };

async function tenantsPhase() {
  const volume = flags["load-volume"] as string;
  const tiers = list(flags.tiers) as TierName[];
  const applied: Applied = { migrations: 0, seeds: 0 };
  for (const tier of tiers) await tierSteps(tier, volume, applied);
  // Moves and bulk seed on the 1M-row tenant (T4), then a 1M move back to T2.
  const bucket = (result.tenants.moves ??= {});
  await moveSteps(bucket, tiers, volume, applied);
  estimateMove100m(bucket);
}

/** On one tier: migrateAll with nothing pending, demo provision/reset, one pending migration (c16, c64) and one pending seed. */
async function tierSteps(tier: TierName, volume: string, applied: Applied) {
  const bucket = (result.tenants[tier] ??= {});
  await ensurePostgres(tier, volume);
  const tenantsPerDb = psql("db0", "SELECT string_agg(database_id || '=' || n, ',') FROM (SELECT database_id, count(*) n FROM platform.placements GROUP BY 1 ORDER BY 1) x");
  const current = tenantsPackage(applied.migrations, applied.seeds);
  await step(bucket, "migrateAllNoPending", () => migrateAllNoPending(current, tenantsPerDb));
  const demos = Array.from({ length: 5 }, (_, i) => `demo-bench-${tier.toLowerCase()}-${i}`);
  await step(bucket, "demoProvision", () => child(current, { step: "provision-demo", tenants: demos, database: "db0" }));
  await step(bucket, "demoReset", () => child(current, { step: "reset-demo", tenants: demos }));
  for (const concurrency of [16, 64]) {
    const next = tenantsPackage(++applied.migrations, applied.seeds);
    await step(bucket, `migrateAllOnePending_c${concurrency}`, async () => {
      const s0 = pgStat();
      const r = await child(next, { step: "migrate-all", concurrency, perDatabaseConcurrency: concurrency / 2 });
      const summary = r.output as { succeeded?: number } | undefined;
      return { ...r, migration: userMigration(applied.migrations)[0], xactDelta: diffStat(s0, pgStat()), tenantsPerSecond: round((summary?.succeeded ?? 0) / (r.ms / 1000), 1) };
    });
    await step(bucket, `migrateAllCleanup_c${concurrency}`, () => child(next, { step: "migrate-all", concurrency: 16, perDatabaseConcurrency: 8 }));
  }
  const seeded = tenantsPackage(applied.migrations, ++applied.seeds);
  await step(bucket, "seedAllOnePending", async () => {
    const r = await child(seeded, { step: "seed-all", concurrency: 16, perDatabaseConcurrency: 8 });
    const summary = r.output as { succeeded?: number } | undefined;
    return { ...r, seed: SEEDS[applied.seeds - 1]?.[0], tenantsPerSecond: round((summary?.succeeded ?? 0) / (r.ms / 1000), 1) };
  });
}

/** migrateAll with nothing pending: xact deltas, an idle window of the same duration, and the statement breakdown of a separate run with log_statement=all. */
async function migrateAllNoPending(pkg: string, tenantsPerDb: string) {
  const s0 = pgStat();
  const r = await child(pkg, { step: "migrate-all", concurrency: 16, perDatabaseConcurrency: 8 }, { pollLocks: false });
  const s1 = pgStat();
  await Bun.sleep(r.wallMs);
  const s2 = pgStat();
  const statementLog = await loggedStatements(pkg);
  return {
    ...r, tenantsPerDb, xactDelta: diffStat(s0, s1), idleXactDeltaSameDuration: diffStat(s1, s2), statementLog,
    note: "xact deltas include one pg_stat_database read each; the idle window measures background noise over the same wall time; listPage pages are read from db0 (platform); statementLog is a separate run with log_statement=all (server-wide, includes BEGIN/SET LOCAL/COMMIT wrappers of management queries)",
  };
}

/** Second run with log_statement=all: which statements are sent when nothing is pending (grouped by the first 70 characters). */
async function loggedStatements(pkg: string) {
  psql("db0", "ALTER SYSTEM SET log_statement = 'all'");
  psql("db0", "SELECT pg_reload_conf()");
  const since = new Date().toISOString();
  await Bun.sleep(500);
  const logged = await child(pkg, { step: "migrate-all", concurrency: 16, perDatabaseConcurrency: 8 }, { pollLocks: false });
  await Bun.sleep(500);
  psql("db0", "ALTER SYSTEM RESET log_statement");
  psql("db0", "SELECT pg_reload_conf()");
  const lines = `${sh(["docker", "logs", "--since", since, NAMES.pg], { allowFail: true }).err}`.split("\n");
  const statements: Record<string, number> = {};
  for (const line of lines) {
    const match = /\[\d+\] LOG:\s+(?:statement|execute [^:]*): (.*)$/.exec(line);
    if (!match?.[1] || /pg_reload_conf|log_statement|pg_stat_database|pg_locks/.test(match[1])) continue;
    const key = match[1].replace(/\s+/g, " ").slice(0, 70);
    statements[key] = (statements[key] ?? 0) + 1;
  }
  const total = Object.values(statements).reduce((a, b) => a + b, 0);
  return { wallMs: logged.wallMs, totalStatements: total, byStatement: Object.fromEntries(Object.entries(statements).sort((a, b) => b[1] - a[1])) };
}

/** Preparing the 1M-row tenant, bulk seed and moves (T4: 1M and 10M; 1M back if T2 exists). */
async function moveSteps(bucket: Json, tiers: TierName[], volume: string, applied: Applied) {
  const final = tenantsPackage(applied.migrations, applied.seeds);
  await ensurePostgres("T4", volume);
  await step(bucket, "moveTenantProvision", async () => {
    const r = await child(final, { step: "provision", tenants: [MOVE_TENANT], database: "db0" });
    const schema = schemaOf(MOVE_TENANT);
    const t = Date.now();
    await psqlScript("db0", [rowsSql(schema, 1, 1_000_000, true), `ANALYZE "${schema}".users;`].join("\n"));
    return { ...r, rows: 1_000_000, generationSeconds: round((Date.now() - t) / 1000, 1) };
  });
  // All bench seeds (cumulative, in ID order): the bulk seed comes last; the earlier ones not yet applied here are trivial inserts.
  const bulk = tenantsPackage(applied.migrations, SEEDS.length);
  await step(bucket, "bulkSeed1mDefaultTimeouts", () => child(bulk, { step: "seed-tenant", tenant: MOVE_TENANT }));
  if ((bucket.bulkSeed1mDefaultTimeouts as Json | undefined)?.error)
    await step(bucket, "bulkSeed1mRaisedTimeout", () => child(bulk, { step: "seed-tenant", tenant: MOVE_TENANT, options: RAISED }));
  await step(bucket, "move1m_T4", () => move(bulk, MOVE_TENANT, "db1"));
  await step(bucket, "move10m_T4", () => move(bulk, "big", "db0"));
  if (tiers.includes("T2")) {
    await ensurePostgres("T2", volume);
    await step(bucket, "move1mBack_T2", () => move(bulk, MOVE_TENANT, "db0"));
  }
}

/** Linear estimate of the move time of a 100M-row tenant from the measured 10M move (added once). */
function estimateMove100m(bucket: Json) {
  const big = bucket.move10m_T4 as Json | undefined;
  const fallback = big?.fallback as Json | undefined;
  const seconds = Number(fallback && !fallback.error ? fallback.wallMs : (big?.cli as Json | undefined)?.ok ? (big?.cli as Json).wallMs : 0) / 1000;
  const rows = Number(big?.rows ?? 0);
  if (seconds && rows && !result.estimates.some((e) => e.what === "tools move of a 100M-row tenant at T4"))
    result.estimates.push({
      what: "tools move of a 100M-row tenant at T4", estimateSeconds: round((seconds * 1e8) / rows), measuredRows: rows, measuredSeconds: round(seconds, 1),
      basis: "linear extrapolation of the measured move; fingerprints sort all rows, so the real duration is likely higher", isEstimate: true,
    });
}

/** `tools move` through the CLI (default options). A failed move is rolled back and retried programmatically with raised timeouts.
 * A source schema left behind in the target database (README: TARGET_EXISTS) is dropped first, as the README says. */
async function move(pkg: string, tenant: string, target: string) {
  const schema = schemaOf(tenant);
  const source = databaseOf(tenant);
  const rows = count(source, `SELECT count(*) FROM "${schema}".users`);
  const retained = count(target, `SELECT count(*) FROM pg_namespace WHERE nspname='${schema}'`) > 0;
  if (retained) psql(target, `DROP SCHEMA "${schema}" CASCADE`);
  const env = { ...process.env, DATABASE_URLS: directUrls().join(",") };
  const cli = async (...args: string[]) => {
    const t = Date.now();
    const r = await shAsync(["/usr/bin/time", "-l", "bun", "src/core/cli.ts", ...args], { cwd: pkg, env });
    const rss = /(\d+)\s+maximum resident set size/.exec(r.err);
    return { ok: r.ok, wallMs: Date.now() - t, maxRssMiB: rss ? round(Number(rss[1]) / 1048576, 1) : undefined, error: r.err.split("\n").find((l) => l.startsWith('{"error"')) };
  };
  const latest = () => {
    const [id = "", status, phase, error] = psql("db0", `SELECT id, status, phase, coalesce(error, '') FROM platform.moves WHERE tenant_id='${tenant}' ORDER BY created_at DESC LIMIT 1`).split("|");
    return { id, status, phase, error };
  };
  const first = await cli("move", tenant, target, "--writers-drained");
  const outcome: Json = { tenant, from: source, to: target, rows, droppedRetainedTargetSchema: retained, cli: { ...first, move: latest(), rowsPerSecond: first.ok ? round(rows / (first.wallMs / 1000)) : undefined } };
  if (!first.ok) {
    const failed = latest();
    if (failed.status === "failed" || failed.status === "running") outcome.rollback = { ...(await cli("rollback-move", failed.id, "--writers-drained")), move: latest() };
    if (count(target, `SELECT count(*) FROM pg_namespace WHERE nspname='${schema}'`) > 0) psql(target, `DROP SCHEMA "${schema}" CASCADE`);
    const fallback = await child(pkg, { step: "move", tenant, database: target, options: RAISED }, { pollLocks: false });
    outcome.fallback = { ...fallback, options: RAISED, rowsPerSecond: fallback.error ? undefined : round(rows / (fallback.ms / 1000)), move: latest() };
  }
  const now = databaseOf(tenant);
  if (now === target) {
    const t = Date.now();
    psql(source, `DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    outcome.droppedRetainedSourceSchemaMs = Date.now() - t;
  }
  outcome.finalDatabase = now;
  return outcome;
}

// ---- Phase: big tenant --------------------------------------------------------------------

const Z = [
  migration("20260920081512_bench_note_default", "ALTER TABLE users ADD COLUMN note text NOT NULL DEFAULT 'none';", "ALTER TABLE users DROP COLUMN note;"),
  migration("20260920081547_bench_name_varchar", "ALTER TABLE users ALTER COLUMN name TYPE varchar(64);", "ALTER TABLE users ALTER COLUMN name TYPE varchar;"),
  migration("20260920081623_bench_users_name_index", "CREATE INDEX CONCURRENTLY users_name_idx ON users (name);", "DROP INDEX CONCURRENTLY users_name_idx;"),
];

async function bigPhase() {
  const zPackages = [1, 2, 3].map((n) => benchPackage(`big-z${n}`, Z.slice(0, n)));
  for (const rows of list(flags.sizes).map(Number)) {
    const name = label(rows);
    const entry = (result.big[name] ??= { rows, users: rows, load: {}, tiers: {}, notes: [] });
    if (entry.status === "ok") continue;
    const tenant = `big-${name}`;
    const storage = flags.storage ? join(flags.storage, `pgdata-${name}`) : (flags["scale-volume"] as string);
    entry.storage = storage;
    if (!entry.startedAt) {
      stopAll();
      pgTier = undefined;
      if (flags.storage) {
        mkdirSync(storage, { recursive: true });
        if (readdirSync(storage).length) throw new Error(`${storage} is not empty; use a fresh --storage path`);
      } else sh(["docker", "volume", "rm", "-f", storage], { allowFail: true });
      entry.startedAt = new Date().toISOString();
    }
    for (const tier of list(flags["load-tiers"]) as TierName[]) {
      if (tier === "T2" && rows > Number(flags["max-t2-load-rows"])) {
        if (!entry.notes.some((n) => n.startsWith("T2 load skipped")))
          entry.notes.push(`T2 load skipped above ${flags["max-t2-load-rows"]} rows (--max-t2-load-rows): time budget; data loaded at T4 only`);
        continue;
      }
      await ensurePostgres(tier, storage);
      const disk = diskFree();
      if (rows >= 1e8 && (disk.availableGiB ?? 0) < Number(flags["min-free-gib"])) {
        const reason = `only ${disk.availableGiB} GiB free before the ${name} load (< ${flags["min-free-gib"]} GiB)`;
        result.skipped.push({ step: `big/${name}`, reason });
        entry.status = "skipped";
        save();
        log(`STOP: ${reason}`);
        return;
      }
      await step(entry.load, tier, () => loadBig(tenant, rows));
    }
    for (const tier of list(flags.tiers) as TierName[]) {
      const bucket = (entry.tiers[tier] ??= {});
      await ensurePostgres(tier, storage);
      await step(bucket, "queries", () => queries(tenant, rows));
      await step(bucket, "migrations", () => bigMigrations(zPackages as [string, string, string], tenant, rows, tier));
    }
    entry.status = "ok";
    entry.finishedAt = new Date().toISOString();
    entry.finalSize = { ...dataDirSize(), disk: diskFree() };
    stopAll();
    pgTier = undefined;
    if (!flags.keep && !flags.storage) {
      sh(["docker", "volume", "rm", "-f", storage], { allowFail: true });
      entry.cleanedUp = `volume ${storage} removed`;
    }
    save();
  }
}

async function loadBig(tenant: string, users: number) {
  const m = createManagement(createConfig(directUrls()), { driver: bunDriver });
  let schema: string;
  try {
    await bootstrap(m);
    schema = (await provisionTenant(m, tenant, "db0")).schemaName;
  } finally {
    await m.close();
  }
  const chunk = Math.min(1_000_000, users);
  // CASCADE: session/account/user_imports are tied to users by FK.
  await psqlScript("db0", `TRUNCATE "${schema}".users CASCADE;`);
  const rates: number[] = [];
  let t = Date.now();
  for (let from = 1; from <= users; from += chunk) {
    const to = Math.min(users, from + chunk - 1);
    const c = Date.now();
    await psqlScript("db0", rowsSql(schema, from, to));
    rates.push((to - from + 1) / ((Date.now() - c) / 1000));
    if (rates.length % 10 === 0) log(`  users ${to}/${users}`);
  }
  const seconds = (Date.now() - t) / 1000;
  const tables: Json = {
    users: { rows: users, chunkRows: chunk, seconds: round(seconds, 1), rowsPerSecond: round(users / seconds), firstChunkRowsPerSecond: round(rates[0]), lastChunkRowsPerSecond: round(rates.at(-1)) },
  };
  t = Date.now();
  await psqlScript("db0", `VACUUM (ANALYZE) "${schema}".users;`);
  const vacuumAnalyzeSeconds = round((Date.now() - t) / 1000, 1);
  t = Date.now();
  await psqlScript("db0", "CHECKPOINT;");
  const checkpointSeconds = round((Date.now() - t) / 1000, 1);
  const [usersTable, usersIndexes, database] = psql(
    "db0",
    `SELECT pg_table_size('"${schema}".users'), pg_indexes_size('"${schema}".users'), pg_database_size('db0')`,
  ).split("|").map(Number);
  const mib = (bytes = 0) => round(bytes / 1048576, 1);
  const relations = (usersTable ?? 0) + (usersIndexes ?? 0);
  return {
    tenant, schema, tables, vacuumAnalyzeSeconds, checkpointSeconds,
    sizesMiB: { usersTable: mib(usersTable), usersIndexes: mib(usersIndexes), database: mib(database) },
    bytesPerRowTablesAndIndexes: round(relations / users, 1), ...dataDirSize(), disk: diskFree(),
    note: "generated server-side with INSERT … SELECT generate_series in 1M-row transactions (bypasses the package API); indexes maintained during load",
  };
}

/** Bench-specific prepared queries measured on the big tenant. */
const bigQueries = () => ({
  point: prepareQuery("SELECT id::text AS id, name, email FROM users WHERE id = $1::uuid"),
  // `ORDER BY users.id`: the text alias `id` would sort by text (seq scan + sort); `offsetPage` deliberately sorts that way.
  keyset: prepareQuery("SELECT id::text AS id, name FROM users WHERE id > $1::uuid ORDER BY users.id LIMIT $2"),
  offsetPage: prepareQuery("SELECT id::text AS id, name FROM users ORDER BY id LIMIT $1 OFFSET $2"),
  count: prepareQuery("SELECT count(*)::bigint AS n FROM users"),
  verifiedCounts: prepareQuery("SELECT email_verified, count(*)::bigint AS n FROM users GROUP BY email_verified"),
  insert: prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text)"),
  insertValues: prepareQuery(`INSERT INTO users (id, name, email) VALUES ${Array.from({ length: 1000 }, (_, i) => `($${3 * i + 1}::uuid, $${3 * i + 2}::text, $${3 * i + 3}::text)`).join(", ")}`),
});

/** Runs `work` `n` times: the first call is `coldMs`, the rest the distribution; errors are counted by code. */
async function measure(n: number, work: () => Promise<unknown>) {
  const times: number[] = [];
  const errors: Record<string, number> = {};
  let coldMs: number | undefined;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    try {
      await work();
      if (i === 0) coldMs = performance.now() - t;
      else times.push(performance.now() - t);
    } catch (error) {
      const code = errorCode(error) ?? "UNKNOWN";
      errors[code] = (errors[code] ?? 0) + 1;
    }
  }
  return { coldMs: round(coldMs), ...distribution(times), ...(n <= 5 && { runsMs: times.map((x) => round(x)) }), errors };
}

async function queries(tenant: string, users: number) {
  const db = createDatabase(createConfig(directUrls()), { driver: bunDriver, poolMax: 4 });
  const m = createManagement(createConfig(directUrls()), { driver: bunDriver, ...RAISED });
  const placement = await db.platform.get(tenant);
  const q = bigQueries();
  const random = () => uuidOf(1 + Math.floor(Math.random() * users));
  const batchRow = () => {
    const id = crypto.randomUUID();
    return [id, "batch", `${id}@bench.test`];
  };
  const inTenant = <T>(work: (t: Parameters<Parameters<typeof db.withTenant>[1]>[0]) => Promise<T>) => db.withTenant(tenant, work);
  /** Runtime first (server statement_timeout = bootstrap DB default); on error, the management pool with raised timeouts. */
  async function heavy(query: PreparedQuery) {
    const runtime = await measure(3, () => inTenant((t) => t.query(query)));
    const management = Object.keys(runtime.errors).length ? await measure(2, () => m.pools.node(placement.databaseId).query(query.bind(placement.schemaName))) : undefined;
    return { runtime, management };
  }
  try {
    const out = {
      pointLookup: await measure(501, () => inTenant((t) => t.query(q.point, [random()]))),
      keysetPage20: await measure(301, () => inTenant((t) => t.query(q.keyset, [random(), 20]))),
      // Ordering by the text alias `id`: full scan + sort even for the first page.
      offsetPageFirst: await measure(3, () => inTenant((t) => t.query(q.offsetPage, [20, 0]))),
      offsetPageMiddle: await measure(3, () => inTenant((t) => t.query(q.offsetPage, [20, Math.floor(users / 2)]))),
      countUsers: await heavy(q.count),
      groupByEmailVerified: await heavy(q.verifiedCounts),
      insert1000RowsLoopInTransaction: await measure(3, () =>
        inTenant((t) => t.transaction(async (tx) => {
          for (let i = 0; i < 1000; i++) await tx.query(q.insert, batchRow());
        })),
      ),
      insert1000RowsMultiValues: await measure(3, () =>
        inTenant((t) => t.query(q.insertValues, Array.from({ length: 1000 }, batchRow).flat())),
      ),
    };
    return {
      ...out, driver: "bun", connection: "direct (no PgBouncer), from the macOS host through OrbStack port forwarding", includesPlacementRead: true,
      note: "coldMs = first call after the PostgreSQL restart for this tier (VM page cache may still be warm); other stats exclude it; heavy queries fall back to the management pool when the runtime default statement_timeout (5 s) is hit",
    };
  } finally {
    await db.close();
    await m.close();
  }
}

async function bigMigrations([z1, z2, z3]: [string, string, string], tenant: string, rows: number, tier: TierName) {
  const schema = schemaOf(tenant);
  const filenode = () => psql("db0", `SELECT pg_relation_filenode('"${schema}".users')`);
  const out: Json = {};
  const record = (key: string, r: Json) => {
    out[key] = r;
    childFailed({ ...r, label: `big/${label(rows)}/${tier}/${key}` });
    save();
    return r;
  };
  record("addColumnConstantDefault", await child(z1, { step: "migrate-tenant", tenant }));
  let node = filenode();
  let rewrite: ChildResult | undefined;
  if (rows < 1e8) {
    rewrite = await child(z2, { step: "migrate-tenant", tenant });
    record("typeChangeDefaultTimeouts", { ...rewrite, tableRewritten: filenode() !== node });
  } else out.typeChangeDefaultTimeouts = { skipped: "not attempted at ≥100M rows: the 10M run shows whether the default 30 s migration statement timeout suffices" };
  if (!rewrite || rewrite.error) {
    node = filenode();
    rewrite = await child(z2, { step: "migrate-tenant", tenant, options: RAISED });
    record("typeChangeRaisedTimeout", { ...rewrite, options: RAISED, tableRewritten: filenode() !== node });
  }
  record("concurrentIndexUnderWrites", await underWrites(z3, tenant, rows, tier));
  record("migrateDownIndex", await child(z3, { step: "rollback", tenant, steps: 1, options: RAISED }));
  node = filenode();
  const restore = await child(z3, { step: "rollback", tenant, steps: 2, options: RAISED });
  record("rollbackTypeChangeAndColumn", { ...restore, tableRewritten: filenode() !== node, note: "restores the schema for the next tier" });
  return out;
}

/** k6 inserts into the same tenant through PgBouncer + the harness app while CREATE INDEX CONCURRENTLY runs; 10 s windows before, during and
 * after (each window is one k6 process, ~1 s apart). */
async function underWrites(pkg: string, tenant: string, rows: number, tier: TierName) {
  await startBouncer();
  await startApp(flags.driver as string, 10);
  const rate = tier === "T2" ? 50 : 200;
  const env = { OP: "bigInsert", BIG_TENANT: tenant, BIG_USERS: rows, START_RATE: rate, PLAN: JSON.stringify([[rate, 10]]) };
  const raw = join(RAW_DIR, run, `cic-${label(rows)}-${tier}`);
  const windows: (ReturnType<typeof segment> & { phase: string })[] = [];
  const window = async (phase: string, i: number) => {
    const summary = await k6(env, join(raw, `${phase}-${i}.json`));
    windows.push({ phase, ...segment(summary, 0, rate, 10, rate) });
  };
  try {
    await k6(env, join(raw, "warmup.json"));
    for (let i = 0; i < 3; i++) await window("before", i);
    let done = false;
    const migrating = child(pkg, { step: "migrate-tenant", tenant, options: RAISED }).finally(() => (done = true));
    for (let i = 0; !done; i++) await window("during", i);
    const r = await migrating;
    for (let i = 0; i < 3; i++) await window("after", i);
    const phase = (name: string) => {
      const ws = windows.filter((w) => w.phase === name);
      const p95 = ws.map((w) => w.p95Ms ?? 0).sort((a, b) => a - b);
      const requests = ws.reduce((n, w) => n + w.requests, 0);
      return {
        windows: ws.length, p95MedianMs: p95[Math.floor(p95.length / 2)], p95MaxMs: p95.at(-1), requests,
        errorRate: round(requests ? ws.reduce((n, w) => n + w.requests * (w.errorRate ?? 0), 0) / requests : 0, 4), windowsMissingSlo: ws.filter((w) => !w.pass).length,
      };
    };
    return {
      ...r, options: RAISED, writeRateRps: rate, driver: flags.driver, windowSeconds: 10, before: phase("before"), during: phase("during"), after: phase("after"),
      wouldExceedDefault30sTimeout: r.ms > 30000, windows,
    };
  } finally {
    stopContainer(NAMES.app);
    stopContainer(NAMES.bouncer);
  }
}

// ---- Main flow ----------------------------------------------------------------------------------------

if (flags.child) await childMain(flags.child);
else {
  result = loadResult<ScaleResult>(file) ?? {
    schema: "repo-db-bench/scale@1", run, startedAt: new Date().toISOString(), environment: environment(), settings: {}, tenants: {}, big: {}, failures: [], skipped: [], estimates: [], notes: [],
  };
  result.settings = {
    tiers: TIERS, postgresImage: IMAGES.postgres, managementDriver: "bun", runtimeQueriesDriver: "bun", raisedManagementOptions: RAISED,
    rowsDefinition: "rows = users rows (id, name, unique email)",
    benchMigrations: { big: Z.map(([id]) => id), tenants: [1, 2, 3, 4].map((k) => userMigration(k)[0]), seeds: SEEDS.map(([id]) => id) },
    approach: "bench-only migrations/seeds live in temporary package copies under $BENCH_RAW_DIR/packages (codegen regenerated there); the copy's scale.ts runs each step as a child process",
  };
  try {
    for (const phase of list(flags.phase)) {
      if (phase === "tenants") await tenantsPhase();
      else if (phase === "big") await bigPhase();
      else throw new Error(`Unknown phase ${phase}`);
    }
  } finally {
    save();
    stopAll();
    log(`results: ${file}`);
  }
}
