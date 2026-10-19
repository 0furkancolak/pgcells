/** Hızlı karşılaştırma (`bun src/__tests__/bench/compare.ts`): tek küçük kümede paket ile aynı sürücünün doğrudan kullanımı ("normal":
 * elle yazılmış şema nitelikli SQL, tenant yönlendirmesi yok), ayrıca her yönetim adımının ne kadar sürdüğü.
 *  management  bootstrap, provision (tenant, demo), migrate/seed no-op'ları, son tenant migration'ının rollback + yeniden uygulanması, `users` satır yüklemeleri
 *  inProcess   sürücü başına, host → PgBouncer, sıralı: tenantFromHost, placement okuması, ilk/ikinci tenant erişimi,
 *              nokta okuması ve insert transaction (normal ve paket, dönüşümlü), ORDER BY düzeltmesi öncesi/sonrası `users` sayfası
 *  http        tier ve sürücü başına, k6 → düzenek uygulaması (2 CPU / 512 MB): 64 VU ile azami throughput ve 200 rps'de gecikme;
 *              /health, normal ve paket nokta okumaları ile insert transaction'ları */
import { parseArgs } from "node:util";
import { createConfig, createDatabase, tenantFromHost } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { bootstrap, createManagement, migrateAll, migrateTenant, prepareQuery, provisionTenant, resetDemoTenant, rollbackTenant, seedTenant } from "@0furkancolak/pgcells/management";
import { loadDriver } from "./drivers";
import {
  appMetrics, benchEmail, bouncerUrls, demoName, diffStat, directUrls, distribution, environment, k6, log, NAMES, pgStat, psql, psqlScript,
  RAW_DIR, resourceSummary, RESULTS_DIR, round, rowsSql, saveResult, segment, sh, stamp, startApp, startBouncer, startPostgres, startStats, stopAll,
  tenantName, type TierName, timeIt, uuidOf,
} from "./lib";

const { values: flags } = parseArgs({
  options: {
    tenants: { type: "string", default: "100" },
    rows: { type: "string", default: "10000" },
    big: { type: "string", default: "1000000" },
    seconds: { type: "string", default: "15" },
    drivers: { type: "string", default: "bun,postgres,pg" },
    tiers: { type: "string", default: "T3,T1" },
    "low-tier-drivers": { type: "string", default: "bun" },
    samples: { type: "string", default: "2000" },
  },
});
const TENANTS = Number(flags.tenants);
const ROWS = Number(flags.rows);
const BIG_ROWS = Number(flags.big);
const SECONDS = Number(flags.seconds);
const SAMPLES = Number(flags.samples);
const TIERS = (flags.tiers as string).split(",") as TierName[];
const BIG = "big";
const VOLUME = "repo-db-bench-compare";
const run = `compare-${stamp()}`;
const file = `${RESULTS_DIR}/${run}.json`;

const rand = (n: number) => Math.floor(Math.random() * n);
/** Geçerli adım; hatayla birlikte kaydedilir, böylece bir sürücünün hatası diğerlerini durdurmaz. */
let stage = "";
const failed = (error: unknown) => ({ error: String(error), code: (error as { code?: string }).code, stage });
const result: Record<string, unknown> = {
  schema: "repo-db-bench/compare@1", run, startedAt: new Date().toISOString(), environment: environment(),
  settings: { tiers: TIERS, tenants: TENANTS, rowsPerTenant: ROWS, bigTenantUsers: BIG_ROWS, seconds: SECONDS, samples: SAMPLES, httpVus: 64, fixedRateRps: 200 },
  notes: [] as string[],
};
const save = () => saveResult(file, { ...result, updatedAt: new Date().toISOString() });

