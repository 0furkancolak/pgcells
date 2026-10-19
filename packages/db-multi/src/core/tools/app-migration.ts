/** Data transfer from another application into this one: a module written with `defineAppMigration` (`src/app-migrations/legacy2app.ts`)
 * returns a function: `legacy2app(m, tenantId, "backup.sql" | chunk directory, { dryRun })`.
 *
 * - Steps run in order. The `users` step turns a row into `ImportedUser` and uses `importUsers` (mapping, email conflicts,
 *   password hashes live there). The `into` + `map` step writes the row to a tenant table; `map` returns null (skip), an object or an array of objects.
 * - Re-running is safe: `ctx.uuid(table, oldId)` produces a deterministic UUID from the source, table and old ID, and writes use
 *   `ON CONFLICT DO NOTHING`. Old user ID → new user: `ctx.userId(oldId)`.
 * - Each batch is one transaction; if `map` returns a column that is not in the target table, the transfer stops (`IMPORT_INVALID`). */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedInteger } from "../config";
import type { Database } from "../database";
import { AppError } from "../errors";
import type { Management } from "../management";
import type { MigrationReport } from "../migrations/batch";
import { qualified, quoteIdentifier, requireActive } from "../tenants/model";
import { type ImportedUser, importUsers, jsonLinesSource } from "./import-users";
import { readAnalysis, splitSqlDump } from "./sql-dump";

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10000;

type Json = Record<string, unknown>;
export type AppMigrationContext = {
  readonly tenantId: string;
  readonly source: string;
  /** Deterministic UUID from the source, table and old ID (the same input gives the same ID on every run). */
  uuid(table: string, externalId: unknown): string;
  /** New user ID of an old user ID transferred in the `users` step; `null` if there is none. */
  userId(externalId: unknown): string | null;
};
type UsersStep<Row> = { table: string; users: (row: Row, ctx: AppMigrationContext) => ImportedUser | null; onConflict?: "skip" | "link" | "fail" };
type TableStep<Row> = { table: string; into: string; map: (row: Row, ctx: AppMigrationContext) => Json | Json[] | null };
type StepFor<Row> = UsersStep<Row> | TableStep<Row>;
export type AppMigrationStep<Rows extends Record<string, Json>> = { [T in keyof Rows & string]: StepFor<Rows[T]> & { table: T } }[keyof Rows & string];
export type AppMigrationDefinition<Rows extends Record<string, Json>> = { source: string; steps: AppMigrationStep<Rows>[] };
export type AppMigrationOptions = { authRuntime?: "bun" | "workers"; dryRun?: boolean; batchSize?: number; signal?: AbortSignal; report?: MigrationReport };
export type AppMigrationResult = { tenantId: string; source: string; dryRun: boolean; steps: { table: string; read: number; skipped: number; written: number; result?: unknown }[] };
export type AppMigration = ((m: Management, tenantId: string, input: string, options?: AppMigrationOptions) => Promise<AppMigrationResult>) & {
  readonly definition: AppMigrationDefinition<Record<string, Json>>;
};
type StepSummary = AppMigrationResult["steps"][number];

/** Context shared between steps within one run. */
type StepRun = {
  m: Management;
  node: Pick<Database, "query">;
  schemaName: string;
  ctx: AppMigrationContext;
  options: AppMigrationOptions;
  batchSize: number;
  /** The step's source rows (no rows at all if the table is empty). */
  rows: () => AsyncIterable<unknown> | Iterable<unknown>;
  summary: StepSummary;
};

