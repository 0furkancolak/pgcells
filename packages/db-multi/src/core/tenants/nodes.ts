/** Database readiness: every database in `DATABASE_URLS` must be reachable and carry its own identity (`platform.node_identity`),
 * and the list must match the `platform.nodes` records one to one. Runtime `ready()`, provision and restore call this. Error messages contain only
 * database IDs, never URLs. */
import type { Pools } from "../database";
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";

const UNDEFINED_TABLE = "42P01";

export async function checkDatabases(pools: Pick<Pools, "platform" | "node">, configured: readonly string[]): Promise<string[]> {
  // Identities first: a reordered list is caught before platform records are read from the wrong database.
  const probes = await Promise.all(
    configured.map((id) =>
      pools
        .node(id)
        .query<{ database_id: string }>("SELECT database_id FROM platform.node_identity")
        .then(
          ([row]) => ({ id, identity: row?.database_id, error: undefined }),
          (error: unknown) => ({ id, identity: undefined, error: errorCode(error) }),
        ),
    ),
  );
  const list = (items: { id: string }[]) => items.map((item) => item.id).join(", ");
  const unavailable = probes.filter((probe) => probe.error && probe.error !== UNDEFINED_TABLE);
  if (unavailable.length) throw new AppError("DATABASE_UNAVAILABLE", `Databases are not reachable: ${list(unavailable)}`);
  const moved = probes.filter((probe) => probe.identity !== undefined && probe.identity !== probe.id);
  if (moved.length)
    throw new AppError("DATABASE_ORDER_CHANGED", `DATABASE_URLS positions point at other databases: ${list(moved)}; restore the original order`);

  const registered = (await pools.platform.query<{ database_id: string }>("SELECT database_id FROM platform.nodes ORDER BY database_id")).map(
    (row) => row.database_id,
  );
  const missing = registered.filter((id) => !configured.includes(id));
  if (missing.length) throw new AppError("DATABASE_NOT_CONFIGURED", `Registered databases have no URL in DATABASE_URLS: ${missing.join(", ")}`);
  const unregistered = probes.filter((probe) => probe.identity === undefined || !registered.includes(probe.id));
  if (unregistered.length) throw new AppError("DATABASE_NOT_REGISTERED", `Run bootstrap for new databases: ${list(unregistered)}`);
  return registered;
}

/** Whether this database has a schema named `name`. */
export async function schemaExists(db: Pick<Connection, "query">, name: string): Promise<boolean> {
  const [row] = await db.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1) AS exists", [name]);
  return !!row?.exists;
}