async function management() {
  const out: Record<string, unknown> = {};
  const m = createManagement(createConfig(directUrls()), { driver: bunDriver, perDatabaseConcurrency: 8 });
  try {
    out.bootstrapMs = round(await timeIt(() => bootstrap(m)));
    const sequential: number[] = [];
    for (let i = 0; i < 20; i++) sequential.push(await timeIt(() => provisionTenant(m, tenantName(i), `db${i % 2}`)));
    out.provisionTenant = { ...distribution(sequential), note: "sequential; placement + schema + tenant migrations (auth, user_imports) + activation" };
    let t = performance.now();
    const rest = Array.from({ length: TENANTS - 20 }, (_, i) => i + 20);
    for (let k = 0; k < rest.length; k += 8) await Promise.all(rest.slice(k, k + 8).map((i) => provisionTenant(m, tenantName(i), `db${i % 2}`)));
    const s = (performance.now() - t) / 1000;
    out.provisionConcurrent = { tenants: rest.length, concurrency: 8, seconds: round(s), tenantsPerSecond: round(rest.length / s, 1) };
    await provisionTenant(m, BIG, "db1");
    const demo: number[] = [];
    for (let i = 0; i < 5; i++) demo.push(await timeIt(() => provisionTenant(m, demoName(i), `db${i % 2}`, { demo: true })));
    out.provisionDemo = { ...distribution(demo), note: "includes the demo login seed (Better Auth user with password hash)" };
    out.resetDemoMs = round(await timeIt(() => resetDemoTenant(m, demoName(0))));
    out.seedTenantNoopMs = round(await timeIt(() => seedTenant(m, tenantName(0))));
    out.migrateTenantNoopMs = round(await timeIt(() => migrateTenant(m, tenantName(0))));
    const before = pgStat();
    const noop = await timeIt(() => migrateAll(m));
    out.migrateAllNoop = { tenants: TENANTS + 6, ms: round(noop), xactDelta: Object.fromEntries(Object.entries(diffStat(before, pgStat())).map(([db, d]) => [db, d.xact_commit])), note: "xact_commit delta includes the stats reads themselves" };

    t = performance.now();
    const schemas = psql("db0", "SELECT database_id || '|' || schema_name FROM platform.placements WHERE kind='tenant' AND tenant_id <> 'big'").split("\n").map((l) => l.split("|"));
    await Promise.all(["db0", "db1"].map((db) => psqlScript(db, schemas.filter(([d]) => d === db).map(([, sc]) => rowsSql(sc!, 1, ROWS)).join("\n"))));
    out.loadTenantRows = { tenants: TENANTS, rows: TENANTS * ROWS, seconds: round((performance.now() - t) / 1000) };
    const big = psql("db0", `SELECT schema_name FROM platform.placements WHERE tenant_id='${BIG}'`);
    t = performance.now();
    for (let from = 1; from <= BIG_ROWS; from += 1_000_000) await psqlScript("db1", rowsSql(big, from, Math.min(BIG_ROWS, from + 999_999)));
    out.loadBigTenant = { users: BIG_ROWS, seconds: round((performance.now() - t) / 1000) };
    t = performance.now();
    await Promise.all(["db0", "db1"].map((db) => psqlScript(db, "VACUUM (ANALYZE);")));
    out.vacuumAnalyzeSeconds = round((performance.now() - t) / 1000);
    out.rollbackLastMigrationBigMs = round(await timeIt(() => rollbackTenant(m, BIG, { steps: 1 })));
    out.migrateLastMigrationBigMs = { ms: round(await timeIt(() => migrateTenant(m, BIG))), note: `user_imports (CREATE TABLE + index, FK to users) on a tenant with ${BIG_ROWS.toLocaleString("en")} users` };
    out.sizesMiB = Object.fromEntries(["db0", "db1"].map((db) => [db, Number(psql("db0", `SELECT pg_database_size('${db}') / 1048576`))]));
  } finally {
    await m.close();
  }
  return out;
}

