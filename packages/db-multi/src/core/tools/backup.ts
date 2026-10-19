/** Incremental backup, tenant export and restore. Driver-independent (no pg_dump needed): data is stored as `row_to_json` rows
 * in gzipped JSON Lines, the schema as the exact shape read from the catalog (same rules as the move tool, `copy.ts`).
 *
 *   <root>/<setId>/manifest.json                   set: full or not, base set, tenant → the set holding its data and change marker
 *   <root>/<setId>/tenants/<tenant>/tenant.json    shape, server facts, placement info, table files and row counts
 *   <root>/<setId>/tenants/<tenant>/<n>.jsonl.gz   table rows
 *   <root>/<setId>/platform/<table>.jsonl.gz       platform records (tenants, placements, nodes, reserved_tenant_ids)
 *
 * Incremental: unless `--full` is given, the last completed set becomes the base; a tenant whose change marker (table file identity, insert/update/delete
 * counters, sequence values, statistics reset and server start time) stays the same is not rewritten, and the manifest
 * points at the directory in the earlier set. Because PostgreSQL counters are written up to 10 seconds late from idle connections, in an incremental
 * set the markers are read after waiting that long: every write committed before the set started is reflected in the marker. Tenants on
 * a database with `track_counts` off or older than PostgreSQL 15 are rewritten in every set. */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { boundedInteger, MIGRATION_MAX } from "../config";
import { stopwatch } from "../database";
import type { Connection } from "../driver";
import { AppError, errorCode, parseDatabaseValue } from "../errors";
import type { Management } from "../management";
import { type MigrationReport, noReport } from "../migrations/batch";
import { tenantMigrations } from "../migrations/registry";
import { applyChain } from "../migrations/schema";
import { migrationPrefix } from "../migrations/source";
import { claimPlacement, pickDatabase, reread, withTenantSession } from "../operations/provision";
import type { TenantFields } from "../tenants/fields";
import { type Kind, type Placement, placementColumns, placementSchema, qualified, quoteIdentifier, requireActive, validateTenantId } from "../tenants/model";
import { checkDatabases } from "../tenants/nodes";
import { assertCompatible, buildSchema, insertRows, readRows, readSchema, type SchemaShape, type ServerFacts, serverFacts, snapshotTransaction } from "./copy";
import { batches, openGzipWriter, readLines } from "./jsonl";
import { openReplicaSource, type ReplicaSource } from "./replica-source";

const FORMAT = 1;
const RESTORE_BATCH_ROWS = 500;
/** Statement timeout for a single-tenant backup/restore. */
const TENANT_TRANSFER_TIMEOUT_MS = 60 * 60 * 1000;
const PLATFORM_TABLES = ["tenants", "placements", "nodes", "reserved_tenant_ids"];
const SET_ID = /^\d{14}$/;
/** Total attempts (using the following seconds) if a set already exists for the same second. */
const SET_CLAIM_ATTEMPTS = 3;
/** PostgreSQL's idle-connection statistics write interval (10 s) + margin. */
const STATS_FLUSH_MS = 11_000;

type TableFile = { name: string; file: string; rows: number };
/** `tenant.json` */
export type TenantBackup = {
  format: number;
  tenantId: string;
  kind: Kind;
  size: number;
  schemaName: string;
  databaseId: string;
  takenAt: string;
  facts: ServerFacts;
  shape: SchemaShape;
  tables: TableFile[];
  /** The `platform.tenants` row at the time it was taken (including application columns); absent in backups taken before this field existed. */
  tenant?: Record<string, unknown>;
  /** If the data was read from a replica: the source and the replay position caught up to before the tenant was read. */
  source?: "replica";
  replayLsn?: string;
};
type TenantEntry = { set: string; databaseId: string; marker: string; rows: number };
export type BackupManifest = {
  format: number;
  id: string;
  full: boolean;
  base: string | null;
  startedAt: string;
  finishedAt: string;
  tenants: Record<string, TenantEntry>;
  failed: Record<string, string>;
  /** Set taken from a replica: always full; database ID → replay position when the set started (the tenant's position is in `tenant.json`). */
  source?: "replica";
  replayLsn?: Record<string, string>;
};
/** `tenants`: only these active tenants (comma-separated CLI list); all if omitted. */
/** `replicaUrls`: `db0=url,…` direct replica URLs; if given, tenant data is read from the replica (always a full backup). */
export type BackupOptions = { full?: boolean; tenants?: readonly string[]; concurrency?: number; signal?: AbortSignal; report?: MigrationReport; replicaUrls?: string };

