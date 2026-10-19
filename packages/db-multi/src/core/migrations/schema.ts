/** The ledgers of a tenant schema: forward chain, rollback, baseline marking, concurrent index recovery and seeds (`_seeds`). */
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { foldTables } from "../sql/tables";
import { type Placement, qualified } from "../tenants/model";
import type { MigrationReport } from "./batch";
import { createLedger, type Migration, pendingIn, type Seed, seeds, tenantMigrations } from "./registry";
import type { SeedProfile } from "./source";

type Verify = () => Promise<void>;
/** A management session connection: its transactions use the session's own timeouts. */
export type SessionConnection = Connection & { transaction<T>(work: (tx: Connection) => Promise<T>): Promise<T> };
/** What to roll back: the last `steps` migrations (default 1), or everything after `to`, so that `to` remains the last applied one. */
export type RollbackTarget = { steps?: number; to?: string };

/** Module-internal chain context: the session holding the lock, the ownership check and the report. */
interface ChainContext {
  m: Management;
  placement: Placement;
  session: SessionConnection;
  verify: Verify;
  report: MigrationReport;
}

const readPending = (db: Connection, schema: string) => pendingIn(db, qualified(schema, "_migrations"), tenantMigrations);

/** Runs `work` in a single session transaction, or directly on the session for CONCURRENTLY index DDL. */
const runStep = (session: SessionConnection, outsideTransaction: boolean, work: (db: Connection) => Promise<void>) =>
  outsideTransaction ? work(session) : session.transaction(work);

/** Runs every bound statement, verifying ownership before each one. */
async function execute(db: Connection, statements: readonly string[], verify: Verify) {
  for (const statement of statements) {
    await verify();
    await db.exec(statement);
  }
}

async function indexState(db: Connection, schema: string, name: string) {
  const [index] = await db.query<{ valid: boolean; is_unique: boolean; relation: string }>(
    "SELECT i.indisvalid AS valid,i.indisunique AS is_unique,c.relname AS relation FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE i.indexrelid=to_regclass($1)",
    [qualified(schema, name)],
  );
  return index;
}

/** CREATE INDEX CONCURRENTLY: a valid index on the same table with the same uniqueness is accepted, an invalid one is rebuilt, and others are rejected. */
async function applyConcurrentIndex(db: Connection, schema: string, m: Migration, verify: Verify) {
  const { name, table, unique } = m.concurrentIndex as NonNullable<Migration["concurrentIndex"]>;
  const existing = await indexState(db, schema, name);
  if (existing) {
    if (existing.relation !== table || existing.is_unique !== unique) throw new AppError("MIGRATION_DRIFT", "Concurrent index definition mismatch");
    if (existing.valid) return;
    await verify();
    await db.exec(`DROP INDEX CONCURRENTLY ${qualified(schema, name)}`);
  }
  await execute(db, m.up.bind(schema), verify);
  await verify();
  if (!(await indexState(db, schema, name))?.valid) throw new AppError("MIGRATION_INDEX_INVALID", "Concurrent index is invalid");
}

interface EachOptions<T> {
  context: ChainContext;
  items: readonly T[];
  key: "migration" | "seed";
  direction: string;
  work: (item: T) => Promise<void>;
}

/** Runs `work` for each item; started/succeeded/failed is reported with `{ [key]: id, direction }`. Returns the completed IDs. */
async function each<T extends { id: string }>({ context, items, key, direction, work }: EachOptions<T>) {
  const { placement: p, report, verify } = context;
  const done: string[] = [];
  for (const item of items) {
    await verify();
    const start = Date.now();
    const event = { tenantId: p.tenantId, databaseId: p.databaseId, schemaName: p.schemaName, [key]: item.id, direction };
    report({ ...event, status: "started" });
    try {
      await work(item);
    } catch (error) {
      report({ ...event, status: "failed", durationMs: Date.now() - start, error: errorCode(error) });
      throw error;
    }
    done.push(item.id);
    report({ ...event, status: "succeeded", durationMs: Date.now() - start });
  }
  return done;
}

