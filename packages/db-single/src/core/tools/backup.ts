/** Schema export, backup and restore. Driver-independent (pg_dump is not needed): data is stored as gzipped JSON Lines of `row_to_json` rows,
 * and the schema as the exact shape read from the catalog (rules in `copy.ts`).
 *
 *   <folder>/backup.json     shape, server facts, table files and row counts (written last: if the folder exists the backup is complete)
 *   <folder>/<n>.jsonl.gz    table rows
 *
 * `export <dir>` writes exactly that folder (first `.partial`, renamed when done; it must not exist). `backup <root>` writes a complete set
 * under `<root>/<UTC yyyyMMddHHmmss>` on every run and deletes older ones with `keep`. `restore` builds into an empty or non-existent schema. */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { schemaIsEmpty } from "../catalog";
import { boundedInteger } from "../config";
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";
import { qualified } from "../identifier";
import { MIGRATION_KEY, openManagementSession, WATCHDOG_GRACE_MS } from "../locks";
import type { Management } from "../management";
import { registry as packageRegistry, type Registry } from "../migrations/registry";
import { createRunner, noReport, type Report } from "../migrations/runner";
import { migrationPrefix } from "../migrations/source";
import { assertCompatible, buildSchema, insertRows, readRows, readSchema, type SchemaShape, type ServerFacts, serverFacts, snapshotTransaction } from "./copy";
import { batches, openGzipWriter, readLines } from "./jsonl";
import { openReplicaSource, type ReplicaSource } from "./replica-source";

/** 2: the shape carries `enums`. 1 (an older backup without enums) is also read. */
const FORMAT = 2;
const RESTORE_BATCH_ROWS = 500;
/** Statement timeout for a single backup/restore. */
const TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;
const SET_ID = /^\d{14}$/;
/** Total attempts, using following seconds, if a set already exists for the same second. */
const SET_CLAIM_ATTEMPTS = 3;

type TableFile = { name: string; file: string; rows: number };
/** `backup.json` */
export type BackupMeta = {
  format: number;
  schema: string;
  takenAt: string;
  facts: ServerFacts;
  shape: SchemaShape;
  tables: TableFile[];
  /** If the data was read from a replica: the source and the replay position caught up to before the data was read. */
  source?: "replica";
  replayLsn?: string;
};

const exists = (path: string) => stat(path).then(() => true, () => false);
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
const totalRows = (tables: readonly TableFile[]) => tables.reduce((n, t) => n + t.rows, 0);
const tableBatches = (file: string) => batches(readLines(file), RESTORE_BATCH_ROWS);

/** Writes the rows to a gzipped JSON Lines file; returns the row count. */
async function writeTable(from: Connection, relation: string, file: string, signal?: AbortSignal) {
  const writer = openGzipWriter(file);
  try {
    return await readRows(from, relation, (rows) => writer.write(rows.join("\n")), signal);
  } finally {
    await writer.close();
  }
}

const taken = () => new AppError("BACKUP_EXISTS", "The target folder already exists");
const writing = () => new AppError("BACKUP_EXISTS", "Another run is writing the target folder (remove its .partial folder if no run is active)");
/** fs `EEXIST`/`ENOTEMPTY`: the folder exists (`error()`). */
const claimFailed = (error: () => AppError) => (cause: unknown) => {
  throw ["EEXIST", "ENOTEMPTY"].includes(errorCode(cause)) ? error() : cause;
};
/** A trailing `/` does not change the target: `.partial` is written next to the target, not inside it. */
const partialOf = (dir: string) => `${resolve(dir)}.partial`;

/** `BACKUP_EXISTS` if the target folder or its leftover `.partial` trace exists: called before starting side-effecting work (e.g. a Neon branch). */
export async function assertFree(dir: string) {
  if (await exists(dir)) throw taken();
  if (await exists(partialOf(dir))) throw writing();
}

/** Writes the schema to the `dir` folder (first `.partial`, renamed when done); on error `.partial` is deleted, and `dir` must not exist.
 * `.partial` is claimed for this run only with a non-recursive `mkdir`: a second run to the same target does not delete someone else's folder,
 * it gets `BACKUP_EXISTS`; the rename also does not overwrite a non-empty target. */
