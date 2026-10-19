/** Cloudflare Workers uyumluluk doğrulaması (`bun run build:workers`): yalnızca runtime girişini ve postgres.js ile Neon serverless sürücülerini kullanır.
 * Hyperdrive ile kullanan bir Worker için başvuru örneğidir; config ve client istek başına kurulur. Bun SQL bundle'a girmez. */
import { neonDriver } from "../../core/drivers/neon";
import { postgresDriver } from "../../core/drivers/postgres";
import { defineQuery } from "../../core/sql/query";
import { createConfig, createDatabase } from "../../index";

type Env = Record<string, unknown>;

/** Codegen çıktısı biçiminde (parçalar arasına tenant schema'sı gelir) elle yazılmış okuma sorgusu: bundle'a parser girmez. */
const listUsers = defineQuery(['SELECT id::text AS id, name FROM ', '.users ORDER BY created_at, id LIMIT $1::"pg_catalog"."int4"'], false, "tenant", true);

/** Hyperdrive binding'leri DATABASE_URLS sırasıyla `DB0`, `DB1` …; düz string değerler de kabul edilir. */
export function workerConfig(env: Env) {
  const urls: string[] = [];
  for (let i = 0; env[`DB${i}`] !== undefined; i++) {
    const value = env[`DB${i}`];
    const url = typeof value === "string" ? value : (value as { connectionString?: unknown }).connectionString;
    urls.push(typeof url === "string" ? url : "");
  }
  return createConfig(urls);
}

/** `DRIVER=neon` Neon serverless sürücüsünü (WebSocket), aksi halde Hyperdrive için postgres.js'i seçer. */
const driverFor = (env: Env) => (env.DRIVER === "neon" ? neonDriver : postgresDriver);

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const db = createDatabase(workerConfig(env), { driver: driverFor(env), poolMax: 1 });
    try {
      const tenantId = new URL(request.url).searchParams.get("tenant") ?? "";
      const rows = await db.withTenant(tenantId, (tenant) => tenant.query(listUsers, [20]));
      return Response.json(rows);
    } finally {
      // Sockets cannot outlive the request; close after the response is sent.
      ctx.waitUntil(db.close().catch(() => {}));
    }
  },
};