const exists = (path: string) => stat(path).then(() => true, () => false);
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
const totalRows = (tables: readonly TableFile[]) => tables.reduce((n, t) => n + t.rows, 0);
const tableBatches = (file: string) => batches(readLines(file), RESTORE_BATCH_ROWS);

/** Change marker for a tenant schema; read before the snapshot (if the change is late there is an extra write, never a skip). */
const MARKER = `SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(r,'|' ORDER BY r),''))
  ||':'||COALESCE((SELECT stats_reset::text FROM pg_catalog.pg_stat_database WHERE datname=pg_catalog.current_database()),'')
  ||':'||pg_catalog.pg_postmaster_start_time()::text AS marker
  FROM (SELECT c.relname||','||c.relfilenode||','||c.relnatts||','||COALESCE(s.n_tup_ins,0)||','||COALESCE(s.n_tup_upd,0)||','||COALESCE(s.n_tup_del,0) AS r
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid=c.oid
      WHERE n.nspname=$1 AND c.relkind='r'
    UNION ALL SELECT 'seq:'||sequencename||','||COALESCE(last_value::text,'') FROM pg_catalog.pg_sequences WHERE schemaname=$1) x`;

async function tenantMarker(m: Management, p: Placement) {
  const [row] = await m.pools.node(p.databaseId).query<{ marker: string }>(MARKER, [p.schemaName]);
  return `${p.databaseId}:${p.kind}:${p.placementVersion}:${row?.marker ?? ""}`;
}

/** Writes the rows to a gzipped JSON Lines file; returns the row count. */
async function writeTable(from: Connection, relation: string, file: string, signal?: AbortSignal) {
  const writer = openGzipWriter(file);
  try {
    return await readRows(from, relation, (rows) => writer.write(rows.join("\n")), signal);
  } finally {
    await writer.close();
  }
}

/** Writes a single tenant to the `dir` directory (first as `.partial`, renamed when done); `dir` must not exist. */
async function writeTenant(m: Management, p: Placement, dir: string, signal?: AbortSignal, replica?: ReplicaSource): Promise<TenantBackup> {
  if (replica && !replica.has(p.databaseId)) throw new AppError("INVALID_CONFIG", `--from-replica has no replica URL for ${p.databaseId}`);
  // Before each tenant the replica catches up to the primary's current position: the placement/schema read exist on the replica and `replayLsn` defines this tenant's data.
  const replayLsn = replica ? await replica.catchUp(p.databaseId) : undefined;
  if (await exists(dir)) throw new AppError("BACKUP_EXISTS", `${dir} already exists`);
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  // Data is read from the replica; the placement and platform records are always read from the primary.
  const db = replica ? replica.node(p.databaseId) : m.pools.node(p.databaseId);
  const [facts, [placement], [tenant]] = await Promise.all([
    serverFacts(db),
    m.pools.platform.query<{ size: number }>("SELECT size FROM platform.placements WHERE tenant_id=$1", [p.tenantId]),
    m.pools.platform.query<{ row: string }>("SELECT pg_catalog.row_to_json(t)::text AS row FROM platform.tenants t WHERE t.tenant_id=$1", [p.tenantId]),
  ]);
  const backup = await db.transaction(async (tx): Promise<TenantBackup> => {
    const shape = await readSchema(tx, p.schemaName);
    const tables: TableFile[] = [];
    for (const [i, table] of shape.tables.entries()) {
      const file = `${i}.jsonl.gz`;
      tables.push({ name: table.name, file, rows: await writeTable(tx, qualified(p.schemaName, table.name), join(partial, file), signal) });
    }
    const { tenantId, kind, schemaName, databaseId } = p;
    const row = tenant && (JSON.parse(tenant.row) as Record<string, unknown>);
    return { format: FORMAT, tenantId, kind, size: placement?.size ?? 1, schemaName, databaseId, takenAt: new Date().toISOString(), facts, shape, tables, tenant: row, ...(replica ? { source: "replica" as const, replayLsn } : {}) };
  }, snapshotTransaction(TENANT_TRANSFER_TIMEOUT_MS));
  await writeFile(join(partial, "tenant.json"), JSON.stringify(backup));
  await rename(partial, dir);
  return backup;
}

