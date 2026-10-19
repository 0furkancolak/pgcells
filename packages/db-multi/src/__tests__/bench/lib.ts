/** run.ts (yük) ve scale.ts (veri, migration, seed, move) için ortak benchmark altyapısı: kaynak limitli Docker konteynerleri,
 * PostgreSQL konteyneri içinde psql, docker stats / PgBouncer örnekleyicileri, k6 çağrıları ve sonuç dosyaları.
 * Yalnızca test kodu; buradaki hiçbir şey paket API'si değildir. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const BENCH_DIR = import.meta.dir;
export const PACKAGE_DIR = resolve(BENCH_DIR, "../../..");
export const REPO_DIR = resolve(PACKAGE_DIR, "../..");
export const RESULTS_DIR = join(BENCH_DIR, "results");
/** Ham k6 özetleri, örnekler, loglar ve geçici paket kopyaları (asla commit edilmez). */
export const RAW_DIR = process.env.BENCH_RAW_DIR ?? join(tmpdir(), "repo-db-bench");

export const IMAGES = { postgres: "postgres:16.15-alpine", bun: "oven/bun:1.3.14-alpine", pgbouncer: "repo-db-bench-pgbouncer" };
export const NAMES = { pg: "bench-pg", bouncer: "bench-pgbouncer", app: "bench-app", network: "bench-net" };
export const PORTS = { pg: 56432, bouncer: 56433, app: 58080 };
export const APP_URL = `http://127.0.0.1:${PORTS.app}`;
const USER = "admin";
const PASSWORD = "bench_password";
export const AUTH_SECRET = "bench-only-better-auth-secret-0123456789";
/** Tek PostgreSQL sunucusu iki tenant veritabanını da barındırır (db0 = platform + tenant'lar, db1 = tenant'lar): bir tier = bir konteyner. */
export const directUrls = () => ["db0", "db1"].map((db) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORTS.pg}/${db}`);
/** Host'tan görülen PgBouncer (compare.ts süreç içi ölçümleri). */
export const bouncerUrls = () => ["db0", "db1"].map((db) => `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORTS.bouncer}/${db}`);
const pooledUrls = ["db0", "db1"].map((db) => `postgres://${USER}:${PASSWORD}@${NAMES.bouncer}:5432/${db}`).join(",");

export type TierName = "T1" | "T2" | "T3" | "T4";
export interface Tier {
  cpus: number;
  memoryMb: number;
  settings: string[];
}
const pgSettings = (sharedBuffers: number, cache: number, maintenance: number, work: number) => [
  `shared_buffers=${sharedBuffers}MB`,
  `effective_cache_size=${cache}MB`,
  `maintenance_work_mem=${maintenance}MB`,
  `work_mem=${work}MB`,
  "max_connections=100",
  "max_wal_size=2GB",
];
/** PostgreSQL limitleri; shared_buffers = konteyner belleğinin %25'i. */
export const TIERS: Record<TierName, Tier> = {
  T1: { cpus: 0.25, memoryMb: 256, settings: pgSettings(64, 160, 32, 2) },
  T2: { cpus: 0.5, memoryMb: 512, settings: pgSettings(128, 320, 64, 4) },
  T3: { cpus: 1, memoryMb: 1024, settings: pgSettings(256, 640, 128, 4) },
  T4: { cpus: 2, memoryMb: 1536, settings: pgSettings(384, 1024, 256, 8) },
};
export const APP_LIMITS = { cpus: 2, memoryMb: 512 };
/** min_pool_size = default_pool_size ve server_round_robin = 1: tüm sunucu backend'leri baştan vardır ve eşit ısınır, böylece üst
 * rung soğuk backend getirmez (PgBouncer'ın varsayılan LIFO yeniden kullanımı düşük hızlarda backend'lerin çoğunu boşta bırakır). */
