/** Load benchmark (`bun run bench`). PostgreSQL (tier limits), PgBouncer and the harness app (server.ts) run in Docker; k6
 * runs on the host. Phases (`--phase setup,matrix,repeat,extra,soak`):
 *  setup   10,000 tenants on db0/db1 via provisionTenant (+ demo tenants, big tenant); rows are generated server-side
 *  matrix  drivers × tiers × {point, mixed}: 15 s ramping-arrival-rate rungs until two consecutive rungs miss the SLO
 *  repeat  T2/T4 × fastest driver × {point, mixed}, `--repeats` more times (variance)
 *  extra   T2/T4 × fastest driver: hotpoint, range, insert and auth ladders and a 10× spike
 *  soak    T2 × fastest driver: mixed at 50% of its maximum for `--soak-minutes`
 * Aggregate results (resumable with `--run <id>`): results/<id>-load.json. Raw k6 summaries and samples: $BENCH_RAW_DIR/<id>/. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createConfig, errorCode } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { bootstrap, createManagement, type Management, provisionTenant } from "@0furkancolak/pgcells/management";
import {
  APP_LIMITS, APP_URL, appMetrics, BOUNCER_LIMITS, bouncerDelta, bouncerShow, containerState, crashLines, dataDirSize, demoName,
  diffStat, directUrls, diskFree, eachLimit, environment, hostOf, IMAGES, k6, list, loadResult, log, messageOf, NAMES, oomKills, pgStat,
  poolSummary, psql, psqlScript, RAW_DIR, resourceSummary, RESULTS_DIR, round, rowsSql, saveResult, segment, sh, SLO, stamp, startApp,
  startBouncer, startPoolPoller, startPostgres, startStats, stopAll, tenantName, type TierName, TIERS,
} from "./lib";

const { values: flags } = parseArgs({
  options: {
    phase: { type: "string", default: "matrix" },
    run: { type: "string" },
    tiers: { type: "string", default: "T1,T2,T3,T4" },
    drivers: { type: "string", default: "bun,postgres,pg" },
    scenarios: { type: "string", default: "point,mixed" },
    driver: { type: "string" },
    tenants: { type: "string", default: "10000" },
    "tenant-users": { type: "string", default: "1000" },
    "big-rows": { type: "string", default: "10000000" },
    "demo-tenants": { type: "string", default: "50" },
    "provision-concurrency": { type: "string", default: "16" },
    "step-seconds": { type: "string", default: "15" },
    "warmup-max-seconds": { type: "string", default: "240" },
    "cold-minutes": { type: "string", default: "4" },
    "soak-minutes": { type: "string", default: "20" },
    repeats: { type: "string", default: "2" },
    "pool-max": { type: "string", default: "10" },
    volume: { type: "string", default: "repo-db-bench-load" },
  },
});
const TENANTS = Number(flags.tenants);
const TENANT_USERS = Number(flags["tenant-users"]);
const BIG_TENANT = "big";
const BIG_USERS = Number(flags["big-rows"]);
const DEMO_TENANTS = Number(flags["demo-tenants"]);
const STEP_S = Number(flags["step-seconds"]);
/** Warm-up: 15 s windows at a tier-specific rate; until 3 consecutive windows pass the SLO with max/min p95 ≤ 1.3 (or all p95 < 10 ms). */
const WARMUP = {
  rps: { T1: 20, T2: 50, T3: 100, T4: 150 } as Record<TierName, number>, windowSeconds: 15, stableWindows: 3, maxP95Ratio: 1.3,
  maxSeconds: Number(flags["warmup-max-seconds"]), cellMaxSeconds: 90, method: "v2",
};
const POOL_MAX = Number(flags["pool-max"]);
const LADDER = [25, 50, 100, 150, 200, 300, 400, 500, 650, 800, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 6500, 8000];
const DRIVERS = list(flags.drivers);
const run = flags.run ?? stamp();
const file = join(RESULTS_DIR, `${run}-load.json`);

type Stage = ReturnType<typeof segment> & {
  phase?: string;
  resources?: ReturnType<typeof resourceSummary>;
  pgbouncer?: ReturnType<typeof poolSummary>;
  appRssMiB?: number;
};
interface Cell {
  key: string;
  phase: string;
  tier: TierName;
  driver: string;
  scenario: string;
  repeat: number;
  startedAt: string;
  durationS?: number;
  status: "ok" | "failed";
  error?: string;
  stages: Stage[];
  maxRpsAtSlo?: number;
  firstMissRps?: number;
  ceilingReached?: boolean;
  atMax?: Stage;
  extra?: Record<string, unknown>;
  warmup?: Record<string, unknown>;
  delta?: ReturnType<typeof delta>;
  notes: string[];
}
interface LoadResult {
  schema: string;
  run: string;
  startedAt: string;
  updatedAt?: string;
  environment: ReturnType<typeof environment>;
  settings: Record<string, unknown>;
  setup?: Record<string, unknown>;
  cells: Record<string, Cell>;
  failures: { key: string; error: string; at: string }[];
  /** Cells removed from the totals and re-run, with the reason (kept for transparency). */
  discarded?: (Cell & { discardReason: string })[];
  notes: string[];
  summary?: ReturnType<typeof summarize>;
}

