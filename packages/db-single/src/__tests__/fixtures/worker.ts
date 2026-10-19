/** Cloudflare Workers compatibility check (`bun run build:workers`): uses only the runtime entry and the postgres.js and Neon serverless drivers.
 * It is a reference example for a Worker using Hyperdrive; config and client are created per request. Bun SQL does not enter the bundle. */
import { neonDriver } from "../../core/drivers/neon";
import { postgresDriver } from "../../core/drivers/postgres";
import { defineQuery } from "../../core/sql/query";
import { createConfig, createDb } from "../../index";

type Env = Record<string, unknown>;

/** A hand-written read query in the codegen output form (the schema goes between the parts): the parser does not enter the bundle. */
const listUsers = defineQuery(["SELECT id::text AS id, name FROM ", '.users ORDER BY created_at, id LIMIT $1::"pg_catalog"."int4"'], false, true);

/** Hyperdrive binding `DB` (`connectionString`); a plain string value is accepted too. */
export function workerConfig(env: Env) {
  const value = env.DB;
  const url = typeof value === "string" ? value : (value as { connectionString?: unknown } | undefined)?.connectionString;
  return createConfig(typeof url === "string" ? url : "");
}

/** `DRIVER=neon` selects the Neon serverless driver (WebSocket), otherwise postgres.js for Hyperdrive. */
const driverFor = (env: Env) => (env.DRIVER === "neon" ? neonDriver : postgresDriver);

export default {
  async fetch(_request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const db = createDb(workerConfig(env), { driver: driverFor(env), poolMax: 1 });
    try {
      return Response.json(await db.read.query(listUsers, [20]));
    } finally {
      // Sockets cannot outlive the request: they are closed after the response is sent.
      ctx.waitUntil(db.close().catch(() => {}));
    }
  },
};