export const BOUNCER_LIMITS = { cpus: 0.5, memoryMb: 64, defaultPoolSize: 10, minPoolSize: 10, serverRoundRobin: 1, maxClientConn: 1000 };
export const SLO = { p95Ms: 50, errorRate: 0.01, minAchieved: 0.95 };

/** Deterministik kullanıcı id'leri 1..n; veri üretimi, düzenek ve k6 ortak kullanır. */
export const uuidOf = (i: number) => {
  const h = i.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const tenantName = (i: number) => `t${String(i).padStart(5, "0")}`;
export const demoName = (i: number) => `demo-${i}`;
/** Tenant id için HTTP Host başlığı (düzenek `<id>.bench.test` çözer). */
export const BENCH_ROOT = "bench.test";
export const hostOf = (tenantId: string) => `${tenantId}.${BENCH_ROOT}`;

export const log = (...parts: unknown[]) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
export const round = (value: number | undefined, digits = 2) => (value === undefined || !Number.isFinite(value) ? undefined : Number(value.toFixed(digits)));
export const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
/** Virgülle ayrılmış bayrak değeri → kırpılmış, boş olmayan parçalar. */
export const list = (value = "") => value.split(",").map((v) => v.trim()).filter(Boolean);
/** `work` süresi (ms). */
export async function timeIt(work: () => Promise<unknown>) {
  const t = performance.now();
  await work();
  return performance.now() - t;
}
/** Hatanın mesajı (Error değilse String); `max` verilirse o uzunlukta kesilir. */
export function messageOf(error: unknown, max?: number) {
  const message = error instanceof Error ? error.message : String(error);
  return max === undefined ? message : message.slice(0, max);
}

type Run = { ok: boolean; code: number; out: string; err: string };
/** Senkron komut; `allowFail` yoksa stderr kuyruğuyla hata fırlatır. */
export function sh(cmd: string[], { input, allowFail = false, cwd }: { input?: string; allowFail?: boolean; cwd?: string } = {}): Run {
  const proc = Bun.spawnSync(cmd, { cwd, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  const run = { ok: proc.exitCode === 0, code: proc.exitCode ?? -1, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
  if (!run.ok && !allowFail) throw new Error(`${cmd.slice(0, 4).join(" ")} failed (${run.code}): ${run.err.slice(-1500)}`);
  return run;
}
export async function shAsync(cmd: string[], { input, cwd, env }: { input?: string; cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const proc = Bun.spawn(cmd, { cwd, env, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, code, out, err };
}

/** `work`'ü `items` üzerinde aynı anda en fazla `concurrency` iş olacak şekilde çalıştırır. */
export async function eachLimit<T>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const index = next++;
        await work(items[index] as T, index);
      }
    }),
  );
}

/** En yakın sıra (nearest-rank) yüzdelikleri, ms. */
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  return { n: sorted.length, p50Ms: round(at(0.5)), p95Ms: round(at(0.95)), p99Ms: round(at(0.99)), maxMs: round(sorted.at(-1)) };
}

// ---- Docker ----------------------------------------------------------------

export function containerState(name: string) {
  const r = sh(["docker", "inspect", "-f", "{{.State.Status}} {{.State.OOMKilled}} {{.RestartCount}} {{.State.ExitCode}}", name], { allowFail: true });
  if (!r.ok) return undefined;
  const [status = "", oom, restarts, exitCode] = r.out.split(" ");
  return { status, oomKilled: oom === "true", restarts: Number(restarts), exitCode: Number(exitCode) };
}
/** Nazik durdurma (`docker stop -t 60`, asla kill yok), ardından konteyneri siler; volume'lar kalır. */
export function stopContainer(name: string) {
  if (!containerState(name)) return;
  sh(["docker", "stop", "-t", "60", name], { allowFail: true });
  sh(["docker", "rm", name], { allowFail: true });
}
export function stopAll() {
  for (const name of [NAMES.app, NAMES.bouncer, NAMES.pg]) stopContainer(name);
}
function ensureNetwork() {
  if (!sh(["docker", "network", "inspect", NAMES.network], { allowFail: true }).ok) sh(["docker", "network", "create", NAMES.network]);
}
const limits = (cpus: number, memoryMb: number) => [`--cpus=${cpus}`, `--memory=${memoryMb}m`, `--memory-swap=${memoryMb}m`];
/** Çalışan konteynerin cgroup v2 `oom_kill` sayacı (çalışmıyorsa undefined). */
export function oomKills(name: string) {
  const r = sh(["docker", "exec", name, "cat", "/sys/fs/cgroup/memory.events"], { allowFail: true });
  const match = r.ok ? /^oom_kill (\d+)$/m.exec(r.out) : null;
  return match ? Number(match[1]) : undefined;
}