async function inProcess(name: string) {
  const driver = await loadDriver(name);
  const urls = bouncerUrls();
  const rawPools = urls.map((url) => driver(url, { max: 10, idleTimeoutSeconds: 30, maxLifetimeSeconds: 1800, connectTimeoutSeconds: 10 }));
  const placements = new Map(psql("db0", "SELECT tenant_id || '|' || database_id || '|' || schema_name FROM platform.placements").split("\n").map((l) => {
    const [tenant, db, schema] = l.split("|");
    return [tenant!, { pool: rawPools[Number(db!.slice(2))]!, schema: `"${schema}"` }];
  }));
  const db = createDatabase(createConfig(urls), { driver, poolMax: 10 });
  const point = prepareQuery("SELECT id::text AS id, name, email FROM users WHERE id = $1::uuid");
  const insertUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text) RETURNING id::text AS id, name");
  const listUsers = prepareQuery("SELECT id::text AS id, name FROM users ORDER BY users.id LIMIT $1 OFFSET $2");
  const out: Record<string, unknown> = {};
  try {
    const t = performance.now();
    for (let i = 0; i < 100_000; i++) tenantFromHost("t00042.bench.test:443", "bench.test");
    out.tenantFromHostUs = round(((performance.now() - t) / 100_000) * 1000, 4);
    const first: number[] = [];
    const second: number[] = [];
    stage = "firstTouch";
    for (let i = 0; i < TENANTS; i++) first.push(await timeIt(() => db.withTenant(tenantName(i), (c) => c.query(point, [uuidOf(1)]))));
    for (let i = 0; i < TENANTS; i++) second.push(await timeIt(() => db.withTenant(tenantName(i), (c) => c.query(point, [uuidOf(1)]))));
    out.firstTouch = { ...distribution(first), note: "new process: placement read + tenant query" };
    out.secondTouch = distribution(second);
    const placement: number[] = [];
    stage = "placementGet";
    for (let i = 0; i < SAMPLES; i++) placement.push(await timeIt(() => db.platform.get(tenantName(rand(TENANTS)))));
    out.placementGet = distribution(placement);

    const normalPoint: number[] = [];
    const packagePoint: number[] = [];
    stage = "point";
    for (let i = 0; i < SAMPLES; i++) {
      const tenant = tenantName(rand(TENANTS));
      const id = uuidOf(1 + rand(ROWS));
      const { pool, schema } = placements.get(tenant)!;
      normalPoint.push(await timeIt(() => pool.query(`SELECT id::text AS id, name, email FROM ${schema}.users WHERE id = $1::uuid`, [id])));
      packagePoint.push(await timeIt(() => db.withTenant(tenant, (c) => c.query(point, [id]))));
    }
    out.point = { normal: distribution(normalPoint), package: distribution(packagePoint) };

    const normalInsert: number[] = [];
    const packageInsert: number[] = [];
    stage = "insertTransaction";
    for (let i = 0; i < SAMPLES / 4; i++) {
      const tenant = tenantName(rand(TENANTS));
      const { pool, schema } = placements.get(tenant)!;
      normalInsert.push(await timeIt(async () => {
        const id = crypto.randomUUID();
        const tx = await pool.reserve();
        try {
          await tx.exec("BEGIN");
          await tx.query(`INSERT INTO ${schema}.users (id, name, email) VALUES ($1::uuid, $2, $3) RETURNING id::text AS id, name`, [id, "compare", benchEmail(id)]);
          await tx.exec("COMMIT");
        } finally {
          tx.release();
        }
      }));
      packageInsert.push(await timeIt(() => db.withTenant(tenant, (c) => c.transaction(async (tx) => {
        const id = crypto.randomUUID();
        await tx.query(insertUser, [id, "compare", benchEmail(id)]);
      }))));
    }
    out.insertTransaction = { normal: distribution(normalInsert), package: distribution(packageInsert) };

    const { pool, schema } = placements.get(BIG)!;
    const oldPage: number[] = [];
    const newPage: number[] = [];
    stage = "listUsersPage";
    for (let i = 0; i < 10; i++) oldPage.push(await timeIt(() => pool.query(`SELECT id::text AS id, name FROM ${schema}.users ORDER BY id LIMIT 20 OFFSET 0`)));
    for (let i = 0; i < 200; i++) newPage.push(await timeIt(() => db.withTenant(BIG, (c) => c.query(listUsers, [20, 0]))));
    out.listUsersPage = { rows: BIG_ROWS, beforeFix: distribution(oldPage), afterFix: distribution(newPage), note: "beforeFix: ORDER BY the text alias id (full scan + sort); afterFix: prepareQuery, ORDER BY users.id" };
  } finally {
    await db.close();
    await Promise.all(rawPools.map((p) => p.close(5000)));
  }
  return out;
}

