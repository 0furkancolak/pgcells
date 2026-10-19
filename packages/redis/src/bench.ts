/** Micro-benchmark (not a test): added time per placement. Local hit, Redis hit (`localTtlMs: 0`) and direct
 * `db.platform.get`. `bun src/bench.ts`; env: `REDIS_URL`, `DATABASE_URLS`, `BENCH_N` (default 50000). Output is JSON. */
import { createConfig, createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement, provisionTenant } from "@0furkancolak/pgcells/management";
import { createRedis } from "./client";
import { createPlacementCache } from "./placement";

const n = Number(process.env.BENCH_N ?? 50_000);
const config = createConfig(
  process.env.DATABASE_URLS ?? "postgres://admin:local_admin_password@127.0.0.1:5540/app,postgres://admin:local_admin_password@127.0.0.1:5541/app",
);
const tenantId = "redis-bench";
const redis = createRedis({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6390" });
const db = createDatabase(config, { driver: bunDriver, poolMax: 2 });
const management = createManagement(config, { driver: bunDriver });
await provisionTenant(management, tenantId, "db0");
await management.close();

async function measure(name: string, call: () => unknown) {
  for (let i = 0; i < 1_000; i++) await call();
  const samples = new Float64Array(n);
  const started = Bun.nanoseconds();
  for (let i = 0; i < n; i++) {
    const t = Bun.nanoseconds();
    const result = call();
    if (result instanceof Promise) await result;
    samples[i] = Bun.nanoseconds() - t;
  }
  const seconds = (Bun.nanoseconds() - started) / 1e9;
  samples.sort();
  const us = (q: number) => Math.round(samples[Math.min(n - 1, Math.floor(n * q))]! / 10) / 100;
  return { name, n, opsPerSec: Math.round(n / seconds), p50Us: us(0.5), p99Us: us(0.99) };
}

const local = createPlacementCache({ redis, db, prefix: "bench", localTtlMs: 60_000 });
const remote = createPlacementCache({ redis, db, prefix: "bench", localTtlMs: 0 });
await local.loadPlacement(tenantId);
const results = [
  await measure("placement local hit", () => local(tenantId)),
  await measure("placement redis hit", () => remote(tenantId)),
  await measure("db.platform.get", () => db.platform.get(tenantId)),
];
console.log(JSON.stringify(results, null, 2));
await redis.close();
await db.close();