/** `storage`: adlandırılmış volume ya da mutlak host yolu (bind mount; ör. 1B koşusu için harici disk). */
export async function startPostgres(tier: TierName, storage: string) {
  stopContainer(NAMES.pg);
  ensureNetwork();
  const { cpus, memoryMb, settings } = TIERS[tier];
  sh([
    "docker", "run", "-d", "--name", NAMES.pg, "--network", NAMES.network, "-p", `127.0.0.1:${PORTS.pg}:5432`, ...limits(cpus, memoryMb),
    // /dev/shm = konteyner belleği (aynı cgroup'tan düşer): 128m, T4'te paralel VACUUM'u düşürdü (DSM resize).
    `--shm-size=${memoryMb}m`, "-e", `POSTGRES_USER=${USER}`, "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", "POSTGRES_DB=db0",
    "-v", `${storage}:/var/lib/postgresql/data`, IMAGES.postgres, "postgres", ...settings.flatMap((s) => ["-c", s]),
  ]);
  const started = Date.now();
  // TCP hazır olma kontrolü: imajın init sırasındaki sunucusu yalnızca socket üzerinden dinler.
  while (!psqlTry("db0", "SELECT 1")) {
    if (containerState(NAMES.pg)?.status !== "running") throw new Error(`PostgreSQL exited: ${sh(["docker", "logs", "--tail", "30", NAMES.pg], { allowFail: true }).err}`);
    if (Date.now() - started > 900_000) throw new Error("PostgreSQL not ready after 15 min");
    await Bun.sleep(1000);
  }
  if (psql("db0", "SELECT count(*) FROM pg_database WHERE datname='db1'") === "0") psql("db0", "CREATE DATABASE db1");
  return { tier, readyMs: Date.now() - started };
}

export async function startBouncer() {
  stopContainer(NAMES.bouncer);
  if (!sh(["docker", "image", "inspect", IMAGES.pgbouncer], { allowFail: true }).ok)
    sh(["docker", "build", "-q", "-t", IMAGES.pgbouncer, join(PACKAGE_DIR, "src/core/local/pgbouncer")]);
  const dir = join(RAW_DIR, "pgbouncer");
  mkdirSync(dir, { recursive: true });
  const { defaultPoolSize, minPoolSize, serverRoundRobin, maxClientConn } = BOUNCER_LIMITS;
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    `[databases]\ndb0 = host=${NAMES.pg} port=5432 dbname=db0\ndb1 = host=${NAMES.pg} port=5432 dbname=db1\n\n[pgbouncer]\nlisten_addr = 0.0.0.0\nlisten_port = 5432\nunix_socket_dir = /tmp\nauth_type = plain\nauth_file = /etc/pgbouncer/userlist.txt\npool_mode = transaction\nmax_client_conn = ${maxClientConn}\ndefault_pool_size = ${defaultPoolSize}\nmin_pool_size = ${minPoolSize}\nserver_round_robin = ${serverRoundRobin}\nreserve_pool_size = 0\nquery_wait_timeout = 10\nserver_idle_timeout = 30\nmax_prepared_statements = 0\nadmin_users = ${USER}\n`,
  );
  writeFileSync(join(dir, "userlist.txt"), `"${USER}" "${PASSWORD}"\n`);
  sh([
    "docker", "run", "-d", "--name", NAMES.bouncer, "--network", NAMES.network, "-p", `127.0.0.1:${PORTS.bouncer}:5432`,
    ...limits(BOUNCER_LIMITS.cpus, BOUNCER_LIMITS.memoryMb), "-v", `${dir}/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro`,
    "-v", `${dir}/userlist.txt:/etc/pgbouncer/userlist.txt:ro`, IMAGES.pgbouncer,
  ]);
  for (let i = 0; !(await bouncerShow("POOLS")).length; i++) {
    if (i > 60) throw new Error("PgBouncer not ready");
    await Bun.sleep(500);
  }
}

