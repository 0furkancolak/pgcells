/** Replica tests: the streaming-replication pair in the isolated compose (`postgres-rp` → `postgres-rp-replica`). Fixed local defaults,
 * no environment variables. The runtime connects to the direct URLs with `pooler: "assumed"`. */
import { createConfig } from "../../core/config";
import type { Connection } from "../../core/driver";
import { createDb, type Db, type DbOptions } from "../../core/runtime";
import { prepareMigration } from "../../core/sql/compiler";
import { driver, dropSchema, q, raw, testSchema } from "./helpers";

export const PRIMARY_URL = "postgres://admin:local_admin_password@127.0.0.1:5565/app";
export const REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5566/app";
/** Nobody is listening: the connection is refused. */
export const DEAD_REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5599/app";

export const replicaConfig = (...replicas: string[]) => createConfig(PRIMARY_URL, replicas);

/** Waits until the replica has replayed the primary's current WAL position. */
export async function caughtUp(primary: Connection, replica: Connection, timeoutMs = 15_000) {
  const [position] = await primary.query<{ lsn: string }>("SELECT pg_catalog.pg_current_wal_lsn()::text AS lsn");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await replica.query<{ ok: boolean }>("SELECT pg_catalog.pg_last_wal_replay_lsn() >= $1::pg_catalog.pg_lsn AS ok", [position?.lsn]);
    if (row?.ok) return;
    if (Date.now() > deadline) throw new Error("Replica did not catch up");
    await Bun.sleep(50);
  }
}
export const pauseReplay = (replica: Connection) => replica.exec("SELECT pg_catalog.pg_wal_replay_pause()");
export const resumeReplay = (replica: Connection) => replica.exec("SELECT pg_catalog.pg_wal_replay_resume()");

/** A schema with a `notes` table on the primary; the replica has caught up. `runtime(replicas, options)` opens a `Db` with replicas. */
export async function replicaFixture() {
  const schema = testSchema();
  const primary = raw(PRIMARY_URL);
  const replica = raw(REPLICA_URL);
  await primary.exec(`CREATE SCHEMA ${q(schema)}`);
  for (const sql of prepareMigration("CREATE TABLE notes (id integer PRIMARY KEY)").bind(schema)) await primary.exec(sql);
  await caughtUp(primary, replica);
  const opened: Db[] = [];
  return {
    schema,
    primary,
    replica,
    runtime(replicas: string[] = [REPLICA_URL], options: Partial<Omit<DbOptions, "driver">> = {}) {
      const db = createDb(replicaConfig(...replicas), { driver, schema, pooler: "assumed", replicaStatusMs: 1, replicaMaxLagMs: 60_000, ...options });
      opened.push(db);
      return db;
    },
    async close() {
      await resumeReplay(replica).catch(() => {});
      for (const db of opened) await db.close();
      await dropSchema(primary, schema);
      await primary.close();
      await replica.close();
    },
  };
}