async function writeSnapshot(m: Management, dir: string, signal?: AbortSignal, replica?: ReplicaSource): Promise<BackupMeta> {
  // The replica catches up to the primary's current position: the schema that is read exists on the replica, and `replayLsn` defines the position of this data.
  const replayLsn = replica ? await replica.catchUp() : undefined;
  if (await exists(dir)) throw taken();
  const partial = partialOf(dir);
  await mkdir(dirname(partial), { recursive: true });
  await mkdir(partial).catch(claimFailed(writing));
  try {
    const db = replica ? replica.db : m.db;
    const facts = await serverFacts(db);
    const meta = await db.transaction(async (tx): Promise<BackupMeta> => {
      const shape = await readSchema(tx, m.schema);
      const tables: TableFile[] = [];
      for (const [i, table] of shape.tables.entries()) {
        const file = `${i}.jsonl.gz`;
        tables.push({ name: table.name, file, rows: await writeTable(tx, qualified(m.schema, table.name), join(partial, file), signal) });
      }
      return { format: FORMAT, schema: m.schema, takenAt: new Date().toISOString(), facts, shape, tables, ...(replica ? { source: "replica" as const, replayLsn } : {}) };
    }, snapshotTransaction(TRANSFER_TIMEOUT_MS));
    await writeFile(join(partial, "backup.json"), JSON.stringify(meta));
    await rename(partial, resolve(dir)).catch(claimFailed(taken));
    return meta;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

/** If a replica is given, the data is read from it; the source is closed after every call. */
async function withSource<T>(m: Management, replicaUrls: string | undefined, work: (replica?: ReplicaSource) => Promise<T>) {
  const replica = replicaUrls ? await openReplicaSource(m, replicaUrls) : undefined;
  try {
    return await work(replica);
  } finally {
    await replica?.close();
  }
}

/** All of the schema's data in one go: `dir/backup.json` + table files (a consistent snapshot). Restored with `restore`. */
export async function exportSchema(m: Management, dir: string, options: { signal?: AbortSignal; replicaUrls?: string } = {}) {
  return withSource(m, options.replicaUrls, async (replica) => {
    const meta = await writeSnapshot(m, dir, options.signal, replica);
    return { dir, tables: meta.tables.length, rows: totalRows(meta.tables) };
  });
}

/** The complete sets under `<root>` (`backup.json` exists), oldest to newest. */
async function completeSets(root: string) {
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => SET_ID.test(name)).sort();
  const complete: string[] = [];
  for (const name of names) if (await exists(join(root, name, "backup.json"))) complete.push(name);
  return complete;
}

/** Every run writes a new complete set: `<root>/<UTC yyyyMMddHHmmss>`; if that second's set exists, the next second is tried (back-to-back backups). */
export async function backupSchema(m: Management, root: string, options: { keep?: number | string; signal?: AbortSignal; replicaUrls?: string; now?: () => Date } = {}) {
  const keep = options.keep === undefined ? undefined : boundedInteger(options.keep, "keep", 1000);
  const now = options.now ?? (() => new Date());
  const result = await withSource(m, options.replicaUrls, async (replica) => {
    for (let attempt = 1; ; attempt++) {
      const id = migrationPrefix(now());
      const dir = join(root, id);
      try {
        const meta = await writeSnapshot(m, dir, options.signal, replica);
        return { id, dir, tables: meta.tables.length, rows: totalRows(meta.tables) };
      } catch (error) {
        // That second's set exists or another run is writing it: the next second is tried.
        if (errorCode(error) !== "BACKUP_EXISTS" || attempt === SET_CLAIM_ATTEMPTS) throw error;
      }
      await sleep(1005 - (Date.now() % 1000), undefined, { signal: options.signal });
    }
  });
  const pruned = keep === undefined ? [] : (await pruneBackups(root, keep, result.id)).removed;
  return { ...result, pruned };
}

/** Keeps the last `keep` complete sets; deletes older complete sets. Does not touch incomplete sets or other folders. `current`
 * (the set the same run just wrote) is not deleted even if the clock was set back and it looks oldest. */
export async function pruneBackups(root: string, keep: number | string, current?: string) {
  const count = boundedInteger(keep, "keep", 1000);
  const sets = await completeSets(root);
  const removed = sets.slice(0, -count).filter((id) => id !== current);
  for (const id of removed) await rm(join(root, id), { recursive: true, force: true });
  return { kept: sets.filter((id) => !removed.includes(id)), removed };
}

/** `source`: an `export` folder (contains `backup.json`) or a backup root (the latest set, or `set`). */
async function locateBackup(source: string, set?: string): Promise<string> {
  if (await exists(join(source, "backup.json"))) return source;
  const sets = await completeSets(source);
  const id = set === undefined ? sets.at(-1) : sets.find((name) => name === set);
  if (!id) throw new AppError("BACKUP_NOT_FOUND", set ? "Backup set is missing or incomplete" : "No complete backup found");
  return join(source, id);
}

/** The backup's migration ledger must be a prefix of this code's migration list (a backup taken with newer code is rejected). */
async function assertLedgerKnown(dir: string, meta: BackupMeta, registry: Registry) {
  const ledger = meta.tables.find((table) => table.name === "_migrations");
  if (!ledger) throw new AppError("BACKUP_INVALID", "Backup has no migration ledger");
  const applied = new Map<string, string>();
  for await (const rows of tableBatches(join(dir, ledger.file)))
    for (const row of rows) {
      const { id, checksum } = JSON.parse(row) as { id: string; checksum: string };
      applied.set(id, checksum);
    }
  const prefix = registry.migrations.slice(0, applied.size);
  if (prefix.length !== applied.size || prefix.some((migration) => applied.get(migration.id) !== migration.checksum))
    throw new AppError("MIGRATION_DRIFT", "Backup migration history is not a prefix of this code's migrations");
}

/** Loads the table's backup rows in batches (ownership is verified before every batch) and checks the row count. */
async function restoreTableRows(tx: Connection, from: { dir: string; meta: BackupMeta; verify: () => Promise<void> }, relation: string, stored: string[], table: string) {
  const file = from.meta.tables.find((t) => t.name === table);
  if (!file) throw new AppError("BACKUP_INVALID", `Backup has no rows file for ${table}`);
  for await (const rows of tableBatches(join(from.dir, file.file))) {
    await from.verify();
    await insertRows(tx, relation, stored, rows);
  }
  const [count] = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${relation}`);
  if (count?.n !== file.rows) throw new AppError("RESTORE_MISMATCH", `${table}: expected ${file.rows} rows, restored ${count?.n}`);
}

export type RestoreOptions = { set?: string; signal?: AbortSignal; report?: Report; registry?: Registry };

/**
 * Builds the schema from a backup. The target schema must not exist or must be empty (`SCHEMA_NOT_EMPTY`; nothing is deleted). Schema and data
 * are built in a single transaction (if interrupted nothing is left, and it can be retried), and row counts are verified; if the backup is at an
 * older migration version, the pending migrations are applied afterwards. A backup can also be restored under a different schema name.
 */
export async function restoreSchema(m: Management, source: string, options: RestoreOptions = {}) {
  const registry = options.registry ?? packageRegistry;
  const dir = await locateBackup(source, options.set);
  const meta = await readJson<BackupMeta>(join(dir, "backup.json"));
  if (meta.format !== FORMAT && meta.format !== 1) throw new AppError("BACKUP_INVALID", "Backup format does not match");
  await assertLedgerKnown(dir, meta, registry);
  // The watchdog must not be shorter than the transaction's hourly statement_timeout: a long CREATE INDEX / FK validation must not end in LOCK_LOST.
  const session = await openManagementSession(m, MIGRATION_KEY, { applicationName: "restore", signal: options.signal, watchdogMs: TRANSFER_TIMEOUT_MS + WATCHDOG_GRACE_MS });
  try {
    const verify = async () => {
      await session.assertOwned();
      options.signal?.throwIfAborted();
    };
    await verify();
    if (!(await schemaIsEmpty(session.db, m.schema))) throw new AppError("SCHEMA_NOT_EMPTY", "Restore needs an empty or missing schema; it never overwrites existing objects");
    assertCompatible(meta.facts, await serverFacts(session.db));
    await session.db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL statement_timeout = ${TRANSFER_TIMEOUT_MS}`);
      const from = { dir, meta, verify };
      await buildSchema(tx, m.schema, meta.shape, (relation, stored, table) => restoreTableRows(tx, from, relation, stored, table), options.signal);
    });
  } finally {
    await session.close();
  }
  const { migrations } = await createRunner(registry).migrate(m, { signal: options.signal, report: options.report ?? noReport });
  return { restoredFrom: dir, migrationsApplied: migrations, rows: totalRows(meta.tables) };
}
