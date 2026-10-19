import { expect } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAll, exportTenant, restoreTenant } from "../../core/tools/backup";
import { doctor } from "../../core/tools/doctor";
import { replicaReport } from "../../core/tools/replicas";
import { openReplicaSource } from "../../core/tools/replica-source";
import { createTestManagement, createUser, failure, forgetTenant, integration, listUsers, uniqueEmail } from "./helpers";
import { caughtUp, DEAD_REPLICA_URL, pauseReplay, PRIMARY_URL, REPLICA_URL, replicaConfig, replicaFixture } from "./replica-fixture";

const exists = (path: string) => stat(path).then(() => true, () => false);
const names = (rows: unknown[]) => (rows as { name: string }[]).map((row) => row.name).sort();
const temp = () => mkdtemp(join(tmpdir(), "replica-tools-"));

integration("replicas reports a healthy replica, an unreachable one and a lagging one, without any URL", async () => {
  const f = await replicaFixture();
  const dead = createTestManagement({}, replicaConfig(DEAD_REPLICA_URL));
  const lagging = createTestManagement({ replicaMaxLagMs: 200 }, replicaConfig(REPLICA_URL));
  try {
    const healthy = await replicaReport(f.management);
    expect(healthy).toMatchObject({ ok: true, replicas: [{ databaseId: "db0", replica: 1, up: true, usable: true }] });
    expect(JSON.stringify(healthy)).not.toContain("127.0.0.1");
    expect(await replicaReport(dead)).toMatchObject({ ok: false, replicas: [{ up: false, usable: false }] });
    await pauseReplay(f.replica);
    await f.runtime().withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "behind", uniqueEmail()]));
    await Bun.sleep(500);
    expect((await replicaReport(lagging)).ok).toBe(false);
  } finally {
    await dead.close();
    await lagging.close();
    await f.close();
  }
});

integration("doctor: a real replica passes its checks; the primary given as a replica fails replica_in_recovery", async () => {
  const f = await replicaFixture();
  const asPrimary = createTestManagement({}, replicaConfig(`${PRIMARY_URL}?application_name=not-a-replica`));
  try {
    const checks = (await doctor(f.management)).checks.filter((check) => check.target === "db0#1");
    const outcome = Object.fromEntries(checks.map((check) => [check.check, check.ok]));
    expect(outcome).toMatchObject({ replica_reachable: true, replica_in_recovery: true, replica_lag: true, replica_identity: true, replica_runtime_timeouts: true });
    const wrong = (await doctor(asPrimary)).checks.filter((check) => check.target === "db0#1");
    expect(wrong.find((check) => check.check === "replica_in_recovery")?.ok).toBe(false);
  } finally {
    await asPrimary.close();
    await f.close();
  }
});