async function http(tier: TierName, name: string) {
  await startApp(name, 10);
  const stats = startStats([NAMES.pg, NAMES.app, NAMES.bouncer]);
  const out: Record<string, unknown> = {};
  const base = { TENANTS, TENANT_USERS: ROWS, PRE_VUS: 64, MAX_VUS: 64 };
  const raw = `${RAW_DIR}/${run}/${tier}-${name}`;
  try {
    for (const op of ["rawpoint", "point", "cachedpoint"]) await k6({ ...base, OP: op, PLAN: JSON.stringify([[200, 5]]) }, `${raw}/warm-${op}.json`);
    for (const op of ["health", "rawpoint", "point", "cachedpoint", "rawinsert", "insert"]) {
      stage = `http ${op}`;
      const from = Date.now();
      const max = segment(await k6({ ...base, OP: op, PLAN: JSON.stringify([[20000, SECONDS]]) }, `${raw}/${op}-max.json`), 0, 20000, SECONDS, 20000);
      const resources = resourceSummary(stats.samples, from, Date.now());
      const fixed = segment(await k6({ ...base, OP: op, PLAN: JSON.stringify([[200, 10]]) }, `${raw}/${op}-200.json`), 0, 200, 10, 200);
      const pick = (s: typeof max) => ({ rps: s.achievedRps, p50Ms: s.p50Ms, p95Ms: s.p95Ms, p99Ms: s.p99Ms, errorRate: s.errorRate });
      out[op] = { max: pick(max), at200: pick(fixed), resources };
      log(`  ${tier} ${name} ${op}: ${max.achievedRps} rps p50 ${max.p50Ms} p95 ${max.p95Ms} err ${max.errorRate} | @200 p50 ${fixed.p50Ms} p95 ${fixed.p95Ms}`);
    }
    out.appErrors = (await appMetrics())?.errors;
  } finally {
    stats.stop();
  }
  return out;
}

stopAll();
sh(["docker", "volume", "rm", VOLUME], { allowFail: true });
try {
  await startPostgres(TIERS[0]!, VOLUME);
  await startBouncer();
  log("management");
  result.management = await management();
  save();
  const inProc: Record<string, unknown> = {};
  result.inProcess = inProc;
  for (const name of (flags.drivers as string).split(",")) {
    log(`in-process ${name}`);
    inProc[name] = await inProcess(name).catch(failed);
    save();
  }
  const httpResults: Record<string, Record<string, unknown>> = {};
  for (const [i, tier] of TIERS.entries()) {
    if (i > 0) {
      await startPostgres(tier, VOLUME);
      await startBouncer();
    }
    httpResults[tier] = {};
    const list = i === 0 ? (flags.drivers as string) : (flags["low-tier-drivers"] as string);
    for (const name of list.split(",")) {
      log(`http ${tier} ${name}`);
      httpResults[tier]![name] = await http(tier, name).catch(failed);
      result.http = httpResults;
      save();
    }
  }
  (result.notes as string[]).push("PgBouncer is limited to 0.5 CPU and the harness app to 2 CPU / 512 MB; k6 runs on the host. Both normal and package requests pass through the same app and PgBouncer.");
} finally {
  save();
  stopAll();
  sh(["docker", "volume", "rm", VOLUME], { allowFail: true });
  log(`saved ${file}`);
}