/** Read-only: in a schema without a ledger, every migration is pending. */
export function pendingAt(m: Management, placement: Pick<Placement, "databaseId" | "schemaName">) {
  const ledger = qualified(placement.schemaName, "_migrations");
  return pendingIn(m.pools.node(placement.databaseId), ledger, tenantMigrations, { missingOk: true });
}

/** Applied prefix → rollback order (newest to oldest); rejects unknown targets and irreversible migrations before any DDL. */
export function rollbackTargets(applied: readonly Migration[], { steps, to }: RollbackTarget): Migration[] {
  if (steps !== undefined && to !== undefined) throw new AppError("USAGE", "Use either steps or to");
  let count = steps ?? 1;
  if (to !== undefined) {
    const index = applied.findIndex((m) => m.id === to);
    if (index < 0) throw new AppError("MIGRATION_NOT_APPLIED", `${to} is not an applied migration`);
    count = applied.length - 1 - index;
  } else if (!Number.isSafeInteger(count) || count < 1 || count > applied.length)
    throw new AppError("USAGE", `steps must be between 1 and the ${applied.length} applied migrations`);
  const targets = applied.slice(applied.length - count).reverse();
  const irreversible = targets.find((m) => !m.down);
  if (irreversible) throw new AppError("MIGRATION_IRREVERSIBLE", `${irreversible.id} has an empty --down section and cannot be rolled back`);
  return targets;
}

/** A single migration: the DDL and the ledger row are committed together; CREATE INDEX CONCURRENTLY runs outside a transaction. */
function applyMigration({ m, placement: p, session, verify }: ChainContext, ledger: string, migration: Migration) {
  return m.span(
    "migration",
    () =>
      runStep(session, !!migration.concurrentIndex, async (db) => {
        if (migration.concurrentIndex) await applyConcurrentIndex(session, p.schemaName, migration, verify);
        else await execute(db, migration.up.bind(p.schemaName), verify);
        await verify();
        await db.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
      }),
    { tenantId: p.tenantId, databaseId: p.databaseId, detail: migration.id },
  );
}

/**
 * Applies the pending migrations on the session holding the lock, then advances schema_version (CAS).
 * `verify` checks every held lock and cancellation before each write.
 */
export async function applyChain(m: Management, p: Placement, session: SessionConnection, verify: Verify, report: MigrationReport) {
  const context: ChainContext = { m, placement: p, session, verify, report };
  const ledger = qualified(p.schemaName, "_migrations");
  await verify();
  await session.exec(createLedger(ledger));
  const pending = await readPending(session, p.schemaName);
  const applied = await each({ context, items: pending, key: "migration", direction: "up", work: (migration) => applyMigration(context, ledger, migration) });
  await verify();
  return { placement: await m.platform.setSchemaVersion(p, tenantMigrations.length), applied };
}

/** A single rollback: DROP INDEX CONCURRENTLY runs outside a transaction; a retry after a completed drop only deletes the ledger row. */
function rollbackMigration({ placement: p, session, verify }: ChainContext, ledger: string, migration: Migration) {
  return runStep(session, !!migration.concurrentDrop, async (db) => {
    const drop = !migration.concurrentDrop || (await indexState(session, p.schemaName, migration.concurrentDrop));
    if (drop) await execute(db, (migration.down as NonNullable<Migration["down"]>).bind(p.schemaName), verify);
    await verify();
    await db.query(`DELETE FROM ${ledger} WHERE id=$1`, [migration.id]);
  });
}

/**
 * Runs the down sections from newest to oldest; each ledger row is deleted together with its own down DDL. schema_version drops to the last applied
 * count before any DDL; a half-finished rollback is never skipped by migrate-all.
 */
export async function rollbackChain(
  m: Management,
  p: Placement,
  session: SessionConnection,
  verify: Verify,
  report: MigrationReport,
  target: RollbackTarget,
) {
  const ledger = qualified(p.schemaName, "_migrations");
  await verify();
  const applied = tenantMigrations.length - (await readPending(session, p.schemaName)).length;
  const targets = rollbackTargets(tenantMigrations.slice(0, applied), target);
  await verify();
  const placement = await m.platform.setSchemaVersion(p, applied - targets.length);
  const context: ChainContext = { m, placement: p, session, verify, report };
  const rolledBack = await each({ context, items: targets, key: "migration", direction: "down", work: (migration) => rollbackMigration(context, ledger, migration) });
  return { placement, rolledBack };
}