integration("export --from-replica writes a restorable export marked as replica-sourced", async () => {
  const f = await replicaFixture();
  const dir = await temp();
  try {
    const db = f.runtime();
    await db.withTenant(f.tenantId, async (t) => {
      await t.query(createUser, [crypto.randomUUID(), "alice", uniqueEmail()]);
      await t.query(createUser, [crypto.randomUUID(), "bob", uniqueEmail()]);
    });
    await caughtUp(f.primary, f.replica);
    const target = join(dir, "export");
    const result = await exportTenant(f.management, f.tenantId, target, { replicaUrls: `db0=${REPLICA_URL}` });
    expect(result.rows).toBeGreaterThanOrEqual(2);
    const stored = JSON.parse(await readFile(join(target, "tenant.json"), "utf8")) as { source?: string; replayLsn?: string };
    expect(stored.source).toBe("replica");
    expect(stored.replayLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    // Restore brings back exactly the same data.
    await forgetTenant(f.management, f.tenantId);
    await restoreTenant(f.management, f.tenantId, target);
    expect(names(await db.withTenant(f.tenantId, (t) => t.query(listUsers, [50, 0])))).toEqual(["alice", "bob"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await f.close();
  }
});

integration("backup --from-replica is always full, marked replica, and never poisons the next primary incremental", async () => {
  const f = await replicaFixture();
  const root = await temp();
  try {
    const only = { tenants: [f.tenantId] };
    const first = await backupAll(f.management, root, { ...only, replicaUrls: `db0=${REPLICA_URL}` });
    const second = await backupAll(f.management, root, { ...only, replicaUrls: `db0=${REPLICA_URL}` });
    expect([first.full, first.written, second.full, second.written, second.unchanged]).toEqual([true, 1, true, 1, 0]);
    const manifest = JSON.parse(await readFile(join(root, second.id, "manifest.json"), "utf8")) as { source?: string; replayLsn?: Record<string, string> };
    expect(manifest.source).toBe("replica");
    expect(Object.keys(manifest.replayLsn ?? {})).toEqual(["db0"]);
    const primary = await backupAll(f.management, root, only); // takes the replica set as base, but rewrites it since there is no marker
    expect([primary.written, primary.unchanged]).toEqual([1, 0]);
    const again = await backupAll(f.management, root, only); // now incremental: unchanged
    expect([again.written, again.unchanged]).toEqual([0, 1]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await f.close();
  }
}, 120_000);

integration("a lagging replica is refused before anything is written: no export directory, no backup set", async () => {
  const f = await replicaFixture();
  const lagging = createTestManagement({ replicaMaxLagMs: 200 }, replicaConfig(REPLICA_URL));
  const dir = await temp();
  try {
    await pauseReplay(f.replica);
    await f.runtime().withTenant(f.tenantId, (t) => t.query(createUser, [crypto.randomUUID(), "late", uniqueEmail()]));
    await Bun.sleep(500);
    const target = join(dir, "export");
    expect(await failure(exportTenant(lagging, f.tenantId, target, { replicaUrls: `db0=${REPLICA_URL}` }))).toBe("REPLICA_LAG_EXCEEDED");
    expect(await exists(target)).toBe(false);
    expect(await failure(backupAll(lagging, join(dir, "sets"), { replicaUrls: `db0=${REPLICA_URL}` }))).toBe("REPLICA_LAG_EXCEEDED");
    expect(await exists(join(dir, "sets"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await lagging.close();
    await f.close();
  }
});

integration("the primary URL is refused as a replica source", async () => {
  const f = await replicaFixture();
  try {
    expect(await failure(exportTenant(f.management, f.tenantId, join(tmpdir(), `never-${crypto.randomUUID()}`), { replicaUrls: `db0=${PRIMARY_URL}?application_name=x` }))).toBe("INVALID_CONFIG");
  } finally {
    await f.close();
  }
});

integration("a real recovery conflict cuts the export read and surfaces as REPLICA_CONFLICT", async () => {
  const f = await replicaFixture();
  try {
    const db = f.runtime();
    await db.withTenant(f.tenantId, async (t) => {
      for (let i = 0; i < 50; i++) await t.query(createUser, [crypto.randomUUID(), `u${i}`, uniqueEmail()]);
    });
    await caughtUp(f.primary, f.replica);
    const schema = (await f.management.platform.get(f.tenantId)).schemaName;
    const source = await openReplicaSource(f.management, `db0=${REPLICA_URL}`);
    try {
      const read = source.node("db0").transaction(
        async (tx) => {
          await tx.query(`SELECT count(*) FROM "${schema}".users`);
          await f.primary.pool.exec(`DELETE FROM "${schema}".users`);
          await f.primary.pool.exec(`VACUUM "${schema}".users`);
          for (let attempt = 0; attempt < 40; attempt++) {
            await Bun.sleep(250);
            await tx.query(`SELECT count(*) FROM "${schema}".users`);
          }
          throw new Error("the standby never canceled the held snapshot");
        },
        { mode: " ISOLATION LEVEL REPEATABLE READ READ ONLY" },
      );
      expect(await failure(read)).toBe("REPLICA_CONFLICT");
    } finally {
      await source.close();
    }
  } finally {
    await f.close();
  }
}, 60_000);
