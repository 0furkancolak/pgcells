/** Parts shared by app and worker: prepared queries for the `users` table (compiled once at startup with codegen's compiler),
 * the queue job type, placement cache durations and the JSON line log. */
import { errorCode } from "@0furkancolak/pgcells";
import { prepareQuery } from "@0furkancolak/pgcells/management";

// ORDER BY users.id (not the text alias `id`): the primary key index serves the page.
export const listUsers = prepareQuery("SELECT id::text AS id, name, email FROM users ORDER BY users.id LIMIT $1");
export const getUser = prepareQuery("SELECT id::text AS id, name, email FROM users WHERE id = $1::uuid");
export const countUsers = prepareQuery("SELECT count(*)::int AS n FROM users");
export const createUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2::text, $3::text) RETURNING id::text AS id, name, email");

export type UserJob = { id: string; name: string; email: string };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Staleness upper bound after a move ≈ ttlSeconds + localTtlMs (the CLI runs without hooks, see the packages/redis README). */
export const placementTtl = () => ({
  localTtlMs: Number(process.env.PLACEMENT_LOCAL_TTL_MS ?? 2000),
  ttlSeconds: Number(process.env.PLACEMENT_TTL_SECONDS ?? 5),
});

export const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

/** Logs repeated connection errors once every 5 seconds (so the log does not flood while Redis is down). */
export function throttled(event: string) {
  let last = 0;
  return (error: unknown) => {
    if (Date.now() - last < 5000) return;
    last = Date.now();
    log(event, { code: errorCode(error) });
  };
}
