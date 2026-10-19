/** Kademeli yedek, dışa aktarma, geri yükleme ve yedek temizleme (gerçek PostgreSQL, geçici klasör). */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAll, type BackupManifest, exportTenant, pruneBackups, restoreTenant } from "../../core/tools/backup";
import type { Placement } from "../../core/tenants/model";
import { bootstrap, provisionTenant } from "../../management";
import { createTestManagement, enabled, failure, integration, q, removeTenants } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
let root: string;
const base = `bak-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
  root = await mkdtemp(join(tmpdir(), "db-backup-"));
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (!app) return;
  try {
    await removeTenants(app, base);
  } finally {
    await app.close();
  }
});

/** Inserts users (id default, unique emails) and forces this backend's statistics flush, so the change marker sees the write immediately. */
async function addUsers(p: Placement, count: number) {
  await app.pools.node(p.databaseId).transaction(async (tx) => {
    await tx.query(
      `INSERT INTO ${q(p.schemaName, "users")} (name,email) SELECT 's'||g, gen_random_uuid()::text||'@example.com' FROM generate_series(1,$1) g`,
      [count],
    );
    await tx.query("SELECT pg_stat_force_next_flush()");
  });
}
const users = async (p: Placement) =>
  (await app.pools.node(p.databaseId).query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${q(p.schemaName, "users")}`))[0]?.n;
/** Simulates losing a tenant: schema and platform rows gone. */
async function destroy(p: Placement) {
  await app.pools.node(p.databaseId).exec(`DROP SCHEMA ${q(p.schemaName)} CASCADE`);
  await app.pools.platform.query("DELETE FROM platform.placements WHERE tenant_id=$1", [p.tenantId]);
  await app.pools.platform.query("DELETE FROM platform.tenants WHERE tenant_id=$1", [p.tenantId]);
}
const manifest = async (id: string) => (await Bun.file(join(root, id, "manifest.json")).json()) as BackupManifest;
const nextSecond = () => Bun.sleep(1100);

integration("incremental backup rewrites only changed tenants and restore rebuilds a lost tenant from the chain", async () => {
  const [one, two] = [await provisionTenant(app, `${base}-one`, "db0"), await provisionTenant(app, `${base}-two`, "db1")];
  await addUsers(one, 120);
  await addUsers(two, 1234);
  const tenants = [one.tenantId, two.tenantId];

  const full = await backupAll(app, root, { full: true, tenants });
  expect(full).toMatchObject({ full: true, base: null, tenants: 2, written: 2, unchanged: 0, failed: 0 });
  await nextSecond();
  await addUsers(one, 5);
  const incremental = await backupAll(app, root, { tenants });
  expect(incremental).toMatchObject({ full: false, base: full.id, written: 1, unchanged: 1, failed: 0 });
  const chain = await manifest(incremental.id);
  expect(chain.tenants[one.tenantId]?.set).toBe(incremental.id);
  expect(chain.tenants[two.tenantId]?.set).toBe(full.id);
  expect(await readdir(join(root, incremental.id, "platform"))).toContain("placements.jsonl.gz");

  // A live tenant is never overwritten.
  expect(await failure(restoreTenant(app, two.tenantId, root))).toBe("TENANT_EXISTS");
  // Lose both; restore from the latest set (two's data lives in the full set).
  await destroy(one);
  await destroy(two);
  const restoredTwo = await restoreTenant(app, two.tenantId, root, { databaseId: "db1" });
  expect(restoredTwo.placement).toMatchObject({ tenantId: two.tenantId, databaseId: "db1", status: "active" });
  expect(restoredTwo.migrationsApplied).toEqual([]);
  expect(await users(restoredTwo.placement)).toBe(1234);
  const restoredOne = await restoreTenant(app, one.tenantId, root, { databaseId: "db0", set: full.id });
  expect(await users(restoredOne.placement)).toBe(120);
  // The restored schema accepts writes (sequences, defaults and keys came back).
  await addUsers(restoredOne.placement, 1);
  expect(await users(restoredOne.placement)).toBe(121);

  // Pruning keeps the newest set and the older set it points to; a new full set frees both.
  expect(await pruneBackups(root, 1)).toEqual({ kept: [full.id, incremental.id], removed: [] });
  await nextSecond();
  const fresh = await backupAll(app, root, { full: true, tenants });
  expect(await pruneBackups(root, 1)).toEqual({ kept: [fresh.id], removed: [full.id, incremental.id] });
});

integration("export writes one tenant's whole data at once and restore accepts the export folder", async () => {
  const p = await provisionTenant(app, `${base}-export`, "db1");
  await addUsers(p, 42);
  const dir = join(root, "export-one");
  expect(await exportTenant(app, p.tenantId, dir)).toMatchObject({ tenantId: p.tenantId, dir });
  expect(await failure(exportTenant(app, p.tenantId, dir))).toBe("BACKUP_EXISTS");
  await destroy(p);
  // Placement is chosen again (no database given); data and row counts come back.
  const restored = await restoreTenant(app, p.tenantId, dir);
  expect(restored.placement.status).toBe("active");
  expect(await users(restored.placement)).toBe(42);
  expect(await failure(restoreTenant(app, `${base}-other`, dir))).toBe("BACKUP_INVALID");
});

integration("back-to-back backups started in the same second get distinct sets instead of BACKUP_EXISTS", async () => {
  const dir = join(root, "back-to-back");
  const first = await backupAll(app, dir, { full: true, tenants: [] });
  const second = await backupAll(app, dir, { full: true, tenants: [] });
  expect(second.id).not.toBe(first.id);
  expect((await readdir(dir)).sort()).toEqual([first.id, second.id].sort());
});
