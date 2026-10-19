/** Tenant, platform and node migration registries, install/demo seed registries, and the ledger drift rule (shared by the three ledger types).
 * Seam: the SQL/TS files live outside core; core takes them only from the generated `src/migrations/<scope>/index.gen.ts` and
 * `src/seeds/<profile>/index.gen.ts` lists. */
import node from "../../migrations/node/index.gen";
import platform from "../../migrations/platform/index.gen";
import tenant from "../../migrations/tenant/index.gen";
import demo from "../../seeds/demo/index.gen";
import install from "../../seeds/install/index.gen";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { foldTables } from "../sql/tables";
import { compileMigrations, compileSeeds, type Scope } from "./source";

export type { Migration, Seed } from "./source";
export const tenantMigrations = compileMigrations("tenant", tenant);
export const platformMigrations = compileMigrations("platform", platform);
export const nodeMigrations = compileMigrations("node", node);
const migrationsByScope = { tenant: tenantMigrations, platform: platformMigrations, node: nodeMigrations };
/** The folded migration tables of a scope: `prepareQuery` expands `*` from the same source as codegen. */
export const migrationTables = (scope: Scope) => foldTables(migrationsByScope[scope].flatMap((migration) => migration.up.statements)).tables;
/** A single `_seeds` ledger (PK `id`) holds both profiles: IDs must be unique across profiles too. */
export const seeds = { install: compileSeeds(install), demo: compileSeeds(demo) };
const duplicateSeed = seeds.install.find((installSeed) => seeds.demo.some((demoSeed) => demoSeed.id === installSeed.id));
if (duplicateSeed) throw new AppError("MIGRATION_INVALID", `${duplicateSeed.id}: seed IDs must be unique across profiles`);

export type AppliedMigration = { id: string; checksum: string };
type DriftCode = "MIGRATION_DRIFT" | "SEED_DRIFT";

/** The remaining suffix of the registry; any history that is unknown, modified, duplicated or out of order is drift (`code`). */
export function pendingMigrations<T extends AppliedMigration>(
  applied: readonly AppliedMigration[],
  registry: readonly T[],
  code: DriftCode = "MIGRATION_DRIFT",
): readonly T[] {
  for (const { id, checksum } of applied)
    if (registry.find((migration) => migration.id === id)?.checksum !== checksum) throw new AppError(code, `Unknown or modified migration: ${id}`);
  const appliedIds = new Set(applied.map((entry) => entry.id));
  if (appliedIds.size !== applied.length) throw new AppError(code, "Duplicate migration history");
  const pending = registry.filter((migration) => !appliedIds.has(migration.id));
  // The applied history must be a prefix of the registry: nothing can be applied after the first pending migration.
  if (registry.slice(registry.length - pending.length).some((migration) => appliedIds.has(migration.id)))
    throw new AppError(code, "Migration history contains a gap");
  return pending;
}

/** The fixed, quoted `ledger` table (migrations; seeds have an extra `profile` column). */
export const createLedger = (ledger: string, extra = "") =>
  `CREATE TABLE IF NOT EXISTS ${ledger} (id text PRIMARY KEY,${extra}checksum text NOT NULL,completed_at timestamptz NOT NULL DEFAULT now())`;

/** Reads the ledger (optionally for a single seed profile) and returns the registry's pending suffix; `missingOk`: if the table does not exist, everything is pending. */
export async function pendingIn<T extends AppliedMigration>(
  db: Connection,
  ledger: string,
  registry: readonly T[],
  { code, profile, missingOk }: { code?: DriftCode; profile?: string; missingOk?: boolean } = {},
): Promise<readonly T[]> {
  if (missingOk) {
    const [table] = await db.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [ledger]);
    if (!table?.exists) return registry;
  }
  const where = profile ? " WHERE profile=$1" : "";
  const rows = await db.query<AppliedMigration>(`SELECT id,checksum FROM ${ledger}${where} ORDER BY id`, profile ? [profile] : []);
  return pendingMigrations(rows, registry, code);
}