/** All data of a single tenant at once: `dir/tenant.json` + table files (consistent snapshot). Restored with `restore`. */
export async function exportTenant(m: Management, tenantId: string, dir: string, options: { signal?: AbortSignal; replicaUrls?: string } = {}) {
  const placement = requireActive(await m.platform.get(tenantId), "Only active tenants can be exported");
  const replica = options.replicaUrls ? await openReplicaSource(m, options.replicaUrls) : undefined;
  try {
    const backup = await writeTenant(m, placement, dir, options.signal, replica);
    return { tenantId, dir, tables: backup.tables.length, rows: totalRows(backup.tables) };
  } finally {
    await replica?.close();
  }
}

/** Completed sets under `<root>` (manifest written), oldest to newest. */
async function completeSets(root: string) {
  const names = (await readdir(root).catch(() => [] as string[])).filter((name) => SET_ID.test(name)).sort();
  const sets: BackupManifest[] = [];
  for (const name of names) if (await exists(join(root, name, "manifest.json"))) sets.push(await readJson<BackupManifest>(join(root, name, "manifest.json")));
  return sets;
}

/** Creates the directory atomically; `false` if it already exists. */
const createDirectory = (path: string) =>
  mkdir(path).then(
    () => true,
    (error) => {
      if (errorCode(error) !== "EEXIST") throw error;
      return false;
    },
  );

/** Set IDs have one-second resolution: the directory is created atomically, and if a set for that second exists the next second is tried (back-to-back backups). */
async function claimSetDirectory(root: string, signal?: AbortSignal) {
  await mkdir(root, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const startedAt = new Date();
    const id = migrationPrefix(startedAt);
    if (await createDirectory(join(root, id))) return { id, startedAt };
    if (attempt === SET_CLAIM_ATTEMPTS) throw new AppError("BACKUP_EXISTS", `Backup set ${id} already exists; retry in a second`);
    await sleep(1005 - (Date.now() % 1000), undefined, { signal });
  }
}

/** Platform records in a single snapshot. */
async function writePlatformSnapshot(m: Management, setDir: string, signal?: AbortSignal) {
  await mkdir(join(setDir, "platform"));
  await m.pools.platform.transaction(async (tx) => {
    for (const table of PLATFORM_TABLES)
      await writeTable(tx, `${quoteIdentifier("platform")}.${quoteIdentifier(table)}`, join(setDir, "platform", `${table}.jsonl.gz`), signal);
  }, snapshotTransaction(TENANT_TRANSFER_TIMEOUT_MS));
}

/** Active placements in tenant ID order; only those if `tenants` is given. */
async function listActivePlacements(m: Management, tenants?: readonly string[]) {
  const only = tenants && JSON.stringify(tenants.map(validateTenantId));
  const rows = await m.pools.platform.query(
    `SELECT ${placementColumns} FROM platform.placements p WHERE p.status='active' AND ($1::text IS NULL OR p.tenant_id IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))) ORDER BY p.tenant_id COLLATE "C"`,
    [only ?? null],
  );
  return rows.map((row) => parseDatabaseValue(placementSchema, row));
}

/** The marker relies on counters: databases that keep counters (track_counts on, PostgreSQL 15+). Tenants on the others are written in every set. */
async function databasesWithStatsCounters(m: Management) {
  const counted = new Set<string>();
  for (const node of m.config.nodes) {
    const [row] = await m.pools
      .node(node.id)
      .query<{ ok: boolean }>("SELECT current_setting('track_counts')::boolean AND current_setting('server_version_num')::int>=150000 AS ok");
    if (row?.ok) counted.add(node.id);
  }
  return counted;
}