export async function startApp(driver: string, poolMax: number) {
  stopContainer(NAMES.app);
  sh([
    "docker", "run", "-d", "--name", NAMES.app, "--network", NAMES.network, "-p", `127.0.0.1:${PORTS.app}:8080`,
    ...limits(APP_LIMITS.cpus, APP_LIMITS.memoryMb), "-v", `${REPO_DIR}:/repo:ro`, "-w", "/repo/packages/db-multi",
    "-e", `DATABASE_URLS=${pooledUrls}`, "-e", `BENCH_DRIVER=${driver}`, "-e", `BENCH_POOL_MAX=${poolMax}`, "-e", "PORT=8080",
    "-e", `BETTER_AUTH_SECRET=${AUTH_SECRET}`, IMAGES.bun, "bun", "src/__tests__/bench/server.ts",
  ]);
  for (let i = 0; ; i++) {
    if ((await fetch(`${APP_URL}/health`).catch(() => undefined))?.ok) return;
    if (i > 120 || containerState(NAMES.app)?.status !== "running")
      throw new Error(`Harness app not ready: ${sh(["docker", "logs", "--tail", "30", NAMES.app], { allowFail: true }).err}`);
    await Bun.sleep(500);
  }
}
export const appMetrics = async () =>
  (await fetch(`${APP_URL}/metrics`).then((r) => r.json()).catch(() => undefined)) as { rssMiB: number; heapUsedMiB: number; errors: Record<string, number>; requests: number } | undefined;

/** `sinceIso`'dan beri `docker logs` içinde öldürülmüş ya da çökmüş PostgreSQL backend'i gösteren satırlar. */
export function crashLines(name: string, sinceIso: string) {
  const r = sh(["docker", "logs", "--since", sinceIso, name], { allowFail: true });
  return `${r.out}\n${r.err}`.split("\n").filter((line) => /terminated by signal|out of memory|server process .* was terminated|PANIC|FATAL: .*recovery/i.test(line));
}

// ---- psql ve sunucu istatistikleri ---------------------------------------------

const psqlCmd = (db: string, extra: string[]) => [
  "docker", "exec", "-i", "-e", `PGPASSWORD=${PASSWORD}`, "-e", "PGOPTIONS=-c statement_timeout=0 -c lock_timeout=0", NAMES.pg,
  "psql", "-h", "127.0.0.1", "-U", USER, "-d", db, "-AtXq", "-v", "ON_ERROR_STOP=1", ...extra,
];
/** PostgreSQL konteyneri içinde, çalışma zamanı timeout varsayılanları olmadan admin SQL. Paketi bilerek atlar. */
export const psql = (db: string, sql: string) => sh(psqlCmd(db, ["-c", sql])).out;
export const psqlTry = (db: string, sql: string) => sh(psqlCmd(db, ["-c", sql]), { allowFail: true }).ok;
export async function psqlScript(db: string, script: string) {
  const r = await shAsync(psqlCmd(db, ["-f", "-"]), { input: script });
  if (!r.ok) throw new Error(`psql script failed: ${r.err.slice(-1500)}`);
  return r.out;
}