const result: LoadResult = loadResult<LoadResult>(file) ?? {
  schema: "repo-db-bench/load@1", run, startedAt: new Date().toISOString(), environment: environment(), settings: {}, cells: {}, failures: [], notes: [],
};
result.settings = {
  tiers: TIERS,
  app: { ...APP_LIMITS, image: IMAGES.bun, poolMaxPerDatabase: POOL_MAX, maxPendingPerDatabase: 64 },
  pgbouncer: BOUNCER_LIMITS,
  slo: SLO,
  ladder: { rps: LADDER, rungSeconds: STEP_S, rampSeconds: 1, stopAfterConsecutiveMisses: 2, oneK6ProcessPerRung: true },
  warmup: WARMUP,
  data: { tenants: TENANTS, usersPerTenant: TENANT_USERS, bigTenant: BIG_TENANT, bigUsers: BIG_USERS, demoTenants: DEMO_TENANTS },
  topology: "one PostgreSQL container hosts databases db0 (platform + tenants) and db1; PgBouncer transaction pooling; app reaches PgBouncer over the Docker network; k6 on the macOS host through OrbStack port forwarding",
};
const save = () => {
  result.updatedAt = new Date().toISOString();
  result.summary = summarize();
  saveResult(file, result);
};

// ---- Stack --------------------------------------------------------------------

/** `warm`: "<tier>/<driver>" once the stability warm-up has passed on this stack (any restart resets it). */
let stack: { tier?: TierName; driver?: string; warm?: string } = {};
const psqlReady = () => {
  try {
    psql("db0", "SELECT 1");
    return true;
  } catch {
    return false;
  }
};
/** A crashed backend (cgroup oom_kill > 0 since start) or a server still in recovery would contaminate the next cell: restart. */
function pgNeedsRestart() {
  if (containerState(NAMES.pg)?.status !== "running") return "not running";
  if ((oomKills(NAMES.pg) ?? 0) > 0) return `oom_kill=${oomKills(NAMES.pg)} since start`;
  try {
    psql("db0", "SELECT 1");
  } catch {
    return "not accepting connections";
  }
}
async function ensureStack(tier: TierName, driver: string, notes: string[] = []) {
  const reason = stack.tier === tier ? pgNeedsRestart() : undefined;
  if (reason) notes.push(`stack restarted before this cell: PostgreSQL ${reason}`);
  if (stack.tier !== tier || reason) {
    stopAll();
    const { readyMs } = await startPostgres(tier, flags.volume as string);
    await startBouncer();
    stack = { tier };
    log(`PostgreSQL ${tier} ready in ${readyMs} ms`);
  }
  if (containerState(NAMES.bouncer)?.status !== "running") await startBouncer();
  if (stack.driver !== driver || containerState(NAMES.app)?.status !== "running") {
    await startApp(driver, POOL_MAX);
    stack.driver = driver;
    stack.warm = undefined;
  }
}
function unhealthy() {
  for (const name of [NAMES.pg, NAMES.bouncer, NAMES.app]) {
    const s = containerState(name);
    if (s?.status !== "running") return `${name} ${s?.status ?? "missing"} (oomKilled=${s?.oomKilled}, exitCode=${s?.exitCode})`;
  }
}

let cookies: { host: string; cookie: string }[] | undefined;
/** Signs in once per demo tenant (Better Auth password hash); k6 then only checks sessions. */
async function demoCookies() {
  if (cookies) return cookies;
  const signedIn: { host: string; cookie: string }[] = [];
  for (let i = 0; i < DEMO_TENANTS; i++) {
    const host = hostOf(demoName(i));
    const res = await fetch(`${APP_URL}/auth/sign-in`, {
      method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ email: `demo@${demoName(i)}.example.com`, password: "demo-password" }),
    });
    const body = (await res.json()) as { cookie?: string };
    if (res.ok && body.cookie) signedIn.push({ host, cookie: body.cookie });
  }
  if (!signedIn.length) throw new Error("No demo tenant sign-in succeeded");
  return (cookies = signedIn);
}

