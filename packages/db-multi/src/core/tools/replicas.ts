/** `replicas` command: the status of each replica in DATABASE_REPLICA_URLS (health, lag, availability). Opens and closes a short-lived runtime
 * `Database`; does not touch the management pools. The output has no URL (replicas are numbered from 1 in config order). */
import { AppError } from "../errors";
import type { Management } from "../management";
import { createDatabase } from "../runtime";
import { validateRegionName } from "../tenants/model";
import { createReplicaRegionLoader } from "../tenants/replicas";

const replicaCounts = (m: Management) => Object.fromEntries(m.config.nodes.filter((node) => node.replicas.length).map((node) => [node.id, node.replicas.length]));

/** Each replica's status plus `region`: where the directory says it lives (its `platform.replicas` row, else its node's region; `null` if unknown). */
export async function replicaReport(m: Management) {
  const db = createDatabase(m.config, { driver: m.driver, poolMax: 2, pooler: "assumed", replicaMaxLagMs: m.config.replicaMaxLagMs });
  try {
    const [replicas, regions] = await Promise.all([db.replicas(), createReplicaRegionLoader(m.pools.platform, replicaCounts(m), 0)()]);
    const located = replicas.map((replica) => ({ ...replica, region: regions[replica.databaseId]?.[replica.replica - 1]?.region ?? null }));
    return { ok: located.every((replica) => replica.usable), maxLagMs: m.config.replicaMaxLagMs, replicas: located };
  } finally {
    await db.close();
  }
}

/** Says where replica `address` (`db1#2`: the second replica of db1 in `DATABASE_REPLICA_URLS`) lives; `"none"` removes the row, so it is taken to live in its node's
 * region. A regional application (`createDatabase({ region })`) reads only from replicas in its own region. */
export async function setReplicaRegion(m: Management, address: string, region: string) {
  const match = /^(db(?:0|[1-9]\d?))#([1-8])$/.exec(address);
  if (!match) throw new AppError("USAGE", "The replica is addressed as dbN#K, e.g. db1#2 (the second replica of db1 in DATABASE_REPLICA_URLS)");
  const databaseId = match[1] as string;
  const ordinal = Number(match[2]);
  const configured = m.pools.nodeConfig(databaseId).replicas.length;
  if (ordinal > configured) throw new AppError("INVALID_CONFIG", `${databaseId} has ${configured} replica(s) in DATABASE_REPLICA_URLS, so ${address} does not exist`);
  if (region === "none") {
    await m.pools.platform.query("DELETE FROM platform.replicas WHERE database_id=$1 AND ordinal=$2", [databaseId, ordinal]);
    return { replica: address, region: null };
  }
  validateRegionName(region);
  const [row] = await m.pools.platform.query<{ region: string }>(
    `INSERT INTO platform.replicas (database_id,ordinal,region) SELECT n.database_id,$2,$3 FROM platform.nodes n WHERE n.database_id=$1
     ON CONFLICT (database_id,ordinal) DO UPDATE SET region=EXCLUDED.region RETURNING region`,
    [databaseId, ordinal, region],
  );
  if (!row) throw new AppError("DATABASE_NOT_FOUND", `Database ${databaseId} is not registered`);
  return { replica: address, region: row.region };
}
