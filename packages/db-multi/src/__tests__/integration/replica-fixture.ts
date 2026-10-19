/** Replica testleri: izole compose'taki akış replikasyonlu çift (`postgres-rp` → `postgres-rp-replica`). Sabit yerel varsayılanlar,
 * ortam değişkeni yok. Runtime `pooler: "assumed"` ile doğrudan URL'lere bağlanır. */
import { createConfig } from "../../core/config";
import type { Connection } from "../../core/driver";
import { bootstrap } from "../../core/operations/bootstrap";
import { provisionTenant } from "../../core/operations/provision";
import { createDatabase, type RuntimeOptions } from "../../core/runtime";
import { createTestManagement, driver, raw, removeTenants } from "./helpers";

export const PRIMARY_URL = "postgres://admin:local_admin_password@127.0.0.1:5545/app";
export const REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5546/app";
/** Dinleyen kimse yok: bağlantı reddedilir. */
export const DEAD_REPLICA_URL = "postgres://admin:local_admin_password@127.0.0.1:5599/app";

export const replicaConfig = (...replicas: string[]) => createConfig([PRIMARY_URL], replicas.map((url) => `db0=${url}`));

/** Replica, primary'nin şu anki WAL konumunu replay edene kadar bekler. */
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

/** Primary'de bootstrap + bir tenant; replica yetişmiş. `runtime(replicas, options)` replica'lı runtime açar. */
export async function replicaFixture(tenantId = `rp-${crypto.randomUUID().slice(0, 8)}`) {
  const management = createTestManagement({}, replicaConfig(REPLICA_URL));
  await bootstrap(management);
  await provisionTenant(management, tenantId);
  const primary = raw(0, PRIMARY_URL);
  const replica = raw(0, REPLICA_URL);
  await caughtUp(primary, replica);
  const opened: ReturnType<typeof createDatabase>[] = [];
  return {
    tenantId,
    management,
    primary,
    replica,
    runtime(replicas: string[] = [REPLICA_URL], options: Omit<RuntimeOptions, "driver"> = {}) {
      const db = createDatabase(replicaConfig(...replicas), { driver, pooler: "assumed", replicaStatusMs: 1, ...options });
      opened.push(db);
      return db;
    },
    async close() {
      await resumeReplay(replica).catch(() => {});
      for (const db of opened) await db.close();
      await removeTenants(management, tenantId);
      await primary.close();
      await replica.close();
      await management.close();
    },
  };
}