async function snapshot() {
  return {
    iso: new Date().toISOString(), pgStat: pgStat(), bouncer: await bouncerShow("STATS"), app: await appMetrics(),
    oom: { pg: oomKills(NAMES.pg), app: oomKills(NAMES.app), bouncer: oomKills(NAMES.bouncer) }, loadavg: sh(["sysctl", "-n", "vm.loadavg"]).out,
  };
}
function delta(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  const minus = (a?: number, b?: number) => (a === undefined || b === undefined ? undefined : a - b);
  const errors = Object.entries(after.app?.errors ?? {}).map(([code, n]) => [code, n - (before.app?.errors[code] ?? 0)] as const).filter(([, n]) => n);
  return {
    pgStat: diffStat(before.pgStat, after.pgStat),
    pgbouncer: bouncerDelta(before.bouncer, after.bouncer),
    oomKills: { pg: minus(after.oom.pg, before.oom.pg), app: minus(after.oom.app, before.oom.app), bouncer: minus(after.oom.bouncer, before.oom.bouncer) },
    app: { rssBeforeMiB: before.app?.rssMiB, rssAfterMiB: after.app?.rssMiB, requests: minus(after.app?.requests, before.app?.requests), errors: Object.fromEntries(errors) },
    pgCrashLogLines: crashLines(NAMES.pg, before.iso).slice(0, 5),
    containers: { pg: containerState(NAMES.pg), bouncer: containerState(NAMES.bouncer), app: containerState(NAMES.app) },
    hostLoadAvg: { before: before.loadavg, after: after.loadavg },
  };
}

// ---- Cells -------------------------------------------------------------------------

type Samplers = { stats: ReturnType<typeof startStats>; pools: ReturnType<typeof startPoolPoller> };
type Body = (cell: Cell, env: Record<string, string | number>, raw: string, samplers: Samplers) => Promise<void>;

async function runCell(phase: string, tier: TierName, driver: string, scenario: string, op: string, repeat: number, body: Body) {
  const key = [phase, tier, driver, scenario, repeat].join("/");
  if (result.cells[key]?.status === "ok") return log(`skip ${key} (done)`);
  log(`cell ${key}`);
  const cell: Cell = { key, phase, tier, driver, scenario, repeat, startedAt: new Date().toISOString(), status: "failed", stages: [], notes: [] };
  const raw = join(RAW_DIR, run, key.replaceAll("/", "_"));
  mkdirSync(raw, { recursive: true });
  const started = Date.now();
  let samplers: Samplers | undefined;
  try {
    const env = await prepareCell(cell, op, raw);
    const before = await snapshot();
    samplers = { stats: startStats([NAMES.pg, NAMES.bouncer, NAMES.app]), pools: startPoolPoller() };
    await body(cell, env, raw, samplers);
    cell.status = "ok";
    await closingDelta(cell, before);
  } catch (error) {
    cell.error = messageOf(error, 800);
    result.failures.push({ key, error: cell.error, at: new Date().toISOString() });
    log(`FAILED ${key}: ${cell.error}`);
  } finally {
    closeCell(cell, raw, samplers);
  }
  cell.durationS = round((Date.now() - started) / 1000, 1);
  result.cells[key] = cell;
  save();
}

/** Prepares the stack, sets up the k6 env and (except cold) runs the warm-ups; returns the env. */
async function prepareCell(cell: Cell, op: string, raw: string) {
  const { tier, driver, scenario } = cell;
  if (scenario === "cold") {
    stopAll();
    stack = {};
  }
  await ensureStack(tier, driver, cell.notes);
  const env = {
    OP: op, TENANTS, TENANT_USERS, BIG_TENANT, BIG_USERS, ...(op === "auth" && { COOKIES: JSON.stringify(await demoCookies()) }),
  };
  if (scenario !== "cold") {
    // Stack-level warm-up over all tenants once per stack+driver; then an op-specific stability check for each cell.
    const warm = `${tier}/${driver}`;
    if (stack.warm !== warm) {
      cell.warmup = { stack: await warmUp(tier, { ...env, OP: "point" }, join(raw, "warm-stack"), WARMUP.maxSeconds) };
      stack.warm = warm;
    }
    cell.warmup = { ...cell.warmup, cell: await warmUp(tier, env, join(raw, "warm-cell"), WARMUP.cellMaxSeconds) };
  }
  return env;
}

/** A top rung can crash PostgreSQL (OOM); to avoid losing the ladder, recovery is awaited before the closing stats. */
async function closingDelta(cell: Cell, before: Awaited<ReturnType<typeof snapshot>>) {
  for (let i = 0; i < 120 && !psqlReady(); i++) await Bun.sleep(1000);
  try {
    cell.delta = delta(before, await snapshot());
  } catch (error) {
    cell.notes.push(`closing stats unavailable: ${messageOf(error, 200)}`);
  }
}

/** Stops and writes the samplers, collects container logs; if the app crashed, the cause is added to the cell notes. */
function closeCell(cell: Cell, raw: string, samplers: Samplers | undefined) {
  samplers?.stats.stop();
  samplers?.pools.stop();
  if (samplers) writeFileSync(join(raw, "samples.json"), JSON.stringify({ stats: samplers.stats.samples, pools: samplers.pools.rows }));
  // Container logs survive the next cell's restart; the app crash cause is written to the result.
  for (const name of [NAMES.app, NAMES.pg, NAMES.bouncer]) {
    const logs = sh(["docker", "logs", "--since", cell.startedAt, name], { allowFail: true });
    writeFileSync(join(raw, `${name}.log`), `${logs.out}\n${logs.err}`);
  }
  const app = containerState(NAMES.app);
  if (app && app.status !== "running") {
    const tail = sh(["docker", "logs", "--tail", "60", NAMES.app], { allowFail: true }).err;
    const reason = tail.split("\n").find((line) => /^\w*Error:|^error:/.test(line.trim()));
    cell.notes.push(`app exited (exitCode=${app.exitCode}, oomKilled=${app.oomKilled})${reason ? `: ${reason.trim().slice(0, 200)}` : ""}`);
  }
}