export async function bouncerShow(what: "POOLS" | "STATS"): Promise<Record<string, string>[]> {
  const r = await shAsync([
    "docker", "exec", "-e", `PGPASSWORD=${PASSWORD}`, NAMES.pg, "psql", "-h", NAMES.bouncer, "-p", "5432", "-U", USER, "-d", "pgbouncer",
    "-AXq", "-F", "\t", "-P", "footer=off", "-c", `SHOW ${what}`,
  ]);
  if (!r.ok) return [];
  const [header = "", ...rows] = r.out.trim().split("\n");
  const columns = header.split("\t");
  return rows.filter(Boolean).map((line) => Object.fromEntries(line.split("\t").map((value, i) => [columns[i] ?? i, value])));
}

const STAT_COLUMNS = ["xact_commit", "xact_rollback", "blks_read", "blks_hit", "tup_returned", "tup_fetched", "tup_inserted", "tup_updated", "tup_deleted", "temp_bytes", "deadlocks"];
export type PgStat = Record<string, Record<string, number>>;
export function pgStat(): PgStat {
  const out = psql("db0", `SELECT datname,${STAT_COLUMNS.join(",")} FROM pg_stat_database WHERE datname IN ('db0','db1') ORDER BY datname`);
  return Object.fromEntries(out.split("\n").map((line) => {
    const [db = "", ...values] = line.split("|");
    return [db, Object.fromEntries(STAT_COLUMNS.map((c, i) => [c, Number(values[i])]))];
  }));
}
export const diffStat = (before: PgStat, after: PgStat) =>
  Object.fromEntries(Object.entries(after).map(([db, values]) => [db, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v - (before[db]?.[k] ?? 0)]))]));

export function diskFree() {
  const out = sh(["docker", "exec", NAMES.pg, "df", "-Pk", "/var/lib/postgresql/data"]).out.split("\n").at(-1) ?? "";
  const [, sizeKb, usedKb, availKb] = out.split(/\s+/).map(Number);
  return { sizeGiB: round((sizeKb ?? 0) / 1048576), usedGiB: round((usedKb ?? 0) / 1048576), availableGiB: round((availKb ?? 0) / 1048576) };
}
export function dataDirSize() {
  const kb = (path: string) => Number(sh(["docker", "exec", NAMES.pg, "du", "-sk", path]).out.split(/\s+/)[0]);
  return { dataDirMiB: round(kb("/var/lib/postgresql/data") / 1024), walMiB: round(kb("/var/lib/postgresql/data/pg_wal") / 1024) };
}

// ---- Örnekleyiciler ----------------------------------------------------------------

export type StatSample = { t: number; name: string; cpuPct: number; memMiB: number };
const UNITS: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, kB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
/** `docker stats` akışı (konteyner başına saniyede yaklaşık bir örnek). CPU% çekirdek başınadır: 100 = bir tam çekirdek. */
export function startStats(names: string[]) {
  const samples: StatSample[] = [];
  const proc = Bun.spawn(["docker", "stats", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}", ...names], { stdout: "pipe", stderr: "ignore" });
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const [name, cpu, mem] = raw.replace(ANSI, "").trim().split("\t");
        const match = /^([\d.]+)\s*([A-Za-z]+)/.exec(mem ?? "");
        if (!name || !cpu || !match || name === "NAME") continue;
        samples.push({ t: Date.now(), name, cpuPct: Number.parseFloat(cpu), memMiB: Number(match[1]) * (UNITS[match[2] ?? ""] ?? 1) });
      }
    }
  })();
  return { samples, stop: () => proc.kill() };
}
export function resourceSummary(samples: StatSample[], from: number, to: number) {
  const out: Record<string, { cpuAvgPct?: number; cpuMaxPct?: number; memAvgMiB?: number; memMaxMiB?: number; n: number }> = {};
  for (const name of new Set(samples.map((s) => s.name))) {
    const window = samples.filter((s) => s.name === name && s.t >= from && s.t <= to);
    if (!window.length) continue;
    const avg = (key: "cpuPct" | "memMiB") => window.reduce((sum, s) => sum + s[key], 0) / window.length;
    out[name] = {
      cpuAvgPct: round(avg("cpuPct"), 1),
      cpuMaxPct: round(Math.max(...window.map((s) => s.cpuPct)), 1),
      memAvgMiB: round(avg("memMiB"), 1),
      memMaxMiB: round(Math.max(...window.map((s) => s.memMiB)), 1),
      n: window.length,
    };
  }
  return out;
}

