/** Cloudflare Workers uyumluluk doğrulaması (`bun run build:workers`): yalnızca runtime girişini ve postgres.js ile Neon serverless sürücülerini kullanır.
 * Hyperdrive ile kullanan bir Worker için başvuru örneğidir; config ve client istek başına kurulur. Bun SQL bundle'a girmez. */
import { neonDriver } from "../../core/drivers/neon";
import { postgresDriver } from "../../core/drivers/postgres";
import { defineQuery } from "../../core/sql/query";
import { createConfig, createDb } from "../../index";

type Env = Record<string, unknown>;

/** Codegen çıktısı biçiminde (parçalar arasına schema gelir) elle yazılmış okuma sorgusu: bundle'a parser girmez. */
const listUsers = defineQuery(["SELECT id::text AS id, name FROM ", '.users ORDER BY created_at, id LIMIT $1::"pg_catalog"."int4"'], false, true);

/** Hyperdrive binding'i `DB` (`connectionString`); düz string değer de kabul edilir. */
export function workerConfig(env: Env) {
  const value = env.DB;
  const url = typeof value === "string" ? value : (value as { connectionString?: unknown } | undefined)?.connectionString;
  return createConfig(typeof url === "string" ? url : "");
}

/** `DRIVER=neon` Neon serverless sürücüsünü (WebSocket), aksi halde Hyperdrive için postgres.js'i seçer. */
const driverFor = (env: Env) => (env.DRIVER === "neon" ? neonDriver : postgresDriver);

export default {
  async fetch(_request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const db = createDb(workerConfig(env), { driver: driverFor(env), poolMax: 1 });
    try {
      return Response.json(await db.read.query(listUsers, [20]));
    } finally {
      // Soketler isteği aşamaz: yanıt gönderildikten sonra kapatılır.
      ctx.waitUntil(db.close().catch(() => {}));
    }
  },
};