/** LADDER rungs until two consecutive misses; max at SLO = the rung before the first miss. */
const ladder: Body = async (cell, env, raw, { stats, pools }) => {
  let previous = LADDER[0] as number;
  let misses = 0;
  for (const rate of LADDER) {
    const from = Date.now();
    const summary = await k6({ ...env, START_RATE: previous, PLAN: JSON.stringify([[rate, STEP_S]]) }, join(raw, `rung-${rate}.json`));
    const stage: Stage = { ...segment(summary, 0, rate, STEP_S, previous), resources: resourceSummary(stats.samples, from + 1500, Date.now()), pgbouncer: poolSummary(pools.rows, from, Date.now()) };
    cell.stages.push(stage);
    log(`  ${rate} rps → ${stage.achievedRps} rps p95 ${stage.p95Ms} ms err ${stage.errorRate} ${stage.pass ? "pass" : "MISS"}`);
    previous = rate;
    misses = stage.pass ? 0 : misses + 1;
    const problem = unhealthy();
    if (problem) {
      cell.notes.push(`stopped: ${problem}`);
      break;
    }
    if (misses >= 2) break;
  }
  applyLadderMax(cell);
};

/** Max at SLO = the highest passing rung before the first two consecutive misses (stop rule). Isolated misses (e.g. the cold first
 * rung) are listed, not used; `firstMissRps` is the stricter reading. */
function applyLadderMax(cell: Cell) {
  const stages = cell.stages;
  const stop = stages.findIndex((s, i) => !s.pass && stages[i + 1] !== undefined && !stages[i + 1]?.pass);
  const considered = stop === -1 ? stages : stages.slice(0, stop);
  cell.atMax = considered.filter((s) => s.pass).at(-1);
  cell.maxRpsAtSlo = cell.atMax?.targetRps ?? 0;
  cell.firstMissRps = stages.find((s) => !s.pass)?.targetRps;
  cell.ceilingReached = stop === -1 && stages.at(-1)?.pass === true && stages.length === LADDER.length;
  cell.notes = cell.notes.filter((n) => !n.startsWith("ladder:"));
  const isolated = considered.filter((s) => !s.pass).map((s) => s.targetRps);
  if (isolated.length) cell.notes.push(`ladder: isolated SLO misses at ${isolated.join(", ")} rps ignored (next rung passed)`);
  if (cell.ceilingReached) cell.notes.push("ladder: ended without an SLO miss; the true max is higher");
}

/** 60 s at the base rate, 30 s at 10× base, 90 s at base; 5 s windows. Recovery = the first "after" window from which all later windows pass. */
const spike = (base: number): Body => async (cell, env, raw, { stats, pools }) => {
  const plan = [...Array(12).fill([base, 5]), ...Array(6).fill([base * 10, 5]), ...Array(18).fill([base, 5])] as [number, number][];
  const from = Date.now();
  const summary = await k6({ ...env, START_RATE: base, PLAN: JSON.stringify(plan) }, join(raw, "spike.json"));
  plan.forEach(([rate, seconds], i) => {
    const [w0, w1] = [from + i * 5000, from + (i + 1) * 5000];
    const phase = i < 12 ? "before" : i < 18 ? "spike" : "after";
    cell.stages.push({ ...segment(summary, i, rate, seconds, plan[i - 1]?.[0] ?? base), phase, resources: resourceSummary(stats.samples, w0, w1), pgbouncer: poolSummary(pools.rows, w0, w1) });
  });
  const after = cell.stages.filter((s) => s.phase === "after");
  const stable = after.findIndex((_, i) => after.slice(i).every((s) => s.pass));
  const failedRequests = (phase: string) => Math.round(cell.stages.filter((s) => s.phase === phase).reduce((n, s) => n + s.requests * (s.errorRate ?? 0), 0));
  cell.extra = {
    baseRps: base, spikeRps: base * 10, recoverySeconds: stable === -1 ? null : stable * 5, failedRequests: { before: failedRequests("before"), spike: failedRequests("spike"), after: failedRequests("after") },
    note: "window resource attribution is approximate (±1 s k6 start offset)",
  };
};

