/** Migration and seed registries and the ledger drift rule. Seam: the SQL/TS files live outside core; core takes them only from the generated
 * `src/migrations/index.gen.ts` and `src/seeds/index.gen.ts` lists. */
import migrationList from "../../migrations/index.gen";
import seedList from "../../seeds/index.gen";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { foldTables } from "../sql/tables";
import { compileMigrations, compileSeeds, type Migration, type Seed } from "./source";

export type { Migration, Seed } from "./source";
export interface Registry {
  readonly migrations: readonly Migration[];
  readonly seeds: readonly Seed[];
}
export const migrations = compileMigrations(migrationList);
export const seeds = compileSeeds(seedList);
export const registry: Registry = { migrations, seeds };
/** Folded migration tables: `prepareQuery` expands `*` from the same source as codegen. */
export const migrationTables = () => foldTables(migrations.flatMap((migration) => migration.up.statements)).tables;

export type AppliedMigration = { id: string; checksum: string };
type DriftCode = "MIGRATION_DRIFT" | "SEED_DRIFT";

/** The remaining suffix of the registry; any history that is unknown, changed, duplicated or out of order is drift (`code`). */
export function pendingMigrations<T extends AppliedMigration>(applied: readonly AppliedMigration[], list: readonly T[], code: DriftCode = "MIGRATION_DRIFT"): readonly T[] {
  for (const { id, checksum } of applied)
    if (list.find((migration) => migration.id === id)?.checksum !== checksum) throw new AppError(code, `Unknown or modified migration: ${id}`);
  const appliedIds = new Set(applied.map((entry) => entry.id));
  if (appliedIds.size !== applied.length) throw new AppError(code, "Duplicate migration history");
  const pending = list.filter((migration) => !appliedIds.has(migration.id));
  // The applied history must be a prefix of the list: nothing can be applied after the first pending migration.
  if (list.slice(list.length - pending.length).some((migration) => appliedIds.has(migration.id))) throw new AppError(code, "Migration history contains a gap");
  return pending;
}

/** The fixed, quoted `ledger` table. */
export const createLedger = (ledger: string) =>
  `CREATE TABLE IF NOT EXISTS ${ledger} (id text PRIMARY KEY,checksum text NOT NULL,completed_at timestamptz NOT NULL DEFAULT now())`;

/** Reads the ledger and returns the pending suffix of the list; `missingOk`: if the table does not exist, everything is pending. */
export async function pendingIn<T extends AppliedMigration>(
  db: Connection,
  ledger: string,
  list: readonly T[],
  { code, missingOk }: { code?: DriftCode; missingOk?: boolean } = {},
): Promise<readonly T[]> {
  if (missingOk) {
    const [table] = await db.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [ledger]);
    if (!table?.exists) return list;
  }
  const rows = await db.query<AppliedMigration>(`SELECT id,checksum FROM ${ledger} ORDER BY id`);
  return pendingMigrations(rows, list, code);
}

/** What to roll back: the last `steps` (default 1) migrations, or those after `to` so that `to` remains the last applied one. */
export type RollbackTarget = { steps?: number; to?: string };

/** Applied prefix → rollback order (newest to oldest); rejects unknown targets and irreversible migrations before any DDL. */
export function rollbackTargets(applied: readonly Migration[], { steps, to }: RollbackTarget): Migration[] {
  if (steps !== undefined && to !== undefined) throw new AppError("USAGE", "Use either steps or to");
  let count = steps ?? 1;
  if (to !== undefined) {
    const index = applied.findIndex((migration) => migration.id === to);
    if (index < 0) throw new AppError("MIGRATION_NOT_APPLIED", "The --to target is not an applied migration");
    count = applied.length - 1 - index;
  } else if (!Number.isSafeInteger(count) || count < 1 || count > applied.length)
    throw new AppError("USAGE", `steps must be between 1 and the ${applied.length} applied migrations`);
  const targets = applied.slice(applied.length - count).reverse();
  const irreversible = targets.find((migration) => !migration.down);
  if (irreversible) throw new AppError("MIGRATION_IRREVERSIBLE", `${irreversible.id} has an empty --down section and cannot be rolled back`);
  return targets;
}
