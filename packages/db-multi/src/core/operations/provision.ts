/** Tenant lifecycle: provision (real or demo), seed, seed-all and demo reset. All take the same tenant locks as migrate
 * (platform `tenant-operation`, node `tenant-management`); they do not take the global migration runner. */
import { setTimeout as sleep } from "node:timers/promises";
import { stopwatch } from "../database";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { migrateBatch, migrationLimits, type MigrationReport, type MigrationRunOptions, noReport } from "../migrations/batch";
import { applyChain, applySeeds, pendingAt, pendingSeeds, type SessionConnection } from "../migrations/schema";
import { SEED_PROFILES, type SeedProfile } from "../migrations/source";
import type { TenantFields, TenantRow } from "../tenants/fields";
import { type Kind, type Placement, quoteIdentifier, requireActive, tenantSchemas, validateTenantId } from "../tenants/model";
import { checkDatabases } from "../tenants/nodes";
import { afterGrace, cancelled, openManagementSession, ownershipCheck, tenantManagementKey, withTenantLock } from "./locks";

type Options = Pick<MigrationRunOptions, "signal" | "report">;
type Check = () => Promise<void>;
export type SeedOptions = Options & { profile?: SeedProfile; dryRun?: boolean };
/** `size`: the tenant's estimated load 1–100 (default 1); placement uses it to find the least loaded `active` database. `tenant`: the application's
 * `platform.tenants` columns (`{ name: "…", owner_email: "…" }`), written only to a new tenant record. */
export type ProvisionOptions = Options & { demo?: boolean; size?: number; tenant?: TenantFields };
const demoRequired = () => new AppError("DEMO_TENANT_REQUIRED", "Only demo tenants accept demo seeds or reset");
const unavailable = (message: string) => new AppError("TENANT_UNAVAILABLE", message);
/** A real tenant gets only install seeds; a demo tenant gets install and demo seeds. */
const seedProfilesFor = (kind: Kind) => SEED_PROFILES.slice(0, kind === "demo" ? 2 : 1);

/**
 * Tenant locks and a node session on `databaseId`. If `databaseId` is a function, it is called after the platform tenant lock is
 * acquired (the placement write stays under the lock); the resolved database is the fourth argument of `work`. `verify` is called before every write (cheap),
 * `assertOwned` before activation (queries). The signal gives the work the grace period, then cancels both sessions.
 */
export async function withTenantSession<T>(
  m: Management,
  tenantId: string,
  databaseId: string | (() => Promise<string>),
  options: Options,
  work: (db: SessionConnection, verify: Check, assertOwned: Check, databaseId: string) => Promise<T>,
): Promise<T> {
  if (typeof databaseId === "string") m.pools.nodeConfig(databaseId);
  if (options.signal?.aborted) throw cancelled();
  const expiry = new AbortController();
  const { signal } = expiry;
  const stopGrace = afterGrace(options.signal, m.config.shutdownGraceMs, () => expiry.abort());
  const lockWait = stopwatch();
  try {
    const locked = async (assertTenant: Check, tenantSignal: AbortSignal) => {
      m.emit({ name: "tenant.lock", ms: lockWait(), tenantId });
      const target = typeof databaseId === "string" ? databaseId : await databaseId();
      const sessionOpen = stopwatch();
      const node = await openManagementSession(m, m.pools.nodeConfig(target).id, tenantManagementKey(tenantId), { signal });
      m.emit({ name: "tenant.session", ms: sessionOpen(), tenantId, databaseId: target });
      try {
        const verify = ownershipCheck(AbortSignal.any([signal, tenantSignal]), node.assertAlive);
        await verify();
        const assertOwned = async () => {
          await assertTenant();
          await node.assertOwned();
        };
        return await work(node.db, verify, assertOwned, target);
      } finally {
        await node.close();
      }
    };
    return await withTenantLock(m, tenantId, locked, { signal });
  } finally {
    stopGrace();
  }
}

/** An unfinished (running or failed) move owns the placement: reset does not touch it even if its status is `maintenance`. */
async function moveOwnsPlacement(m: Management, tenantId: string) {
  const [row] = await m.pools.platform.query<{ moving: boolean }>(
    "SELECT move_operation_id IS NOT NULL AS moving FROM platform.placements WHERE tenant_id=$1",
    [tenantId],
  );
  return row?.moving === true;
}