/** Constant mixed load in 60 s windows; app RSS is polled every 10 s. */
const soak = (rate: number, minutes: number): Body => async (cell, env, raw, { stats, pools }) => {
  const plan = Array.from({ length: minutes }, () => [rate, 60] as [number, number]);
  const rss: { t: number; rssMiB: number; heapUsedMiB: number }[] = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const m = await appMetrics();
      if (m) rss.push({ t: Date.now(), rssMiB: m.rssMiB, heapUsedMiB: m.heapUsedMiB });
      await Bun.sleep(10_000);
    }
  })();
  const from = Date.now();
  const summary = await k6({ ...env, START_RATE: rate, PLAN: JSON.stringify(plan) }, join(raw, "soak.json"));
  polling = false;
  await poller;
  writeFileSync(join(raw, "app-rss.json"), JSON.stringify(rss));
  const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined);
  plan.forEach(([r, s], i) => {
    const [w0, w1] = [from + i * 60_000, from + (i + 1) * 60_000];
    const appRssMiB = round(average(rss.filter((x) => x.t >= w0 && x.t < w1).map((x) => x.rssMiB)), 1);
    cell.stages.push({ ...segment(summary, i, r, s, r), phase: `minute ${i + 1}`, appRssMiB, resources: resourceSummary(stats.samples, w0, w1), pgbouncer: poolSummary(pools.rows, w0, w1) });
  });
  const first = cell.stages[0];
  const last = cell.stages.at(-1);
  cell.extra = {
    rateRps: rate, minutes, windowsPassing: cell.stages.filter((s) => s.pass).length,
    failedRequests: Math.round(cell.stages.reduce((n, s) => n + s.requests * (s.errorRate ?? 0), 0)),
    appRssMiB: { firstMinute: first?.appRssMiB, lastMinute: last?.appRssMiB, min: round(Math.min(...rss.map((x) => x.rssMiB)), 1), max: round(Math.max(...rss.map((x) => x.rssMiB)), 1) },
    pgMemMiB: { firstMinute: first?.resources?.[NAMES.pg]?.memAvgMiB, lastMinute: last?.resources?.[NAMES.pg]?.memAvgMiB },
    p95Ms: { firstMinute: first?.p95Ms, lastMinute: last?.p95Ms, worst: round(Math.max(...cell.stages.map((s) => s.p95Ms ?? 0))) },
  };
};

// ---- Setup ------------------------------------------------------------------------

/** Runs warm-up windows until stable (see WARMUP) or the time limit; returns what happened (duration, windows, stable). */
async function warmUp(tier: TierName, env: Record<string, string | number>, raw: string, maxSeconds: number) {
  const rate = WARMUP.rps[tier];
  const started = Date.now();
  const windows: { p50Ms?: number; p95Ms?: number; errorRate?: number; pass: boolean }[] = [];
  let stable = false;
  const minWindows = WARMUP.stableWindows;
  for (let i = 0; Date.now() - started < maxSeconds * 1000; i++) {
    const s = segment(await k6({ ...env, START_RATE: rate, PLAN: JSON.stringify([[rate, WARMUP.windowSeconds]]) }, join(raw, `w${i}.json`)), 0, rate, WARMUP.windowSeconds, rate);
    windows.push({ p50Ms: s.p50Ms, p95Ms: s.p95Ms, errorRate: s.errorRate, pass: s.pass });
    const last = windows.slice(-WARMUP.stableWindows);
    const p95 = last.map((w) => w.p95Ms ?? Infinity);
    stable = windows.length >= minWindows && last.length === WARMUP.stableWindows && last.every((w) => w.pass) && (Math.max(...p95) < 10 || Math.max(...p95) / Math.min(...p95) <= WARMUP.maxP95Ratio);
    if (stable) break;
    if (unhealthy()) break;
  }
  log(`  warm-up ${env.OP} @${rate} rps: ${windows.length} windows, ${stable ? "stable" : "NOT stable"}, p95 ${windows.map((w) => w.p95Ms).join("/")}`);
  return { op: env.OP, rateRps: rate, seconds: round((Date.now() - started) / 1000, 1), stable, windows };
}

/** Cold tenants: PostgreSQL was restarted just before; constant point load over 10,000 tenants in 15 s windows. Records the first
 * access penalty, block reads and backend memory (pg_log_backend_memory_contexts for three backends at the end). */
