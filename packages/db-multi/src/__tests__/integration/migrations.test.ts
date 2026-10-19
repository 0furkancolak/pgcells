import { afterAll, beforeAll, expect } from "bun:test";
import {
  bootstrap,
  type Management,
  migrateAll,
  migrateTenant,
  migrationStatus,
  provisionTenant,
  recoverMigrations,
  rollbackTenant,
} from "../../management";
import type * as ManagementModule from "../../management";
import { tenantMigrations } from "../../core/migrations/registry";
import { createMigrationSessions } from "../../core/migrations/runner";
import { openManagementSession, openSession, tenantManagementKey, withTenantLock } from "../../core/operations/locks";
import { tenantSchema } from "../../core/tenants/model";
import { createTestManagement, directConfig, driver, enabled, forgetTenant, integration, packageCopy, q, removeTenants } from "./helpers";

let app: Management;
const prefix = `migration-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
// Paketin migration'ları: auth tabloları, `users`'a yabancı anahtarlı `user_imports`, sonra auth türü başına rate limit tabloları.
const real = tenantMigrations.map((m) => m.id) as [string, string, string];
const n = tenantMigrations.length;
const pendingIds = async (id: string) => (await migrationStatus(app, id)).pending.map((m) => m.id);
const runnerMarkers = () => app.pools.platform.query("SELECT run_id FROM platform.migration_runner");

/** Test-yerel concurrent index migration'ını taşıyan paket kopyası (ayrı modül grafiği, ayrı registry): paketin migration'ları ve
 * `users` üzerinde index. `user_imports` `users`'ı kilitler, index son migration kalır. Kopyayla kurulan tenant'lar test sonunda
 * silinir: bu dosyanın ve sonraki dosyaların migrate-all'ı drift görmesin. */
const INDEX_ID = "20260916093027_users_name_index";
const ids = [...real, INDEX_ID] as [string, string, string, string];
let copy: Awaited<ReturnType<typeof packageCopy>>;
let pkg: typeof ManagementModule;
let ext: Management;
const createCopyManagement = (options = {}) => pkg.createManagement(directConfig(), { driver, placementCacheWaitMs: 1, ...options });
const copyPendingIds = async (id: string) => (await pkg.migrationStatus(ext, id)).pending.map((m) => m.id);
async function withCopyTenant(suffix: string, work: (id: string) => Promise<void>) {
  const id = `${prefix}-${suffix}`;
  try {
    await work(id);
  } finally {
    await forgetTenant(app, id);
  }
}

beforeAll(async () => {
  if (enabled) {
    app = createTestManagement();
    await bootstrap(app);
    copy = await packageCopy("migrations");
    await copy.write(
      `src/migrations/tenant/${INDEX_ID}.sql`,
      "--up\nCREATE INDEX CONCURRENTLY users_name_idx ON users (name);\n\n--down\nDROP INDEX CONCURRENTLY users_name_idx;\n",
    );
    await copy.codegen();
    pkg = await copy.management();
    ext = createCopyManagement();
  }
});
afterAll(async () => {
  if (ext) await ext.close();
  if (copy) await copy.remove();
  if (!app) return;
  try {
    await removeTenants(app, prefix);
  } finally {
    await app.close();
  }
});

/** db0'da `schema.relation` (tablo/index) ya da `column` verilirse sütunu var mı. */
const exists = async (schema: string, relation: string, column = "") =>
  (
    await app.pools
      .node("db0")
      .query<{ found: boolean }>(
        column
          ? "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3) AS found"
          : "SELECT to_regclass($1 || '.' || $2) IS NOT NULL AND $3='' AS found",
        [schema, relation, column],
      )
  )[0]?.found;

integration("global admission excludes migrations but parallel provisions only take tenant locks", async () => {
  const lock = await openManagementSession(app, "db0", "migration-runner");
  try {
    await expect(migrateTenant(app, `${prefix}-missing`)).rejects.toMatchObject({ code: "MIGRATION_RUNNER_BUSY" });
    await expect(migrateAll(app)).rejects.toMatchObject({ code: "MIGRATION_RUNNER_BUSY" });
    await expect(rollbackTenant(app, `${prefix}-missing`)).rejects.toMatchObject({ code: "MIGRATION_RUNNER_BUSY" });
    const ids = [1, 2, 3].map((i) => `${prefix}-parallel-${i}`);
    const placements = await Promise.all(ids.map((id) => provisionTenant(app, id, "db0")));
    expect(placements.map((p) => [p.status, p.schemaVersion])).toEqual(ids.map(() => ["active", n]));
  } finally {
    await lock.close();
  }
});

integration("a held tenant lock blocks provision and migrate of that tenant before placement writes", async () => {
  const id = `${prefix}-blocked`;
  await withTenantLock(app, id, async () => {
    await expect(provisionTenant(app, id, "db0")).rejects.toMatchObject({ code: "TENANT_BUSY" });
    await expect(app.platform.get(id)).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  });
  const node = await openManagementSession(app, "db0", tenantManagementKey(id));
  try {
    await expect(provisionTenant(app, id, "db0")).rejects.toMatchObject({ code: "TENANT_BUSY" });
  } finally {
    await node.close();
  }
  await expect(app.platform.get(id)).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  expect((await provisionTenant(app, id, "db0")).status).toBe("active");
});

integration("migrate-all skips up-to-date placements without sessions", async () => {
  const id = `${prefix}-noop`;
  await provisionTenant(app, id, "db0");
  const events: { tenantId?: unknown; status?: unknown }[] = [];
  const summary = await migrateAll(app, { databaseIds: ["db0"], report: (event) => events.push(event) });
  expect(summary.failed).toBe(0);
  expect(events.filter((event) => event.tenantId === id).map((event) => event.status)).toEqual(["succeeded"]);
  expect(events.some((event) => event.status === "session-acquired")).toBe(false);
  expect(await migrateTenant(app, id)).toMatchObject({ migrations: [] });
});

integration("placement writes compare placement_version and never override a move owner", async () => {
  const id = `${prefix}-cas`;
  const p = await provisionTenant(app, id, "db0");
  const update = (sql: string, params: unknown[] = []) =>
    app.pools.platform.query(`UPDATE platform.placements SET ${sql} WHERE tenant_id=$1`, [id, ...params]);
  await update("placement_version=placement_version+1");
  await expect(app.platform.setSchemaVersion(p, 0)).rejects.toMatchObject({ code: "PLACEMENT_CONFLICT" });
  await expect(app.platform.setStatus(p, "failed")).rejects.toMatchObject({ code: "PLACEMENT_CONFLICT" });
  const current = await app.platform.get(id);
  await update("move_operation_id=$2", [crypto.randomUUID()]);
  await expect(app.platform.setStatus(current, "maintenance")).rejects.toMatchObject({ code: "PLACEMENT_CONFLICT" });
  await update("move_operation_id=NULL");
  expect((await app.platform.setStatus(current, "maintenance")).status).toBe("maintenance");
});

integration("provision rejects an unowned preexisting schema without recording placement", async () => {
  const id = `${prefix}-unowned`,
    schema = tenantSchema(id);
  const db = app.pools.node("db0");
  await db.exec(`CREATE SCHEMA ${q(schema)}`);
  try {
    await expect(provisionTenant(app, id, "db0")).rejects.toMatchObject({ code: "SCHEMA_EXISTS" });
    await expect(app.platform.get(id)).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  } finally {
    await db.exec(`DROP SCHEMA ${q(schema)}`);
  }
});

integration("resume recovers a valid unrecorded concurrent index", () =>
  withCopyTenant("unrecorded", async (id) => {
    const p = await pkg.provisionTenant(ext, id, "db0");
    const db = app.pools.node("db0");
    await db.query(`DELETE FROM ${q(p.schemaName, "_migrations")} WHERE id=$1`, [ids[3]]);
    expect(await pkg.migrateTenant(ext, id)).toMatchObject({ migrations: [ids[3]] });
    const rows = await db.query<{ id: string }>(`SELECT id FROM ${q(p.schemaName, "_migrations")} ORDER BY id`);
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(await exists(p.schemaName, "users_name_idx")).toBe(true);
  }),
);

integration("stale runner marker requires explicit recovery and refuses live old sessions", async () => {
  const runId = crypto.randomUUID();
  await app.pools.platform.query("INSERT INTO platform.migration_runner(singleton,run_id) VALUES(true,$1)", [runId]);
  const worker = await openManagementSession(app, "db0", `${prefix}-orphan`, { applicationName: `tenant-migration:${runId}` });
  try {
    await expect(migrateAll(app)).rejects.toMatchObject({ code: "MIGRATION_RECOVERY_REQUIRED" });
    await expect(recoverMigrations(app)).rejects.toMatchObject({ code: "MIGRATION_RECOVERY_REQUIRED" });
  } finally {
    await worker.close();
  }
  expect(await recoverMigrations(app)).toEqual({ recovered: true });
  expect(await runnerMarkers()).toHaveLength(0);
  expect(await recoverMigrations(app)).toEqual({ recovered: false });
});

/** Kopya registry'si: `user_imports`'tan sonrası geri alınır; sonraki çalıştırma önce `users`'ı kilitlemeli (user_imports yabancı
 * anahtarı), sonra rate limit tabloları ve index. */
async function rewind(id: string) {
  const p = await pkg.provisionTenant(ext, id, "db0");
  expect(await pkg.rollbackTenant(ext, id, { steps: 3 })).toMatchObject({ migrations: [ids[3], ids[2], ids[1]] });
  return p;
}

integration("rollback runs down sections under the runner, lowers schema_version with the ledger and migrates up again", async () => {
  const id = `${prefix}-rollback`;
  const p = await provisionTenant(app, id, "db0");
  const has = (relation: string, column?: string) => exists(p.schemaName, relation, column);
  const version = async () => (await app.platform.get(id)).schemaVersion;
  expect(await rollbackTenant(app, id, { dryRun: true, steps: 3 })).toEqual({ tenantId: id, dryRun: true, migrations: [real[2], real[1], real[0]] });
  expect(await rollbackTenant(app, id, { to: real[0] })).toEqual({ tenantId: id, dryRun: false, migrations: [real[2], real[1]] });
  expect([await has("user_imports"), await has("rate_limit"), await has("users", "email"), await version(), await pendingIds(id)]).toEqual([
    false,
    false,
    true,
    n - 2,
    [real[1], real[2]],
  ]);
  await expect(rollbackTenant(app, id, { steps: n })).rejects.toMatchObject({ code: "USAGE" });
  await expect(rollbackTenant(app, id, { to: real[1] })).rejects.toMatchObject({ code: "MIGRATION_NOT_APPLIED" });
  expect(await rollbackTenant(app, id)).toMatchObject({ migrations: [real[0]] });
  expect([await has("users"), await version(), await pendingIds(id)]).toEqual([false, 0, real]);

  // up → down → up
  expect(await migrateTenant(app, id)).toMatchObject({ migrations: real });
  expect([await has("users", "email"), await has("user_imports"), await has("rate_limit"), await version()]).toEqual([true, true, true, n]);
  expect(await rollbackTenant(app, id)).toMatchObject({ migrations: [real[2]] });

  // migrate-all sees the lowered schema_version and restores the tenant.
  const events: Record<string, unknown>[] = [];
  const summary = await migrateAll(app, { databaseIds: ["db0"], report: (event) => events.push(event) });
  expect(summary.failed).toBe(0);
  expect(events).toContainEqual(expect.objectContaining({ tenantId: id, migration: real[2], direction: "up", status: "succeeded" }));
  expect([await pendingIds(id), await version(), await has("rate_limit")]).toEqual([[], n, true]);
});

integration("concurrent index rollback runs outside a transaction and a drop that finished before its ledger delete is retried", () =>
  withCopyTenant("concurrent-drop", async (id) => {
    const p = await pkg.provisionTenant(ext, id, "db0");
    const version = async () => (await app.platform.get(id)).schemaVersion;
    expect(await pkg.rollbackTenant(ext, id)).toEqual({ tenantId: id, dryRun: false, migrations: [ids[3]] });
    expect([await exists(p.schemaName, "users_name_idx"), await version()]).toEqual([false, ids.length - 1]);
    expect((await pkg.migrationStatus(ext, id)).pending).toEqual([{ id: ids[3], transactional: false }]);
    expect(await pkg.migrateTenant(ext, id)).toMatchObject({ migrations: [ids[3]] });
    expect([await exists(p.schemaName, "users_name_idx"), await version()]).toEqual([true, ids.length]);
    // A concurrent drop that finished before its ledger delete only removes the ledger row on retry.
    await app.pools.node("db0").exec(`DROP INDEX ${q(p.schemaName, "users_name_idx")}`);
    expect(await pkg.rollbackTenant(ext, id)).toMatchObject({ migrations: [ids[3]] });
    expect(await copyPendingIds(id)).toEqual([ids[3]]);
  }),
);

integration("cancelled blocked DDL rolls back its ledger and resumes in order", () =>
  withCopyTenant("cancel", async (id) => {
    const p = await rewind(id);
    const blocker = await openManagementSession(app, "db0", `${prefix}-blocker`);
    const aborter = new AbortController();
    const quick = createCopyManagement({ shutdownGraceMs: 20, migrationLockTimeoutMs: 1000 });
    try {
      await blocker.db.transaction(async (tx) => {
        await tx.exec(`LOCK TABLE ${q(p.schemaName, "users")} IN ACCESS EXCLUSIVE MODE`);
        await expect(
          pkg.migrateTenant(quick, id, {
            signal: aborter.signal,
            report: (event) => {
              if (event.status === "started") aborter.abort();
            },
          }),
        ).rejects.toThrow();
      });
      expect(await copyPendingIds(id)).toEqual([ids[1], ids[2], ids[3]]);
      expect(await runnerMarkers()).toHaveLength(1);
      await Bun.sleep(200);
      await pkg.recoverMigrations(ext);
      expect(await pkg.migrateTenant(ext, id)).toMatchObject({ migrations: [ids[1], ids[2], ids[3]] });
      expect(await copyPendingIds(id)).toHaveLength(0);
    } finally {
      await blocker.close();
      await quick.close();
    }
  }),
);

integration("placement pagination uses one bytewise order across hyphenated tenant ids", async () => {
  // Locale collations ignore `-` and `.` at first level; COLLATE "C" and JS sort are bytewise.
  const ids = ["a", "a-b", "a0", "ab"].map((suffix) => `${prefix}-order-${suffix}`);
  for (const id of ids) await app.platform.create(id, "db0");
  const page = await app.platform.listPage("db0", `${prefix}-order-`, 4);
  expect(page.map((row) => row.tenantId)).toEqual([...ids].sort());
  const last = page[1];
  if (!last) throw new Error("Missing page");
  const second = await app.platform.listPage("db0", last.tenantId, 2);
  expect(second.map((row) => row.tenantId)).toEqual([...ids].sort().slice(2));
});

integration("dry-run remains available during live global admission and does not mutate markers", async () => {
  const lock = await openManagementSession(app, "db0", "migration-runner");
  try {
    const before = await app.pools.platform.query("SELECT * FROM platform.migration_runner");
    expect((await migrateAll(app, { dryRun: true })).failed).toBe(0);
    expect(await app.pools.platform.query("SELECT * FROM platform.migration_runner")).toEqual(before);
  } finally {
    await lock.close();
  }
});

integration("worker budget closes idle other-database backends and reuses a healthy backend", async () => {
  const nodes = app.config.nodes.slice(0, 2);
  if (nodes.length !== 2) throw new Error("Two databases required");
  const applicationName = `worker-budget:${crypto.randomUUID()}`;
  const signal = new AbortController().signal;
  const workers = createMigrationSessions(app, { concurrency: 1, signal, applicationName, report: () => {} });
  const counts = async () => {
    const result: number[] = [];
    for (const node of nodes) {
      const [row] = await app.pools
        .node(node.id)
        .query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1 AND datname=current_database()",
          [applicationName],
        );
      result.push(row?.count ?? -1);
    }
    return result;
  };
  try {
    for (const [index, node] of nodes.entries()) {
      const pids: number[] = [];
      for (const suffix of ["a", "b"]) {
        await workers.run(node.id, `${prefix}-${suffix.replaceAll("_", "-")}`, signal, async (db, assertAlive) => {
          assertAlive();
          const [row] = await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          pids.push(row?.pid ?? -1);
          // Count real physical backends in both databases while the worker is borrowed.
          expect(await counts()).toEqual(index === 0 ? [1, 0] : [0, 1]);
        });
      }
      expect(pids[0]).toBeGreaterThan(0);
      expect(pids[1]).toBe(pids[0]);
    }
  } finally {
    await workers.close();
  }
  expect(await counts()).toEqual([0, 0]);
});

integration("terminated worker cannot continue unlocked and retains the recovery marker", () =>
  withCopyTenant("terminated", async (id) => {
    const p = await rewind(id);
    const db = app.pools.node("db0");
    const blocker = await openManagementSession(app, "db0", `${prefix}-termination-blocker`);
    let pid: number | undefined;
    let termination: Promise<unknown> | undefined;
    try {
      await blocker.db.transaction(async (tx) => {
        await tx.exec(`LOCK TABLE ${q(p.schemaName, "users")} IN ACCESS EXCLUSIVE MODE`);
        await expect(
          pkg.migrateTenant(ext, id, {
            report: (event) => {
              if (event.status === "session-acquired") pid = event.backendPid as number;
              if (event.status === "started" && pid && !termination)
                termination = db
                  .query<{ stopped: boolean }>("SELECT pg_terminate_backend($1) AS stopped", [pid])
                  .then((rows) => expect(rows[0]?.stopped).toBe(true));
            },
          }),
        ).rejects.toThrow();
        await termination;
      });
      expect(pid).toBeGreaterThan(0);
      expect(await copyPendingIds(id)).toEqual([ids[1], ids[2], ids[3]]);
      expect(await runnerMarkers()).toHaveLength(1);
      await pkg.recoverMigrations(ext);
      await pkg.migrateTenant(ext, id);
      expect(await copyPendingIds(id)).toHaveLength(0);
    } finally {
      await blocker.close();
    }
  }),
);

integration("shared platform session rejects duplicate owners and releases individual tenant keys", async () => {
  const session = await openSession(app, "db0");
  const firstKey = `${prefix}-shared-first`,
    secondKey = `${prefix}-shared-second`;
  try {
    const first = await session.acquire(firstKey);
    const second = await session.acquire(secondKey);
    await expect(session.acquire(firstKey)).rejects.toMatchObject({ code: "TENANT_BUSY" });
    await first.release();
    await second.assertOwned();
    const next = await session.acquire(firstKey);
    expect(() => first.assertAlive()).toThrow("released");
    await next.assertOwned();
    await next.release();
    await second.release();
  } finally {
    await session.close();
  }
});

integration("management session rejects 128 queued queries after backend termination", async () => {
  const db = app.pools.node("db0");
  const applicationName = `queued-loss:${crypto.randomUUID()}`;
  const session = await openManagementSession(app, "db0", `${prefix}-queued-loss`, { applicationName });
  try {
    const settled = Promise.allSettled(Array.from({ length: 128 }, () => session.db.query("SELECT pg_sleep(10)")));
    const [killed] = await db.query<{ stopped: boolean }>("SELECT pg_terminate_backend($1) AS stopped", [session.pid]);
    expect(killed?.stopped).toBe(true);
    const started = performance.now();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(session.signal.aborted).toBe(true);
    const [remaining] = await db.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1",
      [applicationName],
    );
    expect(remaining?.count).toBe(0);
  } finally {
    await session.close();
  }
});
