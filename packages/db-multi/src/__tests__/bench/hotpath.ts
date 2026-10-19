/** Hot-path micro-benchmark through PgBouncer (dbtenancy stack): raw driver vs package comparison, concurrent loops over a fixed duration;
 * routes run in turn each round, the summary is the round median. Usage (from packages/db-multi):
 * bun <this file> <driver> [seconds] [concurrency] [rounds] [op]; op is `query` (default: single query) or `tx` (BEGIN + query + COMMIT). */
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { bootstrap, createManagement, prepareQuery, provisionTenant } from "@0furkancolak/pgcells/management";
import { quoteIdentifier } from "../../core/tenants/model";
import { loadDriver } from "./drivers";
import { LOCAL_BOUNCER_URLS, LOCAL_DIRECT_URLS } from "./local";

const name = process.argv[2] ?? "bun";
const seconds = Number(process.argv[3] ?? 4);
const concurrency = Number(process.argv[4] ?? 32);
const rounds = Number(process.argv[5] ?? 2);
const op = process.argv[6] ?? "query";
if (op !== "query" && op !== "tx") throw new Error(`op must be query or tx, got ${op}`);
const driver = await loadDriver(name);
const tenants = ["hot-a", "hot-b", "hot-c", "hot-d"];

const m = createManagement(createConfig(LOCAL_DIRECT_URLS), { driver });
await bootstrap(m);
for (const [i, t] of tenants.entries()) {
  const p = await provisionTenant(m, t, `db${i % 2}`);
  await m.pools.node(p.databaseId).exec(`INSERT INTO "${p.schemaName}".users (id, name, email) SELECT ('00000000-0000-0000-0000-'||lpad(g::text,12,'0'))::uuid, 'u'||g, 'u'||g||'@bench.test' FROM generate_series(1,1000) g ON CONFLICT DO NOTHING`);
}
const placements = new Map((await Promise.all(tenants.map((t) => m.platform.get(t)))).map((p) => [p.tenantId, p]));
await m.close();

const CLEANUP = [
  "DELETE FROM platform.move_targets WHERE tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))",
  "DELETE FROM platform.moves WHERE tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))",
  "DELETE FROM platform.placements WHERE tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))",
  "DELETE FROM platform.tenants WHERE tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))",
];
/** Deletes the benchmark tenants: platform records and schemas (leaves no residue in the local DB). */
async function removeBenchTenants() {
  const cleanup = createManagement(createConfig(LOCAL_DIRECT_URLS), { driver });
  const ids = [JSON.stringify(tenants)];
  await cleanup.pools.platform.transaction(async (tx) => {
    for (const statement of CLEANUP) await tx.query(statement, ids);
  });
  for (const placement of placements.values())
    await cleanup.pools.node(placement.databaseId).exec(`DROP SCHEMA IF EXISTS ${quoteIdentifier(placement.schemaName)} CASCADE`);
  await cleanup.close();
}

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const raw = LOCAL_BOUNCER_URLS.map((url) => driver(url, { max: 10, idleTimeoutSeconds: 30, maxLifetimeSeconds: 1800, connectTimeoutSeconds: 10 }));
const spans = new Map<string, number[]>();
const db = createDatabase(createConfig(LOCAL_BOUNCER_URLS), {
  driver,
  poolMax: 10,
  ...(process.env.SPANS ? { onSpan: (s: { name: string; ms: number }) => void (spans.get(s.name) ?? spans.set(s.name, []).get(s.name)!).push(s.ms) } : {}),
} as never);
const point = prepareQuery("SELECT id::text AS id, name, email FROM users WHERE id = $1::uuid");

async function loop(label: string, work: (tenant: string, id: string) => Promise<unknown>) {
  const end = performance.now() + seconds * 1000;
  let count = 0;
  const lat: number[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < end) {
        const t = performance.now();
        await work(tenants[count % tenants.length]!, uuid(1 + (count % 1000)));
        lat.push(performance.now() - t);
        count++;
      }
    }),
  );
  lat.sort((a, b) => a - b);
  const q = (p: number) => Math.round(lat[Math.floor(lat.length * p)]! * 100) / 100;
  return { label, rps: Math.round(count / seconds), p50: q(0.5), p99: q(0.99) };
}

const out: Awaited<ReturnType<typeof loop>>[] = [];
const rawText = (t: string) => `SELECT id::text AS id, name, email FROM "${placements.get(t)!.schemaName}".users WHERE id = $1::uuid`;
const rawPool = (t: string) => raw[Number(placements.get(t)!.databaseId.slice(2))]!;
async function rawTx(t: string, id: string) {
  const connection = await rawPool(t).reserve();
  try {
    await connection.exec("BEGIN");
    const rows = await connection.query(rawText(t), [id]);
    await connection.exec("COMMIT");
    return rows;
  } finally {
    connection.release();
  }
}
type Context = Parameters<Parameters<typeof db.withTenant>[1]>[0];
const work = (c: Context, id: string) => (op === "tx" ? c.transaction((tx) => tx.query(point, [id])) : c.query(point, [id]));
for (let round = 0; round < rounds; round++) {
  out.push(await loop("raw", (t, id) => (op === "tx" ? rawTx(t, id) : rawPool(t).query(rawText(t), [id]))));
  out.push(await loop("withTenant", (t, id) => db.withTenant(t, (c) => work(c, id))));
  out.push(await loop("forPlacement", (t, id) => db.withTenant.forPlacement(placements.get(t)!, (c) => work(c, id))));
}
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const summary = Object.fromEntries(
  ["raw", "withTenant", "forPlacement"].map((label) => {
    const runs = out.filter((result) => result.label === label);
    return [label, { rps: median(runs.map((run) => run.rps)), p50: median(runs.map((run) => run.p50)), p99: median(runs.map((run) => run.p99)) }];
  }),
);
// Ratio to the raw driver in the same round (round median): machine noise affects both routes together.
const ratio = (label: string) => median(out.filter((result) => result.label === label).map((result, i) => result.rps / out.filter((other) => other.label === "raw")[i]!.rps));
console.log(JSON.stringify({ driver: name, op, concurrency, seconds, rounds, results: out, summary, ratioToRaw: { withTenant: ratio("withTenant"), forPlacement: ratio("forPlacement") } }, null, 1));
if (spans.size)
  console.log(JSON.stringify(Object.fromEntries([...spans].map(([k, v]) => [k, { n: v.length, avgUs: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) }]))));
await db.close();
await Promise.all(raw.map((p) => p.close(1000)));
await removeBenchTenants();