export type PoolSample = { t: number; clActive: number; clWaiting: number; svActive: number; svIdle: number; maxWaitMs: number };
/** Her `intervalMs`'de db0/db1 için SHOW POOLS. */
export function startPoolPoller(intervalMs = 2000) {
  const rows: PoolSample[] = [];
  let running = true;
  void (async () => {
    while (running) {
      const pools = (await bouncerShow("POOLS")).filter((p) => p.database === "db0" || p.database === "db1");
      const sum = (key: string) => pools.reduce((n, p) => n + Number(p[key] ?? 0), 0);
      if (pools.length)
        rows.push({
          t: Date.now(), clActive: sum("cl_active"), clWaiting: sum("cl_waiting"), svActive: sum("sv_active"), svIdle: sum("sv_idle"),
          maxWaitMs: Math.max(...pools.map((p) => Number(p.maxwait ?? 0) * 1000 + Number(p.maxwait_us ?? 0) / 1000)),
        });
      await Bun.sleep(intervalMs);
    }
  })();
  return { rows, stop: () => (running = false) };
}
export function poolSummary(rows: PoolSample[], from: number, to: number) {
  const window = rows.filter((r) => r.t >= from && r.t <= to);
  if (!window.length) return undefined;
  const max = (key: keyof PoolSample) => Math.max(...window.map((r) => r[key]));
  return { maxClWaiting: max("clWaiting"), maxSvActive: max("svActive"), maxWaitMs: round(max("maxWaitMs"), 1), n: window.length };
}
/** db0+db1 için PgBouncer SHOW STATS farkı: sorgular, transaction'lar ve istemcinin sunucu bağlantısı için ortalama beklemesi. */
export function bouncerDelta(before: Record<string, string>[], after: Record<string, string>[]) {
  const total = (rows: Record<string, string>[], key: string) =>
    rows.filter((r) => r.database === "db0" || r.database === "db1").reduce((n, r) => n + Number(r[key] ?? 0), 0);
  const d = (key: string) => total(after, key) - total(before, key);
  const queries = d("total_query_count");
  return { queries, transactions: d("total_xact_count"), waitMsTotal: round(d("total_wait_time") / 1000, 1), avgWaitMs: round(queries ? d("total_wait_time") / 1000 / queries : 0, 3) };
}

// ---- k6 ----------------------------------------------------------------------

