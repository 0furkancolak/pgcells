/** Cloudflare Workers compatibility check (`bun run build:workers`): uses only the runtime entry and the postgres.js and Neon serverless drivers.
 * It is a reference example for a Worker that uses Hyperdrive; config and client are built per request. Bun SQL does not enter the bundle. */
import { neonDriver } from "../../core/drivers/neon";
import { postgresDriver } from "../../core/drivers/postgres";
import { defineQuery } from "../../core/sql/query";
import { createConfig, createDatabase } from "../../index";

type Env = Record<string, unknown>;

/** A hand-written read query in the codegen output shape (the tenant schema goes between the parts): the parser does not enter the bundle. */
const listUsers = defineQuery(['SELECT id::text AS id, name FROM ', '.users ORDER BY created_at, id LIMIT $1::"pg_catalog"."int4"'], false, "tenant", true);

/** Hyperdrive bindings are `DB0`, `DB1` … in DATABASE_URLS order; plain string values are accepted too. */
export function workerConfig(env: Env) {
  const urls: string[] = [];
  for (let i = 0; env[`DB${i}`] !== undefined; i++) {
    const value = env[`DB${i}`];
    const url = typeof value === "string" ? value : (value as { connectionString?: unknown }).connectionString;
    urls.push(typeof url === "string" ? url : "");
  }
  return createConfig(urls);
}

/** `DRIVER=neon` selects the Neon serverless driver (WebSocket), otherwise postgres.js for Hyperdrive. */
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