const cold = (tier: TierName, minutes: number): Body => async (cell, env, raw, { stats, pools }) => {
  const rate = WARMUP.rps[tier] * 2;
  const plan = Array.from({ length: minutes * 4 }, () => [rate, 15] as [number, number]);
  const blocks: { t: number; read: number; hit: number }[] = [];
  let polling = true;
  const poller = (async () => {
    let prev = pgStat();
    while (polling) {
      await Bun.sleep(15_000);
      const now = pgStat();
      const d = diffStat(prev, now);
      prev = now;
      blocks.push({ t: Date.now(), read: (d.db0?.blks_read ?? 0) + (d.db1?.blks_read ?? 0), hit: (d.db0?.blks_hit ?? 0) + (d.db1?.blks_hit ?? 0) });
    }
  })();
  const from = Date.now();
  const summary = await k6({ ...env, START_RATE: rate, PLAN: JSON.stringify(plan) }, join(raw, "cold.json"));
  polling = false;
  await poller;
  plan.forEach(([r, s], i) => {
    const [w0, w1] = [from + i * 15_000, from + (i + 1) * 15_000];
    const b = blocks.find((x) => x.t > w0 && x.t <= w1 + 2000);
    cell.stages.push({ ...segment(summary, i, r, s, r), phase: `${i * 15}-${(i + 1) * 15}s`, resources: resourceSummary(stats.samples, w0, w1), pgbouncer: poolSummary(pools.rows, w0, w1), blocks: b && { read: b.read, hit: b.hit } } as Stage);
  });
  const since = new Date().toISOString();
  psql("db0", "SELECT pg_log_backend_memory_contexts(pid) FROM (SELECT pid FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid() LIMIT 3) x");
  await Bun.sleep(1500);
  const logs = sh(["docker", "logs", "--since", since, NAMES.pg], { allowFail: true }).err.split("\n");
  const cache = logs.filter((l) => /CacheMemoryContext: \d+ total/.test(l)).map((l) => Number(/CacheMemoryContext: (\d+) total/.exec(l)?.[1]) / 1048576);
  const grand = logs.filter((l) => /Grand total: \d+ bytes/.test(l)).map((l) => Number(/Grand total: (\d+) bytes/.exec(l)?.[1]) / 1048576);
  const ps = sh(["docker", "exec", NAMES.pg, "sh", "-c", "ps -o rss,args | grep 'postgres: admin' | grep -v grep | awk '{print $1}'"], { allowFail: true }).out.split("\n").filter(Boolean).map((kb) => Number(kb) / 1024);
  const first = cell.stages[0];
  const settled = cell.stages.slice(-4);
  cell.extra = {
    rateRps: rate, minutes, firstWindowP95Ms: first?.p95Ms, lastMinuteP95Ms: settled.map((s) => s.p95Ms),
    windowsMissingSlo: cell.stages.filter((s) => !s.pass).map((s) => s.phase),
    backendMemoryMiB: {
      cacheMemoryContext: cache.map((x) => round(x, 1)), grandTotal: grand.map((x) => round(x, 1)), backends: ps.length,
      rssPsMiB: { avg: round(ps.reduce((a, b) => a + b, 0) / (ps.length || 1), 1), max: round(Math.max(0, ...ps), 1) },
      note: "CacheMemoryContext holds relcache/catcache (grows with the number of tenant schemas a backend touched); ps RSS includes touched shared buffers",
    },
    blocksNote: "blocks = pg_stat_database blks_read/blks_hit delta for db0+db1 per ~15 s poll",
  };
};

type Setup = Record<string, unknown>;

async function setupPhase() {
  if (result.setup?.status === "ok") return log("setup already done");
  // Resumable: completed sub-steps (recorded in the result file) are not repeated.
  const setup: Setup = result.setup ?? { status: "failed", startedAt: new Date().toISOString(), tier: "T4", volume: flags.volume, managementDriver: "bun" };
  result.setup = setup;
  stopAll();
  await startPostgres("T4", flags.volume as string);
  stack = { tier: "T4" };
  if (!setup.demoProvision) await provisionTenants(setup);
  // Rows: server-side generation deliberately bypasses the package API (the tested queries go through the API).
  if (!setup.tenantRows) await loadTenantRows(setup);
  if (!setup.bigTenant) await loadBigTenant(setup);
  await vacuumAndSizes(setup);
  setup.status = "ok";
  setup.finishedAt = new Date().toISOString();
  save();
}

/** Bootstrap through the package, TENANTS tenants, demo tenants and the big tenant. */
async function provisionTenants(setup: Setup) {
  const m = createManagement(createConfig(directUrls()), { driver: bunDriver, perDatabaseConcurrency: 16 });
  try {
    let t = Date.now();
    await bootstrap(m);
    setup.bootstrapMs = Date.now() - t;
    // Through the package: placement, schema, migrations, install seeds, activation.
    const ids = Array.from({ length: TENANTS }, (_, i) => tenantName(i));
    const concurrency = Number(flags["provision-concurrency"]);
    const retried: Record<string, number> = {};
    const checkpoints: { tenants: number; seconds: number }[] = [];
    let done = 0;
    t = Date.now();
    await eachLimit(ids, concurrency, async (id, i) => {
      await provisionWithRetry(m, id, `db${i % 2}`, retried);
      if (++done % 1000 === 0) {
        checkpoints.push({ tenants: done, seconds: round((Date.now() - t) / 1000, 1) as number });
        log(`provisioned ${done}`);
      }
    });
    const seconds = (Date.now() - t) / 1000;
    setup.provision = { tenants: TENANTS, concurrency, seconds: round(seconds, 1), tenantsPerSecond: round(TENANTS / seconds, 1), checkpoints, retriedErrors: retried };
    t = Date.now();
    for (let i = 0; i < DEMO_TENANTS; i++) await provisionTenant(m, demoName(i), `db${i % 2}`, { demo: true });
    setup.demoProvision = { tenants: DEMO_TENANTS, concurrency: 1, seconds: round((Date.now() - t) / 1000, 1), note: "includes the demo login seed (Better Auth password hash)" };
    await provisionTenant(m, BIG_TENANT, "db1");
  } finally {
    await m.close();
  }
}

