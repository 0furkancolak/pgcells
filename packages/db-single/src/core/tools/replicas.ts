/** The `replicas` command: the state of each replica in DATABASE_REPLICA_URLS (health, lag, availability). Opens and closes a short-lived runtime `Db`;
 * does not touch the management pool. The output has no URLs (replicas are numbered from 1 in config order). */
import type { Management } from "../management";
import { createDb } from "../runtime";

export async function replicaReport(m: Management) {
  const db = createDb(m.config, { driver: m.driver, poolMax: 2, pooler: "assumed", replicaMaxLagMs: m.config.replicaMaxLagMs });
  try {
    const replicas = await db.replicas();
    return { ok: replicas.every((replica) => replica.usable), maxLagMs: m.config.replicaMaxLagMs, replicas };
  } finally {
    await db.close();
  }
}