type BackupRun = {
  manifest: BackupManifest;
  setDir: string;
  base?: BackupManifest;
  counted: ReadonlySet<string>;
  report: MigrationReport;
  signal?: AbortSignal;
  source?: ReplicaSource;
};

/** Single tenant: if the marker equals the base's, carries over the earlier record, otherwise writes. Errors are written to `failed` (except cancellation). */
async function backupOneTenant(m: Management, p: Placement, run: BackupRun) {
  const { manifest } = run;
  const event = { tenantId: p.tenantId, databaseId: p.databaseId };
  const elapsed = stopwatch();
  const emitSpan = (detail: string) => m.emit({ name: "backup.tenant", ms: elapsed(), ...event, detail });
  try {
    const marker = run.counted.has(p.databaseId) ? await tenantMarker(m, p) : `uncounted:${crypto.randomUUID()}`;
    const previous = run.base?.tenants[p.tenantId];
    if (previous && previous.marker === marker) {
      manifest.tenants[p.tenantId] = previous;
      run.report({ ...event, status: "unchanged", set: previous.set });
      emitSpan("unchanged");
      return;
    }
    const backup = await writeTenant(m, p, join(run.setDir, "tenants", p.tenantId), run.signal, run.source);
    const rows = totalRows(backup.tables);
    manifest.tenants[p.tenantId] = { set: manifest.id, databaseId: p.databaseId, marker, rows };
    run.report({ ...event, status: "written", rows });
    emitSpan("written");
  } catch (error) {
    if (run.signal?.aborted) throw error;
    manifest.failed[p.tenantId] = errorCode(error);
    run.report({ ...event, status: "failed", error: errorCode(error) });
  }
}

/**
 * Backup of all active tenants: the new set is `<root>/<UTC yyyyMMddHHmmss>`. Incremental (default): the last set becomes the base, an unchanged
 * tenant is not rewritten. A per-tenant error is written to the set as `failed` and the others continue. All databases must be ready.
 */
export async function backupAll(m: Management, root: string, options: BackupOptions = {}) {
  boundedInteger(options.concurrency ?? 2, "concurrency", MIGRATION_MAX.concurrency);
  await checkDatabases(m.pools, m.config.nodes.map((node) => node.id));
  const replica = options.replicaUrls ? await openReplicaSource(m, options.replicaUrls) : undefined;
  try {
    return await backupSet(m, root, options, replica);
  } finally {
    await replica?.close();
  }
}

/** If `replica` is given the set is always full (the incremental marker relies on `pg_stat_user_tables` counters that are not replicated): no base,
 * every tenant is rewritten and the manifest carries `source: "replica"` and the replay positions. */
