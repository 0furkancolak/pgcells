/** Spike (docs/guides/connections.md, "named prepared statements"): do named prepared statements stay affordable when the SQL text carries the tenant schema, so the
 * number of distinct statements is queries x tenants? Runs postgres.js through a real PgBouncer (1.24, `max_prepared_statements = 100`) against many schemas and reports
 * throughput and client memory with `prepare: false` and `prepare: true`. Usage (packages/db-multi, compose stack up): bun src/__tests__/bench/prepared-spike.ts [tenants] [shapes] [rounds] */
import postgres from "postgres";
import { startPgbouncer } from "../integration/pgbouncer-container";
import { raw } from "../integration/helpers";

const tenants = Number(process.argv[2] ?? 2000);
const shapes = Number(process.argv[3] ?? 10);
const rounds = Number(process.argv[4] ?? 3);
const schema = (i: number) => `spike_t${i}`;

const admin = raw(0);
console.log(`creating ${tenants} schemas ...`);
for (let start = 0; start < tenants; start += 200) {
  const sql = Array.from({ length: Math.min(200, tenants - start) }, (_, k) => {
    const name = schema(start + k);
    return `CREATE SCHEMA IF NOT EXISTS ${name}; CREATE TABLE IF NOT EXISTS ${name}.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, email text, created_at timestamptz DEFAULT now());`;
  }).join("\n");
  await admin.exec(sql);
}
const pooler = await startPgbouncer({ alpine: "3.22", maxPreparedStatements: 100, port: 5563 });

/** `shapes` query shapes; each text embeds the schema, as the package's compiled queries do. */
const text = (tenant: number, shape: number) => {
  const columns = ["id, name", "id, name, email", "name, email", "id", "email", "id, created_at", "name", "id, email", "created_at, name", "id, name, created_at"][shape % 10];
  return `SELECT ${columns} FROM ${schema(tenant)}.users WHERE name <> $1::text OR id IS NOT NULL LIMIT ${1 + Math.floor(shape / 10)}`;
};

async function measure(prepare: boolean) {
  const sql = postgres(pooler.urls[0] as string, { max: 5, prepare, fetch_types: false, idle_timeout: 30 });
  const total = tenants * shapes;
  const before = process.memoryUsage();
  let failed = 0;
  const start = performance.now();
  for (let round = 0; round < rounds; round++) {
    const queue = Array.from({ length: total }, (_, i) => i);
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        for (let i = queue.pop(); i !== undefined; i = queue.pop()) {
          try {
            await sql.unsafe(text(i % tenants, Math.floor(i / tenants)), ["x"], { prepare });
          } catch {
            failed++;
          }
        }
      }),
    );
  }
  const seconds = (performance.now() - start) / 1000;
  Bun.gc(true);
  const after = process.memoryUsage();
  await sql.end({ timeout: 2 });
  return {
    prepare,
    distinctStatements: total,
    statementsPerSecond: Math.round((total * rounds) / seconds),
    failed,
    heapGrowthMB: Math.round((after.heapUsed - before.heapUsed) / 1e5) / 10,
    rssGrowthMB: Math.round((after.rss - before.rss) / 1e5) / 10,
  };
}

try {
  console.log(JSON.stringify(await measure(false)));
  console.log(JSON.stringify(await measure(true)));
  console.log(JSON.stringify(await measure(false)));
  console.log(JSON.stringify(await measure(true)));
} finally {
  await pooler.stop();
  for (let start = 0; start < tenants; start += 200)
    await admin.exec(Array.from({ length: Math.min(200, tenants - start) }, (_, k) => `DROP SCHEMA IF EXISTS ${schema(start + k)} CASCADE;`).join("\n"));
  await admin.close();
}
