/** `cell promote`: a read-only plan for promoting a replica to primary. The package does **not** promote anything: promotion is the database's or the provider's job
 * (and an automatic one is how split brains are made). What it does is check, before and after, that the replica is the one you think it is, and write the steps down. */
import { runtimeDatabaseDefaults } from "../config";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { probeReplica } from "../tenants/replicas";

type Check = { check: string; ok: boolean; detail: string };

const DATABASE_ROLE_SETTINGS =
  "SELECT pg_catalog.array_to_string(setconfig, ',') AS settings FROM pg_catalog.pg_db_role_setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())";

export async function promotePlan(m: Management, databaseId: string, replica: number) {
  const node = m.pools.nodeConfig(databaseId);
  if (!Number.isInteger(replica) || replica < 1 || replica > node.replicas.length)
    throw new AppError("INVALID_CONFIG", `${databaseId} has ${node.replicas.length} replica(s) in DATABASE_REPLICA_URLS; --to must be 1 to ${node.replicas.length}`);
  const url = node.replicas[replica - 1] as string;
  const checks: Check[] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });

  // Is the current primary reachable? That decides whether this is a planned switchover or a failover.
  const primaryReachable = await m.pools
    .node(databaseId)
    .query("SELECT 1")
    .then(
      () => true,
      () => false,
    );

  const connection = m.driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    let lagMs: number | null = null;
    let reachable = true;
    try {
      const probe = await probeReplica(
        // Without a primary there is no position to compare with: lag is then the time since the last replayed commit.
        primaryReachable ? m.pools.node(databaseId) : { query: async () => [{ lsn: "0/0" }] as never, exec: async () => {} },
        connection,
      );
      lagMs = probe.lagMs;
      add("replica_in_recovery", probe.inRecovery, probe.inRecovery ? "The URL goes to a standby." : "The URL already goes to a primary: there is nothing to promote.");
    } catch (error) {
      reachable = false;
      add("replica_in_recovery", false, `Could not read the replica (${errorCode(error)}).`);
    }
    add("replica_reachable", reachable, reachable ? "Replica is reachable." : "Could not connect to the replica; check the URL, network and credentials.");
    if (reachable) {
      const [identity] = await connection.query<{ database_id: string }>("SELECT database_id FROM platform.node_identity").catch(() => []);
      add("replica_identity", identity?.database_id === databaseId, `The replica must be a copy of ${databaseId}; its identity row says ${identity?.database_id ?? "nothing"}.`);
      const threshold = m.config.replicaMaxLagMs;
      const lag = lagMs === null ? "unknown" : `${lagMs} ms`;
      add(
        "replica_lag",
        lagMs !== null && lagMs <= threshold,
        `Lag ${lag} (threshold ${threshold} ms): writes acknowledged by the old primary in that window can be lost on a failover${primaryReachable ? "; a planned switchover loses nothing once writers are drained and the replica has caught up" : ""}.`,
      );
      const [stored] = await connection.query<{ settings: string | null }>(DATABASE_ROLE_SETTINGS).catch(() => []);
      const expected = runtimeDatabaseDefaults(m.config);
      add(
        "replica_runtime_timeouts",
        expected.every((setting) => stored?.settings?.split(",").includes(setting)),
        `The runtime timeout defaults (${expected.join(", ")}) come with the replication; without them the promoted primary has no server-side limits.`,
      );
    }
  } finally {
    await connection.close(1000);
  }
  add(
    "primary_reachable",
    primaryReachable,
    primaryReachable ? "The current primary answers: a planned switchover." : "The current primary does not answer: this is a failover. It must not come back as a second writer.",
  );

  const mode = primaryReachable ? "switchover" : "failover";
  const blocking = checks.filter((check) => check.check !== "primary_reachable");
  const label = `${databaseId}#${replica}`;
  const steps = [
    primaryReachable
      ? `1. Drain the application: stop writers to ${databaseId} (readiness failing, db.close({ drain: true })) and wait until ${label} has caught up (\`pgcells replicas\` shows lag 0).`
      : `1. Fence the old primary of ${databaseId}: shut it down or cut it off the network so it cannot come back and accept writes (split brain). Check the lag above to know what may be lost.`,
    `2. Promote ${label} with your database tooling (self-hosted: \`SELECT pg_promote()\` or \`pg_ctl promote\`; managed: the provider's promote or failover action). The package does not do this.`,
    `3. Point the application at it: in DATABASE_URLS replace the ${databaseId} URL with the promoted server's URL, remove that URL from DATABASE_REPLICA_URLS, and update the pooler alias \`${databaseId}\` (\`pgcells pooler generate --check <dir>\` shows the drift); then \`RECONNECT\` on the pooler.`,
    `4. Run \`pgcells doctor\`: \`database_identity\` must pass (the promoted server carries ${databaseId}'s identity), \`runtime_timeouts\` must pass, and the remaining replicas of ${databaseId} must be re-pointed at the new primary before they pass \`replica_identity\`.`,
    "5. Placements need no change: tenants stay on the same database id, so no cache has to be invalidated.",
    "6. Rebuild a replica from the new primary, and keep the old primary out of service until it has been rebuilt as one.",
  ];
  return { ok: blocking.every((check) => check.ok), databaseId, replica, mode: mode as "switchover" | "failover", checks, steps };
}