/** UUID in RFC 4122 v5 format (SHA-1). */
const uuidFor = (source: string, table: string, externalId: unknown) => {
  const hex = createHash("sha1").update(`${source}\0${table}\0${String(externalId)}`).digest("hex");
  const variant = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export function defineAppMigration<Rows extends Record<string, Json>>(definition: AppMigrationDefinition<Rows>): AppMigration {
  const run = (m: Management, tenantId: string, input: string, options: AppMigrationOptions = {}) =>
    runAppMigration(m, tenantId, input, definition as unknown as AppMigrationDefinition<Record<string, Json>>, options);
  return Object.assign(run, { definition: definition as unknown as AppMigrationDefinition<Record<string, Json>> });
}

/** Splits a `.sql`/`.sql.gz` file into a temporary directory and runs `fn` with that directory; the directory is deleted in every case. */
async function withSplitDump<T>(input: string, signal: AbortSignal | undefined, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "app-migration-"));
  try {
    await splitSqlDump(input, dir, { signal });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Column names of the target table. If the table does not exist the `regclass` cast fails; the error is deliberately turned into an empty set so the caller
 * raises a clear `IMPORT_INVALID` ("Tenant has no table …") instead of a database error. */
async function tableColumns(node: Pick<Database, "query">, target: string) {
  const rows = await node
    .query<{ name: string }>("SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid=$1::text::regclass AND attnum>0 AND NOT attisdropped", [target])
    .catch(() => [] as { name: string }[]);
  return new Set(rows.map((row) => row.name));
}

/** `users` step: passes the rows to `importUsers`; returns the old ID → user mapping for the later steps' `ctx.userId`. */
async function runUsersStep(run: StepRun, step: UsersStep<Json>) {
  const { m, ctx, summary } = run;
  async function* users() {
    for await (const row of run.rows()) {
      summary.read++;
      const user = step.users(row as Json, ctx);
      if (user) yield user;
      else summary.skipped++;
    }
  }
  const imported = await importUsers(m, ctx.tenantId, users(), { ...run.options, batchSize: run.batchSize, source: ctx.source, onConflict: step.onConflict });
  summary.written = imported.created + imported.updated + imported.linked;
  summary.result = imported;
  // The mapping is read from the DB (in a dry run, this run's mappings may not have been written).
  const mappings = await run.node.query<{ external_id: string; user_id: string }>(`SELECT external_id,user_id FROM ${qualified(run.schemaName, "user_imports")} WHERE source=$1`, [ctx.source]);
  return new Map(mappings.map((row) => [row.external_id, row.user_id]));
}

/** `into` + `map` step: writes the mapped rows to the target table in batches with `ON CONFLICT DO NOTHING`. */
async function runTableStep(run: StepRun, step: TableStep<Json>) {
  const { node, ctx, options, summary } = run;
  const target = qualified(run.schemaName, step.into);
  const columns = await tableColumns(node, target);
  if (!columns.size) throw new AppError("IMPORT_INVALID", `Tenant has no table ${step.into}`);
  let batch: Json[] = [];
  const flush = async () => {
    if (!batch.length) return;
    options.signal?.throwIfAborted();
    const keys = [...new Set(batch.flatMap((row) => Object.keys(row)))];
    const unknown = keys.find((key) => !columns.has(key));
    if (unknown) throw new AppError("IMPORT_INVALID", `${step.into} has no column ${unknown}`);
    const list = keys.map(quoteIdentifier).join(",");
    const payload = JSON.stringify(batch);
    batch = [];
    if (options.dryRun) return;
    const [row] = await node.query<{ written: number }>(
      `WITH written AS (INSERT INTO ${target} (${list}) SELECT ${list} FROM pg_catalog.jsonb_populate_recordset(NULL::${target}, $1::text::jsonb) ON CONFLICT DO NOTHING RETURNING 1)
         SELECT count(*)::int AS written FROM written`,
      [payload],
    );
    summary.written += row?.written ?? 0;
  };
  for await (const row of run.rows()) {
    summary.read++;
    const out = step.map(row as Json, ctx);
    if (!out) summary.skipped++;
    else batch.push(...(Array.isArray(out) ? out : [out]));
    if (batch.length >= run.batchSize) await flush();
  }
  await flush();
  options.report?.({ tenantId: ctx.tenantId, source: ctx.source, table: step.table, status: "succeeded", read: summary.read, written: summary.written });
}

/** `input`: a `splitSqlDump` directory, or a `.sql`/`.sql.gz` directly (split into a temporary directory, then deleted). */
export async function runAppMigration(
  m: Management,
  tenantId: string,
  input: string,
  definition: AppMigrationDefinition<Record<string, Json>>,
  options: AppMigrationOptions = {},
): Promise<AppMigrationResult> {
  if (/\.sql(\.gz)?$/i.test(input)) return withSplitDump(input, options.signal, (dir) => runAppMigration(m, tenantId, dir, definition, options));
  const { source } = definition;
  const analysis = await readAnalysis(input);
  for (const step of definition.steps)
    if (!analysis.tables[step.table]) throw new AppError("IMPORT_INVALID", `Dump has no table ${step.table}`);
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize", MAX_BATCH_SIZE);
  const placement = requireActive(await m.platform.get(tenantId), "Tenant must be active to import");
  let users = new Map<string, string>();
  const ctx: AppMigrationContext = {
    tenantId,
    source,
    uuid: (table, externalId) => uuidFor(source, table, externalId),
    userId: (externalId) => users.get(String(externalId)) ?? null,
  };
  const result: AppMigrationResult = { tenantId, source, dryRun: !!options.dryRun, steps: [] };
  const node = m.pools.node(placement.databaseId);

  for (const step of definition.steps) {
    const file = analysis.tables[step.table]?.file;
    const summary: StepSummary = { table: step.table, read: 0, skipped: 0, written: 0 };
    result.steps.push(summary);
    const run: StepRun = { m, node, schemaName: placement.schemaName, ctx, options, batchSize, summary, rows: () => (file ? jsonLinesSource(join(input, file)) : []) };
    if ("users" in step) users = await runUsersStep(run, step);
    else await runTableStep(run, step);
  }
  return result;
}
