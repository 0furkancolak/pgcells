/** The migration and seed chain of a single schema: forward, rollback, baseline, status. A single advisory lock prevents two simultaneous runs; every
 * step can be retried (DDL in a transaction, CONCURRENTLY index is idempotent), so there is no persistent marker or recovery command. */
import { schemaExists } from "../catalog";
import { runtimeDatabaseDefaults } from "../config";
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";
import { qualified, quoteIdentifier } from "../identifier";
import { cancelled, MIGRATION_KEY, openManagementSession, ownershipCheck } from "../locks";
import type { Management } from "../management";
import { foldTables } from "../sql/tables";
import { createLedger, type Migration, pendingIn, type Registry, type RollbackTarget, rollbackTargets, type Seed } from "./registry";

type Verify = () => Promise<void>;
/** Progress events (plain objects that can be converted to JSON); the CLI prints them. */
export type Report = (event: Record<string, unknown>) => void;
export const noReport: Report = () => {};
export interface RunOptions {
  /** Reads the ledger only; no lock, session or writes. */
  dryRun?: boolean;
  signal?: AbortSignal;
  report?: Report;
}
/** The connection of the session holding the lock: transactions use the session's own timeouts. */
type SessionConnection = Connection & { transaction<T>(work: (tx: Connection) => Promise<T>): Promise<T> };

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

/** CREATE INDEX CONCURRENTLY: a valid index on the same table with the same uniqueness is accepted, an invalid one is rebuilt, and any other is rejected. */
async function applyConcurrentIndex(db: Connection, schema: string, migration: Migration, verify: Verify) {
  const { name, table, unique } = migration.concurrentIndex as NonNullable<Migration["concurrentIndex"]>;
  const existing = await indexState(db, schema, name);
  if (existing) {
    if (existing.relation !== table || existing.is_unique !== unique) throw new AppError("MIGRATION_DRIFT", "Concurrent index definition mismatch");
    if (existing.valid) return;
    await verify();
    await db.exec(`DROP INDEX CONCURRENTLY ${qualified(schema, name)}`);
  }
  await execute(db, migration.up.bind(schema), verify);
  await verify();
  if (!(await indexState(db, schema, name))?.valid) throw new AppError("MIGRATION_INDEX_INVALID", "Concurrent index is invalid");
}