async function backupSet(m: Management, root: string, options: BackupOptions, replica: ReplicaSource | undefined) {
  const concurrency = boundedInteger(options.concurrency ?? 2, "concurrency", MIGRATION_MAX.concurrency);
  const { signal } = options;
  const base = options.full || replica ? undefined : (await completeSets(root)).at(-1);
  const { id, startedAt } = await claimSetDirectory(root, signal);
  const setDir = join(root, id);
  await mkdir(join(setDir, "tenants"));
  await writePlatformSnapshot(m, setDir, signal);

  const placements = await listActivePlacements(m, options.tenants);
  const databaseIds = [...new Set(placements.map((p) => p.databaseId))];
  if (replica)
    for (const databaseId of databaseIds)
      if (!replica.has(databaseId)) {
        await rm(setDir, { recursive: true, force: true });
        throw new AppError("INVALID_CONFIG", `--from-replica has no replica URL for ${databaseId}`);
      }
  const counted = replica ? new Set<string>() : await databasesWithStatsCounters(m);
  if (base) await sleep(STATS_FLUSH_MS, undefined, { signal });
  const manifest: BackupManifest = {
    format: FORMAT,
    id,
    full: !base,
    base: base?.id ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    tenants: {},
    failed: {},
    ...(replica ? { source: "replica" as const, replayLsn: Object.fromEntries(databaseIds.map((databaseId) => [databaseId, replica.replayLsn(databaseId)])) } : {}),
  };
  const run: BackupRun = { manifest, setDir, base, counted, report: options.report ?? noReport, signal, source: replica };
  let next = 0;
  const lane = async () => {
    for (let p = placements[next++]; p; p = placements[next++]) {
      signal?.throwIfAborted();
      await backupOneTenant(m, p, run);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, placements.length || 1) }, lane));
  manifest.finishedAt = new Date().toISOString();
  await writeFile(join(setDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  const written = Object.values(manifest.tenants).filter((entry) => entry.set === id).length;
  return { id, dir: setDir, full: manifest.full, base: manifest.base, tenants: placements.length, written, unchanged: Object.keys(manifest.tenants).length - written, failed: Object.keys(manifest.failed).length };
}

/** Tenant directory; for a backup root, additionally the platform records directory of the selected set. */
type LocatedTenant = { dir: string; platformDir?: string };

/** `source`: an `export` directory (contains `tenant.json`) or a backup root (the last set, or `set`). */
async function locateTenant(source: string, tenantId: string, set?: string): Promise<LocatedTenant> {
  if (await exists(join(source, "tenant.json"))) return { dir: source };
  const sets = await completeSets(source);
  const manifest = set === undefined ? sets.at(-1) : sets.find((s) => s.id === set);
  if (!manifest) throw new AppError("BACKUP_NOT_FOUND", set ? `Backup set ${set} is missing or incomplete` : "No complete backup set found");
  const entry = manifest.tenants[tenantId];
  if (!entry) throw new AppError("BACKUP_NOT_FOUND", `Tenant ${tenantId} is not in backup set ${manifest.id}`);
  return { dir: join(source, entry.set, "tenants", tenantId), platformDir: join(source, manifest.id, "platform") };
}

/** The `platform.tenants` row to restore: the platform record of the set selected in the backup root (the values at the set's moment even if the tenant's data
 * stayed in an older set), otherwise the row in `tenant.json`; empty if neither exists (old backup). */
async function storedTenantRow(located: LocatedTenant, backup: TenantBackup): Promise<Record<string, unknown>> {
  const file = located.platformDir && join(located.platformDir, "tenants.jsonl.gz");
  let found: Record<string, unknown> | undefined;
  if (file && (await exists(file)))
    for await (const rows of tableBatches(file))
      for (const text of rows) {
        const row = JSON.parse(text) as Record<string, unknown>;
        if (row.tenant_id === backup.tenantId) found = row;
      }
  return found ?? backup.tenant ?? {};
}

/** `tenant`: application fields that overwrite the values in the backup (same rules as `provisionTenant`); for required columns in an old backup. */
export type RestoreOptions = { set?: string; databaseId?: string; size?: number; tenant?: TenantFields; signal?: AbortSignal; report?: MigrationReport };

/** The backup row's columns that can be written on the target, with the validated `tenant` fields on top. */
async function restoredTenant(m: Management, located: LocatedTenant, backup: TenantBackup, fields: TenantFields | undefined) {
  const { row, skipped } = await m.platform.restoredTenant(await storedTenantRow(located, backup));
  return { tenant: { ...row, ...(await m.platform.tenantFields(fields)) }, skipped };
}

/** Loads the table's backup rows in batches (ownership is verified before each batch) and checks the row count. */
async function restoreTableRows(
  tx: Connection,
  from: { dir: string; backup: TenantBackup; verify: () => Promise<void> },
  relation: string,
  stored: string[],
  table: string,
) {
  const file = from.backup.tables.find((t) => t.name === table);
  if (!file) throw new AppError("BACKUP_INVALID", `Backup has no rows file for ${table}`);
  for await (const rows of tableBatches(join(from.dir, file.file))) {
    await from.verify();
    await insertRows(tx, relation, stored, rows);
  }
  const [count] = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${relation}`);
  if (count?.n !== file.rows) throw new AppError("RESTORE_MISMATCH", `${table}: expected ${file.rows} rows, restored ${count?.n}`);
}

/**
 * Builds a deleted or never-existing tenant from a backup: reserved name, database readiness, schema uniqueness across all databases and placement choice
 * are the same as provision. Schema and data are built in a single transaction (if interrupted nothing is left, it can be retried), row
 * counts are verified; if the backup is at an older migration version the pending migrations are applied, then `active`. It does not overwrite
 * an existing active tenant (`TENANT_EXISTS`). The `platform.tenants` row is built with all the columns from the backup; columns missing on the target
 * are returned as `skippedTenantColumns`.
 */
export async function restoreTenant(m: Management, tenantId: string, source: string, options: RestoreOptions = {}) {
  validateTenantId(tenantId);
  const located = await locateTenant(source, tenantId, options.set);
  const { dir } = located;
  const backup = await readJson<TenantBackup>(join(dir, "tenant.json"));
  if (backup.format !== FORMAT || backup.tenantId !== tenantId) throw new AppError("BACKUP_INVALID", "Backup format or tenant id does not match");
  await assertLedgerKnown(dir, backup);
  const { tenant, skipped } = await restoredTenant(m, located, backup, options.tenant);
  const size = options.size ?? backup.size;
  let target = "";
  const pick = async () => (target = await pickDatabase(m, tenantId, options.databaseId, backup.kind, size));
  return withTenantSession(m, tenantId, pick, options, async (db, verify, assertOwned) => {
    const p = await reread(m, await claimPlacement(m, tenantId, target, backup.kind, size, tenant));
    if (p.status === "active") throw new AppError("TENANT_EXISTS", "Tenant is active; restore only rebuilds missing tenants");
    if (!["provisioning", "failed"].includes(p.status)) throw new AppError("TENANT_UNAVAILABLE", "Tenant has another operation");
    assertCompatible(backup.facts, await serverFacts(db));
    await verify();
    await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL statement_timeout = ${TENANT_TRANSFER_TIMEOUT_MS}`);
      const from = { dir, backup, verify };
      await buildSchema(tx, p.schemaName, backup.shape, (relation, stored, table) => restoreTableRows(tx, from, relation, stored, table), options.signal);
    });
    const { placement, applied } = await applyChain(m, p, db, verify, options.report ?? noReport);
    await assertOwned();
    const active = await m.platform.setStatus(placement, "active");
    const skippedColumns = skipped.length ? { skippedTenantColumns: skipped } : {};
    return { placement: active, restoredFrom: dir, migrationsApplied: applied, rows: totalRows(backup.tables), ...skippedColumns };
  });
}