/** Columns (`table.column`) and enums (`type name`) that the folded DDL defines but the live schema lacks. */
async function missingSchemaObjects(session: Connection, schema: string, expected: ReturnType<typeof foldTables>) {
  const rows = await session.query<{ name: string }>(
    "SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema=$1 UNION ALL SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype='e'",
    [schema],
  );
  const live = new Set(rows.map((row) => row.name));
  return [
    ...[...expected.tables].flatMap(([table, columns]) => columns.map((column) => `${table}.${column.name}`)),
    ...[...expected.enums.keys()].map((name) => `type ${name}`),
  ].filter((name) => !live.has(name));
}

/**
 * Baseline: records the pending migrations up to `migrationId` without running them; only if the live schema contains every table,
 * column and enum that the folded DDLs define.
 */
export async function markChain(m: Management, p: Placement, session: SessionConnection, verify: Verify, migrationId: string) {
  const ledger = qualified(p.schemaName, "_migrations");
  await verify();
  await session.exec(createLedger(ledger));
  const pending = await readPending(session, p.schemaName);
  const marked = pending.slice(0, pending.findIndex((migration) => migration.id === migrationId) + 1);
  if (!marked.length) throw new AppError("MIGRATION_NOT_PENDING", `${migrationId} is not a pending migration`);
  const applied = tenantMigrations.length - pending.length + marked.length;
  const expected = foldTables(tenantMigrations.slice(0, applied).flatMap((migration) => migration.up.statements));
  const missing = await missingSchemaObjects(session, p.schemaName, expected);
  if (missing.length) throw new AppError("SCHEMA_MISMATCH", `Live schema lacks ${missing.slice(0, 20).join(", ")}; baseline refused`);
  await session.transaction(async (tx) => {
    for (const migration of marked) {
      await verify();
      await tx.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
    }
  });
  await verify();
  return { placement: await m.platform.setSchemaVersion(p, applied), marked: marked.map((migration) => migration.id) };
}

/** Read-only: the profile's pending seeds (all of them if there is no ledger); a modified or unknown applied seed gives `SEED_DRIFT`. */
export const pendingSeeds = (db: Connection, schema: string, profile: SeedProfile) =>
  pendingIn(db, qualified(schema, "_seeds"), seeds[profile], { code: "SEED_DRIFT", profile, missingOk: true });

/** A single seed and its ledger row, in its own transaction. */
function applySeed({ m, placement: p, session, verify }: ChainContext, ledger: string, profile: SeedProfile, seed: Seed) {
  const target = { tenantId: p.tenantId, databaseId: p.databaseId, schema: p.schemaName };
  return m.span(
    "seed",
    () =>
      session.transaction(async (tx) => {
        await seed.run(tx, target, verify);
        await verify();
        await tx.query(`INSERT INTO ${ledger} (id,profile,checksum) VALUES ($1,$2,$3)`, [seed.id, profile, seed.checksum]);
      }),
    { tenantId: p.tenantId, databaseId: p.databaseId, detail: seed.id },
  );
}

/** Migrations must be up to date. Each seed and its ledger row are committed in their own transaction; an applied seed does not run again. */
export async function applySeeds(
  m: Management,
  p: Placement,
  session: SessionConnection,
  verify: Verify,
  report: MigrationReport,
  profile: SeedProfile,
) {
  const ledger = qualified(p.schemaName, "_seeds");
  if ((await pendingAt(m, p)).length) throw new AppError("MIGRATIONS_PENDING", "Seeds need current migrations; run migrate first");
  await verify();
  await session.exec(createLedger(ledger, "profile text NOT NULL,"));
  const context: ChainContext = { m, placement: p, session, verify, report };
  const items = await pendingSeeds(session, p.schemaName, profile);
  return each({ context, items, key: "seed", direction: profile, work: (seed) => applySeed(context, ledger, profile, seed) });
}