/** Runs `work` for each item; started/succeeded/failed are reported with `{ [key]: id, direction }`. Returns the completed IDs. */
async function each<T extends { id: string }>(items: readonly T[], key: "migration" | "seed", direction: string, verify: Verify, report: Report, work: (item: T) => Promise<void>) {
  const done: string[] = [];
  for (const item of items) {
    await verify();
    const start = Date.now();
    const event = { [key]: item.id, direction };
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

/** Columns (`table.column`) and enums (`type name`) that the folded DDL defines but the live schema lacks. */
async function missingSchemaObjects(db: Connection, schema: string, expected: ReturnType<typeof foldTables>) {
  const rows = await db.query<{ name: string }>(
    "SELECT table_name || '.' || column_name AS name FROM information_schema.columns WHERE table_schema=$1 UNION ALL SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype='e'",
    [schema],
  );
  const live = new Set(rows.map((row) => row.name));
  return [
    ...[...expected.tables].flatMap(([table, columns]) => columns.map((column) => `${table}.${column.name}`)),
    ...[...expected.enums.keys()].map((name) => `type ${name}`),
  ].filter((name) => !live.has(name));
}

/** Creates the schema if it does not exist (`CREATE SCHEMA` does not run when it exists: no privilege is needed for `public`); the runtime timeouts are written
 * as database defaults (new backends pick them up behind any pooler, existing ones when they reconnect). */
async function prepare(m: Management, db: Connection, verify: Verify) {
  await verify();
  if (!(await schemaExists(db, m.schema))) await db.exec(`CREATE SCHEMA ${quoteIdentifier(m.schema)}`);
  const [database] = await db.query<{ name: string }>("SELECT pg_catalog.current_database() AS name");
  for (const setting of runtimeDatabaseDefaults(m.config)) await db.exec(`ALTER DATABASE ${quoteIdentifier(database?.name ?? "")} SET ${setting.replace("=", " = ")}`);
}

/** A single migration: the DDL and the ledger row are committed together; CREATE INDEX CONCURRENTLY runs outside a transaction. */
function applyMigration(m: Management, session: SessionConnection, verify: Verify, migration: Migration) {
  const ledger = qualified(m.schema, "_migrations");
  return m.span(
    "migration",
    () =>
      runStep(session, !!migration.concurrentIndex, async (db) => {
        if (migration.concurrentIndex) await applyConcurrentIndex(session, m.schema, migration, verify);
        else await execute(db, migration.up.bind(m.schema), verify);
        await verify();
        await db.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
      }),
    { detail: migration.id },
  );
}

/** A single rollback: DROP INDEX CONCURRENTLY runs outside a transaction; a retry after a completed drop only deletes the ledger row. */
function rollbackMigration(m: Management, session: SessionConnection, verify: Verify, migration: Migration) {
  const ledger = qualified(m.schema, "_migrations");
  return m.span(
    "rollback",
    () =>
      runStep(session, !!migration.concurrentDrop, async (db) => {
        const drop = !migration.concurrentDrop || (await indexState(session, m.schema, migration.concurrentDrop));
        if (drop) await execute(db, (migration.down as NonNullable<Migration["down"]>).bind(m.schema), verify);
        await verify();
        await db.query(`DELETE FROM ${ledger} WHERE id=$1`, [migration.id]);
      }),
    { detail: migration.id },
  );
}

/** A single seed and its ledger row in their own transaction. */
function applySeed(m: Management, session: SessionConnection, verify: Verify, seed: Seed) {
  const ledger = qualified(m.schema, "_seeds");
  return m.span(
    "seed",
    () =>
      session.transaction(async (tx) => {
        await seed.run(tx, m.schema, verify);
        await verify();
        await tx.query(`INSERT INTO ${ledger} (id,checksum) VALUES ($1,$2)`, [seed.id, seed.checksum]);
      }),
    { detail: seed.id },
  );
}

/** `registry`: the application's migration and seed lists (`src/core/migrations/registry.ts`); tests pass their own list. */
export function createRunner({ migrations, seeds }: Registry) {
  const migrationsLedger = (schema: string) => qualified(schema, "_migrations");
  const seedsLedger = (schema: string) => qualified(schema, "_seeds");
  /** If the ledger does not exist, everything is pending; an unknown or changed history is `MIGRATION_DRIFT`. */
  const pendingMigrations = (db: Connection, schema: string) => pendingIn(db, migrationsLedger(schema), migrations, { missingOk: true });
  const pendingSeeds = (db: Connection, schema: string) => pendingIn(db, seedsLedger(schema), seeds, { code: "SEED_DRIFT", missingOk: true });
  const appliedMigrations = async (db: Connection, schema: string) => migrations.slice(0, migrations.length - (await pendingMigrations(db, schema)).length);

  /** Runs on the session holding the lock; losing the lock counts as an error even after success. */
  async function withLock<T>(m: Management, options: Pick<RunOptions, "signal">, work: (db: SessionConnection, verify: Verify) => Promise<T>): Promise<T> {
    if (options.signal?.aborted) throw cancelled();
    const session = await openManagementSession(m, MIGRATION_KEY, { applicationName: "migration", signal: options.signal });
    try {
      const result = await work(session.db, ownershipCheck(session.signal, session.assertOwned));
      await session.assertOwned();
      return result;
    } finally {
      await session.close();
    }
  }

  /** Pending migrations: lock, drift check, schema preparation, ledger, then in order. `dryRun` only lists the pending ones. */
  async function migrate(m: Management, options: RunOptions = {}) {
    if (options.dryRun) return { dryRun: true as const, migrations: (await pendingMigrations(m.db, m.schema)).map((migration) => migration.id) };
    return withLock(m, options, async (db, verify) => {
      const todo = await pendingMigrations(db, m.schema);
      await prepare(m, db, verify);
      await db.exec(createLedger(migrationsLedger(m.schema)));
      const applied = await each(todo, "migration", "up", verify, options.report ?? noReport, (migration) => applyMigration(m, db, verify, migration));
      return { dryRun: false as const, migrations: applied };
    });
  }

  /** The last `steps` (default 1) migrations or those after `to`, newest to oldest. Irreversible and unknown targets are rejected before any DDL. */
  async function rollback(m: Management, options: RunOptions & RollbackTarget = {}) {
    if (options.dryRun) return { dryRun: true as const, migrations: rollbackTargets(await appliedMigrations(m.db, m.schema), options).map((migration) => migration.id) };
    return withLock(m, options, async (db, verify) => {
      const targets = rollbackTargets(await appliedMigrations(db, m.schema), options);
      const done = await each(targets, "migration", "down", verify, options.report ?? noReport, (migration) => rollbackMigration(m, db, verify, migration));
      return { dryRun: false as const, migrations: done };
    });
  }

  /** Marks pending migrations up to `migrationId` as applied without running them; refuses if the live schema does not contain the folded tables, columns and enums. */
  async function baseline(m: Management, migrationId: string, options: Pick<RunOptions, "signal"> = {}) {
    return withLock(m, options, async (db, verify) => {
      await verify();
      if (!(await schemaExists(db, m.schema))) throw new AppError("SCHEMA_MISMATCH", "Schema does not exist; baseline refused");
      await db.exec(createLedger(migrationsLedger(m.schema)));
      const pending = await pendingMigrations(db, m.schema);
      const marked = pending.slice(0, pending.findIndex((migration) => migration.id === migrationId) + 1);
      if (!marked.length) throw new AppError("MIGRATION_NOT_PENDING", "The baseline target is not a pending migration");
      const applied = migrations.length - pending.length + marked.length;
      const missing = await missingSchemaObjects(db, m.schema, foldTables(migrations.slice(0, applied).flatMap((migration) => migration.up.statements)));
      if (missing.length) throw new AppError("SCHEMA_MISMATCH", `Live schema lacks ${missing.slice(0, 20).join(", ")}; baseline refused`);
      await db.transaction(async (tx) => {
        for (const migration of marked) {
          await verify();
          await tx.query(`INSERT INTO ${migrationsLedger(m.schema)} (id,checksum) VALUES ($1,$2)`, [migration.id, migration.checksum]);
        }
      });
      return { migrations: marked.map((migration) => migration.id) };
    });
  }

  /** Read-only: the applied count and the pending migrations (`transactional: false` is a CONCURRENTLY index). */
  async function migrationStatus(m: Management) {
    const pending = await pendingMigrations(m.db, m.schema);
    return {
      schema: m.schema,
      applied: migrations.length - pending.length,
      pending: pending.map(({ id, concurrentIndex }) => ({ id, transactional: !concurrentIndex })),
    };
  }

  /** Migrations must be up to date (checked under the lock on a real run). Each seed and its ledger row is committed in its own transaction;
   * an applied seed does not run again. */
  async function seed(m: Management, options: RunOptions = {}) {
    const current = async (db: Connection) => {
      if ((await pendingMigrations(db, m.schema)).length) throw new AppError("MIGRATIONS_PENDING", "Seeds need current migrations; run migrate first");
    };
    if (options.dryRun) {
      await current(m.db);
      return { dryRun: true as const, seeds: (await pendingSeeds(m.db, m.schema)).map((item) => item.id) };
    }
    return withLock(m, options, async (db, verify) => {
      await current(db);
      await verify();
      await db.exec(createLedger(seedsLedger(m.schema)));
      const todo = await pendingSeeds(db, m.schema);
      const done = await each(todo, "seed", "up", verify, options.report ?? noReport, (item) => applySeed(m, db, verify, item));
      return { dryRun: false as const, seeds: done };
    });
  }

  return { migrate, rollback, baseline, migrationStatus, seed };
}