export type K6Values = Record<string, number>;
export type K6Summary = { metrics: Record<string, { values: K6Values }> };
/** k6/load.js'in tek bir k6 koşusu. PLAN, [rps, seconds] segmentlerinden oluşan JSON listesidir; çıkış kodu 99 (eşik aşıldı) beklenir. */
export async function k6(env: Record<string, string | number>, summaryPath: string): Promise<K6Summary> {
  mkdirSync(dirname(summaryPath), { recursive: true });
  const vars = Object.entries({ BASE_URL: APP_URL, ...env, SUMMARY_PATH: summaryPath }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const r = await shAsync(["k6", "run", "--quiet", "--no-color", ...vars, join(BENCH_DIR, "k6", "load.js")], {
    env: { ...process.env, K6_NO_USAGE_REPORT: "true" },
  });
  if (![0, 99].includes(r.code) || !existsSync(summaryPath)) throw new Error(`k6 failed (${r.code}): ${(r.err || r.out).slice(-1500)}`);
  return JSON.parse(readFileSync(summaryPath, "utf8")) as K6Summary;
}
/** `index` numaralı plan segmentinin metrikleri (etiket seg:sNNN). `previousRate`: bu segmente giden 1 s rampanın başladığı hız. */
export function segment(summary: K6Summary, index: number, rate: number, seconds: number, previousRate: number) {
  const tag = `seg:s${String(index).padStart(3, "0")}`;
  const d = summary.metrics[`http_req_duration{${tag}}`]?.values ?? {};
  const requests = summary.metrics[`http_reqs{${tag}}`]?.values.count ?? 0;
  const errorRate = requests ? (summary.metrics[`http_req_failed{${tag}}`]?.values.rate ?? 0) : 1;
  const expected = (previousRate + rate) / 2 + rate * (seconds - 1);
  const pass = requests > 0 && (d["p(95)"] ?? Infinity) < SLO.p95Ms && errorRate < SLO.errorRate && requests >= SLO.minAchieved * expected;
  return {
    targetRps: rate, seconds, requests, achievedRps: round(requests / seconds, 1), p50Ms: round(d["p(50)"]), p90Ms: round(d["p(90)"]),
    p95Ms: round(d["p(95)"]), p99Ms: round(d["p(99)"]), maxMs: round(d.max), errorRate: round(errorRate, 4), pass,
  };
}

// ---- Ortam ve sonuçlar ---------------------------------------------------

export function environment() {
  const out = (cmd: string[]) => sh(cmd, { allowFail: true }).out;
  const docker = out(["docker", "info", "--format", "{{.ServerVersion}}|{{.NCPU}}|{{.MemTotal}}|{{.OperatingSystem}}|{{.KernelVersion}}"]).split("|");
  return {
    git: { sha: out(["git", "-C", REPO_DIR, "rev-parse", "HEAD"]), dirty: out(["git", "-C", REPO_DIR, "status", "--porcelain"]).length > 0 },
    versions: {
      bun: Bun.version, k6: out(["k6", "version"]).split("\n")[0], docker: docker[0], orbstack: out(["orb", "version"]).split("\n")[0],
      postgres: IMAGES.postgres, pgbouncer: out(["docker", "run", "--rm", "--entrypoint", "pgbouncer", IMAGES.pgbouncer, "--version"]).split("\n")[0],
      appImage: IMAGES.bun,
    },
    host: {
      cpu: out(["sysctl", "-n", "machdep.cpu.brand_string"]), cpus: Number(out(["sysctl", "-n", "hw.ncpu"])),
      memGiB: round(Number(out(["sysctl", "-n", "hw.memsize"])) / 1073741824), macos: out(["sw_vers", "-productVersion"]),
    },
    vm: { cpus: Number(docker[1]), memGiB: round(Number(docker[2]) / 1073741824), os: docker[3], kernel: docker[4] },
    otherContainers: out(["docker", "ps", "--format", "{{.Names}}"]).split("\n").filter((n) => n && !Object.values(NAMES).includes(n)),
  };
}
export function saveResult(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
}
export const loadResult = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);

/** Sunucu tarafında `users` satırı üretimi (paket API'sini bilerek atlar; test edilen sorgular API'den geçer). Id'ler 1..n
 * deterministiktir (`uuidOf`); e-posta sıra numarasından türetilir (benzersiz). */
export function rowsSql(schema: string, from: number, to: number, idempotent = false) {
  const conflict = idempotent ? " ON CONFLICT DO NOTHING" : "";
  return `INSERT INTO "${schema}".users (id, name, email) SELECT lpad(to_hex(g), 32, '0')::uuid, 'user-' || lpad(g::text, 10, '0'), 'user-' || g || '@bench.test' FROM generate_series(${from}, ${to}) g${conflict};`;
}
/** Düzenek ve karşılaştırmalardaki tek satırlık kullanıcı insert'ü için benzersiz e-posta. */
export const benchEmail = (id: string) => `${id}@bench.test`;
