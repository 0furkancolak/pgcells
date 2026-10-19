/** Span timeline (`bun src/__tests__/bench/spans.ts [driver]`): real operations via `onSpan`; per-step durations are written to
 * `results/spans-<stamp>.json`. Uses the local compose stack (direct URLs for management, PgBouncer for runtime):
 *  management  provision (tenant lock, session, selection, claim, schema, each migration, each seed, activation), migrate/seed no-ops,
 *              full + incremental backup per tenant, move phases (including the placement cache wait)
 *  request     withTenant point read (cold placement read and cached), insert transaction: acquire, query, transaction */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, createDatabase, type Span } from "@0furkancolak/pgcells";
import { bootstrap, createManagement, migrateAll, prepareQuery, provisionTenant, seedAll } from "@0furkancolak/pgcells/management";
import { backupAll, startMove } from "@0furkancolak/pgcells/tools";
import { loadDriver } from "./drivers";
import { LOCAL_BOUNCER_URLS, LOCAL_DIRECT_URLS } from "./local";

const name = process.argv[2] ?? "bun";
const driver = await loadDriver(name);
const direct = process.env.DIRECT_URLS?.split(",") ?? LOCAL_DIRECT_URLS;
const bouncer = process.env.DATABASE_URLS?.split(",") ?? LOCAL_BOUNCER_URLS;
const run = `spans-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
const prefix = `sp${Date.now().toString(36)}`;

type Recorded = Span & { phase: string };
const spans: Recorded[] = [];
let phase = "";
const record = (span: Span) => void spans.push({ ...span, phase });
const at = async <T>(label: string, work: () => Promise<T>) => {
  phase = label;
  const startTime = Date.now();
  const start = performance.now();
  try {
    return await work();
  } finally {
    spans.push({ name: "total", startTime, ms: performance.now() - start, phase: label });
  }
};

const m = createManagement(createConfig(direct), { driver, onSpan: record });
const tenants = Array.from({ length: 6 }, (_, i) => `${prefix}-${i}`);
const backups = await mkdtemp(join(tmpdir(), "spans-backup-"));
try {
  await bootstrap(m);
  for (const [i, t] of tenants.entries()) await at("provision", () => provisionTenant(m, t, `db${i % 2}`));
  await at("provision-demo", () => provisionTenant(m, `${prefix}-demo`, "db1", { demo: true }));
  await at("migrate-all-noop", () => migrateAll(m, { databaseIds: ["db0", "db1"] }));
  await at("seed-all-noop", () => seedAll(m));
  await at("backup-full", () => backupAll(m, backups, { full: true, tenants }));
  await at("backup-incremental", () => backupAll(m, backups, { tenants }));
  await at("move", () => startMove(m, tenants[0]!, "db1", true));
} finally {
  await m.close();
  await rm(backups, { recursive: true, force: true });
}

const db = createDatabase(createConfig(bouncer), { driver, poolMax: 10, onSpan: record });
const point = prepareQuery("SELECT id::text AS id, name, email FROM users WHERE id = $1::uuid");
const insertUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text) RETURNING id::text AS id, name");
try {
  for (const t of tenants.slice(1)) await at("request-point-cold", () => db.withTenant(t, (c) => c.query(point, [crypto.randomUUID()])));
  for (let i = 0; i < 200; i++) await at("request-point-cached", () => db.withTenant(tenants[1 + (i % 5)]!, (c) => c.query(point, [crypto.randomUUID()])));
  for (let i = 0; i < 100; i++)
    await at("request-insert-transaction", () =>
      db.withTenant(tenants[1 + (i % 5)]!, (c) =>
        c.transaction(async (tx) => {
          const id = crypto.randomUUID();
          await tx.query(insertUser, [id, "span", `${id}@bench.test`]);
        }),
      ),
    );
} finally {
  await db.close();
}

const summary: Record<string, Record<string, { count: number; p50Ms: number; p95Ms: number; maxMs: number; totalMs: number }>> = {};
const round = (n: number) => Math.round(n * 100) / 100;
for (const group of Object.entries(Object.groupBy(spans, (s) => s.phase))) {
  const [label, list] = group;
  const byName = Object.groupBy(list ?? [], (s) => (s.name === "migration" || s.name === "seed" ? `${s.name} ${s.detail}` : s.name));
  summary[label] = Object.fromEntries(
    Object.entries(byName).map(([key, items]) => {
      const values = (items ?? []).map((s) => s.ms).sort((a, b) => a - b);
      const pick = (p: number) => round(values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0);
      return [key, { count: values.length, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: pick(1), totalMs: round(values.reduce((a, b) => a + b, 0)) }];
    }),
  );
}
const file = join(import.meta.dir, "results", `${run}.json`);
await writeFile(file, `${JSON.stringify({ schema: "repo-db-bench/spans@1", run, driver: name, startedAt: new Date().toISOString(), summary }, null, 1)}\n`);
console.log(file);