/** At most 3 attempts; retried errors are counted by code in `retried`. */
async function provisionWithRetry(m: Management, id: string, database: string, retried: Record<string, number>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await provisionTenant(m, id, database);
      return;
    } catch (error) {
      const code = errorCode(error) ?? "UNKNOWN";
      retried[code] = (retried[code] ?? 0) + 1;
      if (attempt >= 3) throw error;
    }
  }
}

/** TENANT_USERS users per tenant; 2 parallel psql sessions per database. */
async function loadTenantRows(setup: Setup) {
  const t = Date.now();
  const schemas = (db: string) =>
    psql("db0", `SELECT schema_name FROM platform.placements WHERE database_id='${db}' AND kind='tenant' AND tenant_id ~ '^t[0-9]{5}$' ORDER BY tenant_id`).split("\n").filter(Boolean);
  await Promise.all(
    ["db0", "db1"].flatMap((db) => {
      const all = schemas(db);
      return [0, 1].map((part) =>
        psqlScript(db, all.filter((_, i) => i % 2 === part).map((s) => rowsSql(s, 1, TENANT_USERS, true)).join("\n")),
      );
    }),
  );
  setup.tenantRows = { seconds: round((Date.now() - t) / 1000, 1), rowsPerTenant: TENANT_USERS, parallelPsqlSessions: 4 };
  save();
}

/** Empties the big tenant and fills it with BIG_USERS users in 1M-row chunks. */
async function loadBigTenant(setup: Setup) {
  const big = psql("db0", `SELECT schema_name FROM platform.placements WHERE tenant_id='${BIG_TENANT}'`);
  // CASCADE: session/account/user_imports are tied to users by FK.
  await psqlScript("db1", `TRUNCATE "${big}".users CASCADE;`);
  const t = Date.now();
  for (let from = 1; from <= BIG_USERS; from += 1_000_000) await psqlScript("db1", rowsSql(big, from, Math.min(BIG_USERS, from + 999_999)));
  const usersSeconds = round((Date.now() - t) / 1000, 1);
  log(`big tenant users: ${usersSeconds} s`);
  setup.bigTenant = { tenant: BIG_TENANT, database: "db1", users: BIG_USERS, chunkRows: 1_000_000, usersSeconds };
  save();
}

/** VACUUM (ANALYZE) on both databases, then database and disk sizes. */
async function vacuumAndSizes(setup: Setup) {
  const t = Date.now();
  for (const db of ["db0", "db1"]) {
    try {
      await psqlScript(db, "VACUUM (ANALYZE);");
    } catch (error) {
      // Recorded, then retried once (the first attempt ran with --shm-size=128m).
      result.failures.push({ key: `setup/vacuum/${db}`, error: String(error).slice(0, 400), at: new Date().toISOString() });
      save();
      throw error;
    }
  }
  setup.vacuumAnalyzeSeconds = round((Date.now() - t) / 1000, 1);
  setup.sizes = {
    databasesMiB: Object.fromEntries(psql("db0", "SELECT datname, pg_database_size(datname)/1048576 FROM pg_database WHERE datname IN ('db0','db1')").split("\n").map((l) => l.split("|"))),
    ...dataDirSize(), disk: diskFree(),
  };
}

// ---- Summary -------------------------------------------------------------------

const cellsOf = (phase: string) => Object.values(result.cells).filter((c) => c.phase === phase && c.status === "ok");
function maxOf(tier: TierName, driver: string, scenario: string) {
  const values = [...cellsOf("matrix"), ...cellsOf("repeat")].filter((c) => c.tier === tier && c.driver === driver && c.scenario === scenario).map((c) => c.maxRpsAtSlo ?? 0);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}