/** The placement re-read under the lock; `PLACEMENT_CONFLICT` if it has moved. */
export async function reread(m: Management, found: Placement) {
  const placement = await m.platform.get(found.tenantId);
  if (placement.databaseId !== found.databaseId || placement.schemaName !== found.schemaName)
    throw new AppError("PLACEMENT_CONFLICT", "Tenant moved; retry");
  return placement;
}

/** No database may contain this ID's `tenant_…` or `demo_…` schema: a tenant ID is a single schema across all databases, so a second
 * copy is never accidentally created in another database. */
export async function assertTenantSchemaFree(m: Management, tenantId: string) {
  const names = JSON.stringify(tenantSchemas(tenantId));
  for (const { id } of m.config.nodes) {
    const [found] = await m.pools
      .node(id)
      .query<{ name: string }>("SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb)) LIMIT 1", [names]);
    if (found) throw new AppError("SCHEMA_EXISTS", `Schema ${found.name} already exists on ${id}; a tenant id has one schema across all databases`);
  }
}

/** Database readiness (all databases), then the registered placement's database (a retry with the same intent) or, for a new tenant, schema
 * uniqueness and placement selection. Does not write: the placement is written by `claimPlacement` once the node session is also acquired. */
export async function pickDatabase(m: Management, tenantId: string, databaseId: string | undefined, kind: Kind, size?: number) {
  await checkDatabases(
    m.pools,
    m.config.nodes.map((node) => node.id),
  );
  const existing = await m.platform.get(tenantId).catch((error) => {
    if (errorCode(error) !== "TENANT_NOT_FOUND") throw error;
  });
  if (existing) {
    if ((databaseId !== undefined && existing.databaseId !== databaseId) || existing.kind !== kind)
      throw new AppError("TENANT_CONFLICT", "Tenant exists with different placement intent");
    return existing.databaseId;
  }
  await assertTenantSchemaFree(m, tenantId);
  return m.platform.choose(tenantId, databaseId, size);
}

/** Writes the placement to the chosen database (returns the same one if registered); called while both tenant locks are held. `tenant` holds validated fields. */
export const claimPlacement = (m: Management, tenantId: string, databaseId: string, kind: Kind, size?: number, tenant?: TenantRow) =>
  m.platform.create(tenantId, databaseId, kind, size, tenant);

/** Migrations, install seeds (then demo seeds for a demo tenant), then `active`. */
async function migrateSeedActivate(m: Management, found: Placement, db: SessionConnection, verify: Check, assertOwned: Check, report: MigrationReport) {
  const { placement } = await applyChain(m, found, db, verify, report);
  for (const profile of seedProfilesFor(found.kind)) await applySeeds(m, placement, db, verify, report, profile);
  await assertOwned();
  return m.span("provision.activate", () => m.platform.setStatus(placement, "active"), { tenantId: found.tenantId });
}

/**
 * New tenant: placement, schema, migrations, seeds and activation. If `databaseId` is not given, the least loaded `active` database is chosen
 * by `size`; `demo` means a `demo_…` schema and demo seeds. Retrying with the same intent is safe (the chosen database is registered,
 * and half-finished seeds are completed). `tenant` fields are validated against the real columns before the locks (`INVALID_CONFIG`).
 */