/** The backup's migration ledger must be a prefix of this code's migration list (a backup taken with newer code is rejected). */
async function assertLedgerKnown(dir: string, backup: TenantBackup) {
  const ledger = backup.tables.find((t) => t.name === "_migrations");
  if (!ledger) throw new AppError("BACKUP_INVALID", "Backup has no migration ledger");
  const applied = new Map<string, string>();
  for await (const rows of tableBatches(join(dir, ledger.file)))
    for (const row of rows) {
      const { id, checksum } = JSON.parse(row) as { id: string; checksum: string };
      applied.set(id, checksum);
    }
  const prefix = tenantMigrations.slice(0, applied.size);
  if (prefix.length !== applied.size || prefix.some((migration) => applied.get(migration.id) !== migration.checksum))
    throw new AppError("MIGRATION_DRIFT", "Backup migration history is not a prefix of this code's tenant migrations");
}

/** Keeps the last `keep` completed sets and the older sets they point to; deletes the other completed sets. Does not touch incomplete sets. */
export async function pruneBackups(root: string, keep: number | string) {
  const count = boundedInteger(keep, "keep", 1000);
  const sets = await completeSets(root);
  const kept = sets.slice(-count);
  const needed = new Set(kept.flatMap((s) => [s.id, ...Object.values(s.tenants).map((entry) => entry.set)]));
  const removed: string[] = [];
  for (const set of sets)
    if (!needed.has(set.id)) {
      await rm(join(root, set.id), { recursive: true, force: true });
      removed.push(set.id);
    }
  return { kept: sets.filter((s) => needed.has(s.id)).map((s) => s.id), removed };
}