function fastest() {
  const scores = DRIVERS.map((driver) => {
    const values = (["T2", "T4"] as const).flatMap((tier) => ["point", "mixed"].map((s) => maxOf(tier, driver, s))).filter((v) => v !== undefined);
    return { driver, meanMaxRps: values.length === 4 ? round(values.reduce((a, b) => a + b, 0) / 4, 1) : undefined };
  });
  const best = [...scores].sort((a, b) => (b.meanMaxRps ?? -1) - (a.meanMaxRps ?? -1))[0];
  const driver = flags.driver ?? best?.driver ?? "bun";
  return { driver, reason: flags.driver ? "--driver flag" : "highest mean max RPS at SLO over T2/T4 × point/mixed (matrix + repeats)", scores };
}
function summarize() {
  const brief = (c: Cell) => ({
    tier: c.tier, driver: c.driver, scenario: c.scenario, repeat: c.repeat, maxRpsAtSlo: c.maxRpsAtSlo, firstMissRps: c.firstMissRps, ceilingReached: c.ceilingReached,
    durationS: c.durationS, notes: c.notes,
    p50Ms: c.atMax?.p50Ms, p95Ms: c.atMax?.p95Ms, p99Ms: c.atMax?.p99Ms, errorRate: c.atMax?.errorRate,
    pgCpuAvgPct: c.atMax?.resources?.[NAMES.pg]?.cpuAvgPct, pgMemMaxMiB: c.atMax?.resources?.[NAMES.pg]?.memMaxMiB,
    appCpuAvgPct: c.atMax?.resources?.[NAMES.app]?.cpuAvgPct, appMemMaxMiB: c.atMax?.resources?.[NAMES.app]?.memMaxMiB,
    bouncerCpuAvgPct: c.atMax?.resources?.[NAMES.bouncer]?.cpuAvgPct, maxClWaiting: c.atMax?.pgbouncer?.maxClWaiting,
    oomKills: c.delta?.oomKills, appErrors: c.delta?.app.errors,
  });
  const groups = new Map<string, Cell[]>();
  for (const c of [...cellsOf("matrix"), ...cellsOf("repeat")]) {
    const key = `${c.tier}/${c.driver}/${c.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const variance = [...groups].filter(([, cs]) => cs.length > 1).map(([key, cs]) => {
    const values = cs.map((c) => c.maxRpsAtSlo ?? 0);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
    return { key, runs: values.length, maxRpsAtSlo: values, mean: round(mean, 1), stdev: round(stdev, 1), cv: round(mean ? stdev / mean : 0, 3), p95AtMaxMs: cs.map((c) => c.atMax?.p95Ms) };
  });
  return {
    fastest: fastest(),
    matrix: cellsOf("matrix").map(brief),
    repeats: cellsOf("repeat").map(brief),
    variance,
    extra: cellsOf("extra").map((c) => ({ ...brief(c), extra: c.extra })),
    soak: cellsOf("soak").map((c) => ({ ...brief(c), extra: c.extra })),
    failedCells: Object.values(result.cells).filter((c) => c.status !== "ok").map((c) => ({ key: c.key, error: c.error })),
  };
}

// ---- Main flow ------------------------------------------------------------------------

try {
  for (const phase of list(flags.phase)) {
    if (phase === "setup") await setupPhase();
    else if (phase === "summary") {
      for (const cell of Object.values(result.cells)) if (["matrix", "repeat"].includes(cell.phase) || (cell.phase === "extra" && cell.scenario !== "spike")) applyLadderMax(cell);
    }
    else if (phase === "matrix") {
      for (const tier of list(flags.tiers) as TierName[])
        for (const driver of DRIVERS) for (const scenario of list(flags.scenarios)) await runCell("matrix", tier, driver, scenario, scenario, 0, ladder);
    } else if (phase === "repeat") {
      const { driver } = fastest();
      for (let r = 1; r <= Number(flags.repeats); r++)
        for (const tier of ["T2", "T4"] as const) for (const scenario of ["point", "mixed"]) await runCell("repeat", tier, driver, scenario, scenario, r, ladder);
    } else if (phase === "extra") {
      const { driver } = fastest();
      for (const tier of ["T2", "T4"] as const) {
        for (const scenario of ["hotpoint", "range", "insert", "auth"]) await runCell("extra", tier, driver, scenario, scenario, 0, ladder);
        const base = Math.max(5, Math.round((maxOf(tier, driver, "mixed") ?? 50) / 5));
        await runCell("extra", tier, driver, "spike", "mixed", 0, spike(base));
      }
    } else if (phase === "discard-v1") {
      // Method v1 (20 s × 25 rps warm-up, PgBouncer LIFO reuse) measured cold tenant access, not capacity: keep it, do not mix.
      result.discarded ??= [];
      for (const [key, cell] of Object.entries(result.cells)) {
        result.discarded.push({ ...cell, discardReason: "method v1 superseded: 20 s × 25 rps warm-up and PgBouncer LIFO backend reuse measured mostly cold tenant access (10k schemas) and restart noise; whole matrix re-run with the v2 stability warm-up" });
        delete result.cells[key];
      }
      result.notes.push(`method v2 from ${new Date().toISOString()}: stability warm-up (WARMUP in settings), PgBouncer min_pool_size=10 and server_round_robin=1; cold access is its own 'cold' scenario`);
      save();
    } else if (phase === "cold") {
      const { driver } = fastest();
      for (const tier of ["T2", "T4"] as const) await runCell("cold", tier, driver, "cold", "point", 0, cold(tier, Number(flags["cold-minutes"])));
    } else if (phase === "soak") {
      const { driver } = fastest();
      const rate = Math.max(10, Math.round((maxOf("T2", driver, "mixed") ?? 50) * 0.5));
      await runCell("soak", "T2", driver, "soak", "mixed", 0, soak(rate, Number(flags["soak-minutes"])));
    } else throw new Error(`Unknown phase ${phase}`);
  }
} finally {
  save();
  stopAll();
  log(`results: ${file}`);
}
