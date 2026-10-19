/** `replicas` command: the status of each replica in DATABASE_REPLICA_URLS (health, lag, availability). Opens and closes a short-lived runtime
 * `Database`; does not touch the management pools. The output has no URL (replicas are numbered from 1 in config order). */
import type { Management } from "../management";
import { createDatabase } from "../runtime";

export async function replicaReport(m: Management) {
  const db = createDatabase(m.config, { driver: m.driver, poolMax: 2, pooler: "assumed", replicaMaxLagMs: m.config.replicaMaxLagMs });
  try {
    const replicas = await db.replicas();
    return { ok: replicas.every((replica) => replica.usable), maxLagMs: m.config.replicaMaxLagMs, replicas };
  } finally {
    await db.close();
  }
}