export async function provisionTenant(m: Management, tenantId: string, databaseId?: string, options: ProvisionOptions = {}) {
  validateTenantId(tenantId);
  const kind = options.demo ? "demo" : "tenant";
  const tenant = await m.platform.tenantFields(options.tenant);
  // The database is chosen under the platform tenant lock; the placement is written only once the node lock is also held.
  const pick = () => m.span("provision.pick", () => pickDatabase(m, tenantId, databaseId, kind, options.size), { tenantId });
  return withTenantSession(m, tenantId, pick, options, async (db, verify, assertOwned, target) => {
    const claimed = await m.span("provision.claim", () => claimPlacement(m, tenantId, target, kind, options.size, tenant), { tenantId });
    const placement = await reread(m, claimed);
    if (!["active", "provisioning", "failed"].includes(placement.status)) throw unavailable("Tenant has another operation");
    if (placement.status === "active") {
      if ((await pendingAt(m, placement)).length) throw new AppError("TENANT_EXISTS", "Existing active tenant requires migrate");
      return placement;
    }
    await verify();
    const createSchema = () => db.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(placement.schemaName)}`);
    await m.span("provision.schema", createSchema, { tenantId, databaseId: placement.databaseId });
    return migrateSeedActivate(m, placement, db, verify, assertOwned, options.report ?? noReport);
  });
}

/** An active tenant's pending seeds (`install` by default; `demo` only for a demo tenant). `seeds` are the applied (dry-run: pending) IDs. */
export async function seedTenant(m: Management, tenantId: string, options: SeedOptions = {}) {
  const profile = options.profile ?? "install";
  if (!SEED_PROFILES.includes(profile)) throw new AppError("USAGE", `Seed profile must be one of: ${SEED_PROFILES.join(", ")}`);
  const found = await m.platform.get(tenantId);
  if (profile === "demo" && found.kind !== "demo") throw demoRequired();
  const readPendingSeeds = () => pendingSeeds(m.pools.node(found.databaseId), found.schemaName, profile);
  if (options.dryRun) {
    if (options.signal?.aborted) throw cancelled();
    const pending = await readPendingSeeds();
    return { tenantId, profile, dryRun: true, seeds: pending.map((seed) => seed.id) };
  }
  // If nothing is pending (the ledger is authoritative): no tenant lock or session, like migrate-all on up-to-date schemas.
  if (found.status === "active" && !(await readPendingSeeds()).length) return { tenantId, profile, dryRun: false, seeds: [] };
  const seeds = await withTenantSession(m, tenantId, found.databaseId, options, async (db, verify) => {
    const placement = requireActive(await reread(m, found), "Tenant not ready for seeding");
    return applySeeds(m, placement, db, verify, options.report ?? noReport, profile);
  });
  return { tenantId, profile, dryRun: false, seeds };
}

/** `seedTenant` for every active tenant, with the same paging and concurrency as migrate-all; with the `demo` profile, real tenants are skipped. */
export function seedAll(m: Management, options: MigrationRunOptions & { profile?: SeedProfile } = {}) {
  const limits = migrationLimits(m.config, options);
  const run = async (target: { tenantId: string; kind?: string }, signal: AbortSignal) => {
    if (options.profile !== "demo" || target.kind === "demo") await seedTenant(m, target.tenantId, { ...options, signal });
  };
  const listPage = (id: string, after: string, limit: number) => m.platform.listPage(id, after, limit);
  const batchOptions = { ...limits, continueOnError: options.continueOnError, signal: options.signal };
  return migrateBatch({ databases: limits.databases, listPage, run }, batchOptions, options.report);
}

/** Resets a demo tenant: `maintenance`, the schema is dropped and recreated, migrations and seeds, `active`. If interrupted,
 * run it again: every call invalidates the placement (even if it is already `maintenance`) and waits the full
 * `placementCacheWaitMs` before the destructive SQL; it does not touch the placement of an unfinished move. */
export async function resetDemoTenant(m: Management, tenantId: string, options: Options = {}) {
  const found = await m.platform.get(tenantId);
  if (found.kind !== "demo") throw demoRequired();
  return withTenantSession(m, tenantId, found.databaseId, options, async (db, verify, assertOwned) => {
    let placement = await reread(m, found);
    if (placement.status === "migrating" || (await moveOwnsPlacement(m, tenantId))) throw unavailable("Tenant has another operation");
    await verify();
    if (placement.status === "maintenance") await m.platform.changed(tenantId);
    else placement = await m.platform.setStatus(placement, "maintenance");
    // Placement caches (runtime, Redis) drop the `active` copy before the schema is dropped; a previous attempt may have been cut short during this wait.
    await sleep(m.config.placementCacheWaitMs, undefined, { signal: options.signal });
    await assertOwned();
    placement = await reread(m, placement);
    if (placement.status !== "maintenance") throw new AppError("PLACEMENT_CONFLICT", "Placement changed during reset; retry");
    // The version drops before the DDL: a half-finished reset never leaves a version greater than the ledger.
    placement = await m.platform.setSchemaVersion(placement, 0);
    await assertOwned();
    const schema = quoteIdentifier(placement.schemaName);
    await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    return migrateSeedActivate(m, placement, db, verify, assertOwned, options.report ?? noReport);
  });
}
