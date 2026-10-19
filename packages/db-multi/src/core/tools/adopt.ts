/** Adopting existing schemas as tenants: another application's arbitrarily named schema (`chitchat`) becomes `tenant_<id>` in place
 * and its placement is written. The plan is read-only; the application claims the placement as `provisioning` tenant by tenant, under
 * tenant locks and a node session → `ALTER SCHEMA … RENAME` → activates (with `markMigrationApplied` if a baseline is given).
 * Each step either completes or is skipped when re-run; rollback is done with the manifest. */
import { z } from "zod";
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";
import type { Management } from "../management";
import { type MigrationReport, noReport } from "../migrations/batch";
import { tenantMigrations } from "../migrations/registry";
import { markMigrationApplied } from "../migrations/runner";
import { pendingAt } from "../migrations/schema";
import { reread, withTenantSession } from "../operations/provision";
import { type TenantFields, tenantFieldsSchema } from "../tenants/fields";
import { type Kind, kindSchema, type Placement, quoteIdentifier, type Status, tenantSchema, tenantSchemas, validateTenantId } from "../tenants/model";
import { checkDatabases, schemaExists } from "../tenants/nodes";
import { findSchemaReferences, isUserSchema, type NameReference } from "./schema-references";

/** Input row (JSONL in the CLI): the schema to adopt, the target tenant ID and the database. `kind` defaults to `tenant`, `size` to 1. `tenant`:
 * the application's `platform.tenants` columns (same rules as the `tenant` option of `provisionTenant`), written only to a new record. */
export const adoptionRowSchema = z.strictObject({
  tenantId: z.string(),
  schema: z.string(),
  databaseId: z.string(),
  kind: kindSchema.optional(),
  size: z.number().int().min(1).max(100).optional(),
  tenant: tenantFieldsSchema.optional(),
});
export type AdoptionRow = z.input<typeof adoptionRowSchema>;

export type AdoptionProblemCode =
  | "INVALID_TENANT_ID"
  | "TENANT_RESERVED"
  | "DUPLICATE_TENANT_ID"
  | "DUPLICATE_SOURCE_SCHEMA"
  | "INVALID_SOURCE_SCHEMA"
  | "DATABASE_NOT_CONFIGURED"
  | "SOURCE_SCHEMA_MISSING"
  | "TARGET_SCHEMA_EXISTS"
  | "TENANT_EXISTS"
  | "SCHEMA_REFERENCED_BY_NAME"
  | "BASELINE_REQUIRED"
  | "SCHEMA_DRIFT";
export interface AdoptionProblem {
  code: AdoptionProblemCode;
  message: string;
  /** `SCHEMA_REFERENCED_BY_NAME`: objects whose text mentions the name. */
  objects?: NameReference[];
}
export interface PlannedAdoption {
  /** Position in the input (from 1). */
  line: number;
  tenantId: string;
  databaseId: string;
  kind: Kind;
  size: number;
  from: string;
  /** Validated application fields (by column name); if given on the row. */
  tenant?: TenantFields;
  /** Target schema; absent if the tenant ID is invalid. */
  to?: string;
  status: "ready" | "alreadyAdopted" | "blocked";
  /** Status of the existing placement matching this target: an interrupted adoption shows as `provisioning`. */
  placementStatus?: Status;
  problems: AdoptionProblem[];
}
/** Rollback record: which schema was renamed to which name in which database. */
export interface AdoptionManifestEntry {
  tenantId: string;
  databaseId: string;
  from: string;
  to: string;
}
export interface AdoptOptions {
  /** Marked as applied up to this tenant migration (the live schema must contain the folded DDL). */
  baseline?: string;
  signal?: AbortSignal;
  report?: MigrationReport;
}
export type AdoptionOutcome = "adopted" | "alreadyAdopted" | "blocked" | "failed" | "notRun";
export interface AdoptionResult {
  line: number;
  tenantId: string;
  databaseId: string;
  from: string;
  to?: string;
  status: AdoptionOutcome;
  problems?: AdoptionProblem[];
  error?: string;
  message?: string;
}

type ExistingTenant = { placement?: Pick<Placement, "databaseId" | "schemaName" | "status"> };
/** The whole input of the classification; read from the databases, the decision lives in a pure function. */
export interface AdoptionFacts {
  databaseIds: readonly string[];
  reserved: ReadonlySet<string>;
  /** Tenants registered on the platform (including a `platform.tenants` row without a placement). */
  tenants: ReadonlyMap<string, ExistingTenant>;
  /** schema name → tenant of the placement that holds it. */
  placementOwners: ReadonlyMap<string, string>;
  /** database → existing schemas among the candidate names. */
  schemas: ReadonlyMap<string, ReadonlySet<string>>;
  /** database → schemas among the candidate names that contain relations (tables, views, sequences …). */
  populated: ReadonlyMap<string, ReadonlySet<string>>;
  /** `db/schema` → objects whose text mentions the name. */
  references: ReadonlyMap<string, readonly NameReference[]>;
  /** If the baseline was produced by `pull`: the expected structure digest and `db/schema` → digest read from the schema being adopted (error text if it could not be read). */
  structure?: { expected: string; actual: ReadonlyMap<string, { structure?: string; error?: string }> };
}

type NormalizedRow = Required<Pick<AdoptionRow, "tenantId" | "schema" | "databaseId">> & { kind: Kind; size: number; line: number; tenant?: TenantFields };

const referenceKey = (databaseId: string, schema: string) => `${databaseId}/${schema}`;

const isTenantId = (value: string) => {
  try {
    return validateTenantId(value) === value;
  } catch {
    return false;
  }
};

const isAdoptableSchema = isUserSchema;

/** Validates the rows and fills in defaults; a malformed row is `USAGE` (with the line number). */
export function normalizeRows(rows: readonly unknown[]): NormalizedRow[] {
  return rows.map((value, index) => {
    const parsed = adoptionRowSchema.safeParse(value);
    if (!parsed.success) throw new AppError("USAGE", `row ${index + 1}: expected {tenantId, schema, databaseId, kind?: tenant|demo, size?: 1-100, tenant?: {column: value}}`);
    return { ...parsed.data, kind: parsed.data.kind ?? "tenant", size: parsed.data.size ?? 1, line: index + 1 };
  });
}

const problem = (code: AdoptionProblemCode, message: string, objects?: NameReference[]): AdoptionProblem =>
  objects ? { code, message, objects } : { code, message };

/** How many times the same value appears across rows. */
function counts(values: readonly string[]) {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

/** Checks that look at the input and the rules (no DB state needed). */
function inputProblems(row: NormalizedRow, facts: AdoptionFacts, duplicates: { ids: Map<string, number>; sources: Map<string, number> }) {
  const problems: AdoptionProblem[] = [];
  if (!isTenantId(row.tenantId)) problems.push(problem("INVALID_TENANT_ID", "tenant id must be 3-56 characters of a-z, 0-9 and single hyphens, starting with a letter"));
  if ((duplicates.ids.get(row.tenantId) ?? 0) > 1) problems.push(problem("DUPLICATE_TENANT_ID", "tenant id appears more than once in the input"));
  if ((duplicates.sources.get(referenceKey(row.databaseId, row.schema)) ?? 0) > 1)
    problems.push(problem("DUPLICATE_SOURCE_SCHEMA", "source schema appears more than once for this database"));
  const owner = facts.placementOwners.get(row.schema);
  if (!isAdoptableSchema(row.schema) || (owner !== undefined && owner !== row.tenantId))
    problems.push(problem("INVALID_SOURCE_SCHEMA", "source must be a plain lower-case identifier that is not a system, platform, public or another tenant's schema"));
  if (!facts.databaseIds.includes(row.databaseId)) problems.push(problem("DATABASE_NOT_CONFIGURED", `database ${row.databaseId} is not in DATABASE_URLS`));
  if (facts.reserved.has(row.tenantId) && !facts.tenants.has(row.tenantId)) problems.push(problem("TENANT_RESERVED", "tenant id is reserved"));
  return problems;
}

/** Whether this ID's `tenant_…`/`demo_…` names exist in any database other than the source or the target being adopted. */
function targetTakenElsewhere(row: NormalizedRow, target: string, facts: AdoptionFacts) {
  return facts.databaseIds.some((databaseId) =>
    tenantSchemas(row.tenantId).some((name) => {
      const here = databaseId === row.databaseId && (name === target || name === row.schema);
      return !here && !!facts.schemas.get(databaseId)?.has(name);
    }),
  );
}

/** Checks on placement, source and target schema state; `matching`: a placement matching this target exists. */
function stateProblems(row: NormalizedRow, target: string, facts: AdoptionFacts) {
  const problems: AdoptionProblem[] = [];
  const existing = facts.tenants.get(row.tenantId);
  const placement = existing?.placement;
  const matching = !!placement && placement.databaseId === row.databaseId && placement.schemaName === target;
  const schemas = facts.schemas.get(row.databaseId);
  const [sourceExists, targetExists, renamed] = [!!schemas?.has(row.schema), !!schemas?.has(target), row.schema !== target];
  if (existing && !matching) problems.push(problem("TENANT_EXISTS", "tenant already has a placement with another schema or database"));
  if (targetTakenElsewhere(row, target, facts) || (sourceExists && targetExists && renamed))
    problems.push(problem("TARGET_SCHEMA_EXISTS", `a schema for tenant ${row.tenantId} already exists; a tenant id has one schema across all databases`));
  if (!sourceExists && !(matching && targetExists)) problems.push(problem("SOURCE_SCHEMA_MISSING", `schema ${row.schema} does not exist on ${row.databaseId}`));
  const references = sourceExists && renamed ? (facts.references.get(referenceKey(row.databaseId, row.schema)) ?? []) : [];
  if (references.length)
    problems.push(problem("SCHEMA_REFERENCED_BY_NAME", "renaming does not rewrite text; remove the schema name from these objects first", [...references]));
  const adopted = matching && targetExists && (!sourceExists || !renamed);
  return { problems, adopted, placementStatus: matching ? placement.status : undefined };
}

/** Schema being adopted: the source if it is still under its old name, otherwise the target. */
const adoptingSchema = (row: NormalizedRow, target: string, facts: AdoptionFacts) => (facts.schemas.get(row.databaseId)?.has(row.schema) ? row.schema : target);

/** Baseline check for a row with work left (not active or never adopted). A populated schema adopted without a baseline becomes active but
 * the package migrations collide with the existing tables: `BASELINE_REQUIRED`. If the baseline was produced by `pull`, the schema's structure digest
 * must equal the baseline's; otherwise (or if it could not be read) `SCHEMA_DRIFT`: marking the baseline as applied would silently leave missing/extra objects. */
function baselineProblems(row: NormalizedRow, target: string, facts: AdoptionFacts, state: ReturnType<typeof stateProblems>, baseline: string | undefined) {
  if (state.problems.length || (state.adopted && state.placementStatus === "active")) return [];
  const adopting = adoptingSchema(row, target, facts);
  if (!baseline)
    return facts.populated.get(row.databaseId)?.has(adopting)
      ? [problem("BASELINE_REQUIRED", `schema ${adopting} already has tables; pass --baseline with the tenant migration its DDL matches`)]
      : [];
  if (!facts.structure) return [];
  const actual = facts.structure.actual.get(referenceKey(row.databaseId, adopting));
  if (actual?.structure === facts.structure.expected) return [];
  const found = actual?.structure ? `structure sha256 ${actual.structure}` : (actual?.error ?? "structure was not read");
  return [
    problem(
      "SCHEMA_DRIFT",
      `schema ${adopting} does not match baseline ${baseline} (expected sha256 ${facts.structure.expected}, found ${found}); pull this schema into a scratch copy and compare it with the baseline file`,
    ),
  ];
}

/** Pure classification: each row is `ready`, `alreadyAdopted` or `blocked` with its problems. Without `baseline`, a populated schema is blocked. */
export function classifyAdoption(rows: readonly NormalizedRow[], facts: AdoptionFacts, options: Pick<AdoptOptions, "baseline"> = {}): PlannedAdoption[] {
  const duplicates = { ids: counts(rows.map((row) => row.tenantId)), sources: counts(rows.map((row) => referenceKey(row.databaseId, row.schema))) };
  return rows.map((row) => {
    const base = { line: row.line, tenantId: row.tenantId, databaseId: row.databaseId, kind: row.kind, size: row.size, from: row.schema, ...(row.tenant && { tenant: row.tenant }) };
    const problems = inputProblems(row, facts, duplicates);
    if (problems.length) return { ...base, to: isTenantId(row.tenantId) ? tenantSchema(row.tenantId, row.kind) : undefined, status: "blocked", problems };
    const to = tenantSchema(row.tenantId, row.kind);
    const state = stateProblems(row, to, facts);
    const stateAndBaseline = [...state.problems, ...baselineProblems(row, to, facts, state, options.baseline)];
    const status = stateAndBaseline.length ? "blocked" : state.adopted ? "alreadyAdopted" : "ready";
    return { ...base, to, status, placementStatus: state.placementStatus, problems: stateAndBaseline };
  });
}

const jsonList = (values: Iterable<string>) => JSON.stringify([...new Set(values)]);
const IN_LIST = "IN (SELECT pg_catalog.jsonb_array_elements_text($1::text::jsonb))";

/** Platform records: reserved IDs, tenants/placements, and placements that hold the source names. */
async function readPlatformFacts(m: Management, rows: readonly NormalizedRow[]) {
  const ids = jsonList(rows.map((row) => row.tenantId));
  const platform = m.pools.platform;
  const reserved = await platform.query<{ tenant_id: string }>(`SELECT tenant_id FROM platform.reserved_tenant_ids WHERE tenant_id ${IN_LIST}`, [ids]);
  const tenants = await platform.query<{ tenant_id: string; database_id: string | null; schema_name: string | null; status: Status | null }>(
    `SELECT t.tenant_id,p.database_id,p.schema_name,p.status FROM platform.tenants t LEFT JOIN platform.placements p ON p.tenant_id=t.tenant_id WHERE t.tenant_id ${IN_LIST}`,
    [ids],
  );
  const owners = await platform.query<{ schema_name: string; tenant_id: string }>(
    `SELECT schema_name,tenant_id FROM platform.placements WHERE schema_name ${IN_LIST}`,
    [jsonList(rows.map((row) => row.schema))],
  );
  const placementOf = (row: (typeof tenants)[number]) =>
    row.database_id && row.schema_name && row.status ? { databaseId: row.database_id, schemaName: row.schema_name, status: row.status } : undefined;
  return {
    reserved: new Set(reserved.map((row) => row.tenant_id)),
    tenants: new Map(tenants.map((row) => [row.tenant_id, { placement: placementOf(row) }])),
    placementOwners: new Map(owners.map((row) => [row.schema_name, row.tenant_id])),
  };
}

/** Candidate schemas and whether they contain relations. */
const CANDIDATE_SCHEMAS_SQL = `SELECT n.nspname AS name,EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','S','f')) AS populated
  FROM pg_catalog.pg_namespace n WHERE n.nspname ${IN_LIST}`;

/** In each database, the candidate names (sources and the two target names of valid IDs) that exist, the populated ones, and the text references
 * of the sources to be renamed. */
async function readNodeFacts(m: Management, rows: readonly NormalizedRow[]) {
  const candidates = jsonList(rows.flatMap((row) => [row.schema, ...(isTenantId(row.tenantId) ? tenantSchemas(row.tenantId) : [])]));
  const schemas = new Map<string, Set<string>>();
  const populated = new Map<string, Set<string>>();
  const references = new Map<string, NameReference[]>();
  for (const { id } of m.config.nodes) {
    const db = m.pools.node(id);
    const found = await db.query<{ name: string; populated: boolean }>(CANDIDATE_SCHEMAS_SQL, [candidates]);
    const existing = new Set(found.map((row) => row.name));
    schemas.set(id, existing);
    populated.set(id, new Set(found.filter((row) => row.populated).map((row) => row.name)));
    const renamed = rows.filter((row) => row.databaseId === id && existing.has(row.schema) && isAdoptableSchema(row.schema));
    for (const [schema, list] of await findSchemaReferences(db, [...new Set(renamed.map((row) => row.schema))])) references.set(referenceKey(id, schema), list);
  }
  return { schemas, populated, references };
}

/** For a baseline produced by `pull`, the structure digest of the schema each row will adopt (the source if under its old name, otherwise the target). */
async function readStructures(m: Management, rows: readonly NormalizedRow[], schemas: AdoptionFacts["schemas"], baseline: string | undefined) {
  const marker = tenantMigrations.find((migration) => migration.id === baseline)?.pulled;
  if (!marker) return undefined;
  const { pullStructure } = await import("./pull");
  const actual = new Map<string, { structure?: string; error?: string }>();
  for (const row of rows) {
    const existing = schemas.get(row.databaseId);
    const target = isTenantId(row.tenantId) ? tenantSchema(row.tenantId, row.kind) : undefined;
    const adopting = existing?.has(row.schema) ? row.schema : target;
    const key = adopting && referenceKey(row.databaseId, adopting);
    if (!key || actual.has(key) || !existing?.has(adopting) || !m.config.nodes.some((node) => node.id === row.databaseId)) continue;
    try {
      actual.set(key, { structure: (await pullStructure(m.pools.node(row.databaseId), adopting, marker.exclude)).structure });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      actual.set(key, { error: `${error.code}: ${error.message}` });
    }
  }
  return { expected: marker.structure, actual };
}

async function readFacts(m: Management, rows: readonly NormalizedRow[], baseline?: string): Promise<AdoptionFacts> {
  const databaseIds = m.config.nodes.map((node) => node.id);
  const node = await readNodeFacts(m, rows);
  return { databaseIds, ...(await readPlatformFacts(m, rows)), ...node, structure: await readStructures(m, rows, node.schemas, baseline) };
}

const summarize = <T extends { status: string }>(items: readonly T[]) =>
  items.reduce<Record<string, number>>((summary, item) => ({ ...summary, [item.status]: (summary[item.status] ?? 0) + 1 }), {});

/** The rows' `tenant` fields are validated against the real `platform.tenants` columns and converted to column names; a bad field rejects the whole
 * input with `INVALID_CONFIG` (with the line number), just as a malformed row gives `USAGE`. */
async function resolveRowFields(m: Management, rows: readonly NormalizedRow[]): Promise<NormalizedRow[]> {
  const resolved: NormalizedRow[] = [];
  for (const row of rows) {
    if (row.tenant === undefined) {
      resolved.push(row);
      continue;
    }
    const tenant = await m.platform.tenantFields(row.tenant).catch((error: unknown) => {
      throw error instanceof AppError ? new AppError(error.code, `row ${row.line}: ${error.message}`) : error;
    });
    resolved.push({ ...row, tenant: tenant as TenantFields });
  }
  return resolved;
}

/** Read-only plan: database readiness is checked, each row is classified; without `baseline`, a populated schema is `BASELINE_REQUIRED`. */
export async function planAdoption(m: Management, rows: readonly unknown[], options: Pick<AdoptOptions, "baseline"> = {}) {
  const normalized = await resolveRowFields(m, normalizeRows(rows));
  await checkDatabases(
    m.pools,
    m.config.nodes.map((node) => node.id),
  );
  const planned = classifyAdoption(normalized, await readFacts(m, normalized, options.baseline), options);
  return { rows: planned, summary: summarize(planned) };
}

/** Fresh classification of a single row under the lock; if blocked, throws with the code of the first problem. */
async function recheck(m: Management, row: PlannedAdoption, baseline: string | undefined): Promise<PlannedAdoption> {
  const rows = normalizeRows([{ tenantId: row.tenantId, schema: row.from, databaseId: row.databaseId, kind: row.kind, size: row.size, tenant: row.tenant }]);
  const [fresh] = classifyAdoption(rows, await readFacts(m, rows, baseline), { baseline });
  const first = fresh?.problems[0];
  if (!fresh || first) throw new AppError(first?.code ?? "INVALID_DATABASE_STATE", first?.message ?? "adoption state changed");
  return fresh;
}

/** Whether the baseline is still pending on this schema (without a ledger every migration is pending). */
async function baselinePending(m: Management, target: Pick<Placement, "databaseId" | "schemaName">, baseline: string | undefined) {
  if (!baseline) return false;
  return (await pendingAt(m, target)).some((migration) => migration.id === baseline);
}

/** Renames if the source is still under its old name; does nothing if it is already under the new name. */
async function renameSchema(db: Connection, verify: () => Promise<void>, from: string, to: string) {
  if (from === to || !(await schemaExists(db, from))) return false;
  await verify();
  await db.exec(`ALTER SCHEMA ${quoteIdentifier(from)} RENAME TO ${quoteIdentifier(to)}`);
  return true;
}

/** Under tenant locks: fresh check → claim the placement (`provisioning`) → rename → activate if there is no baseline (or it has already
 * been applied). The return value is whether the baseline still needs to run. */
function claimAndRename(m: Management, row: PlannedAdoption, to: string, options: AdoptOptions) {
  const report = options.report ?? noReport;
  const event = { tenantId: row.tenantId, databaseId: row.databaseId, from: row.from, to };
  return withTenantSession(m, row.tenantId, row.databaseId, options, async (db, verify, assertOwned) => {
    await recheck(m, row, options.baseline);
    await verify();
    const placement = await reread(m, await m.platform.create(row.tenantId, row.databaseId, row.kind, row.size, row.tenant));
    if (!["provisioning", "active"].includes(placement.status)) throw new AppError("TENANT_UNAVAILABLE", "Tenant has another operation");
    report({ ...event, step: "claimed" });
    if (await renameSchema(db, verify, row.from, to)) report({ ...event, step: "renamed" });
    const pending = await baselinePending(m, placement, options.baseline);
    if (!pending && placement.status !== "active") {
      await assertOwned();
      await m.platform.setStatus(placement, "active");
      report({ ...event, step: "activated" });
    }
    return pending;
  });
}

/** Single row: an active row whose baseline has been applied is skipped without a lock; otherwise claim/rename, then the baseline if needed. */
async function adoptRow(m: Management, row: PlannedAdoption, options: AdoptOptions): Promise<"adopted" | "alreadyAdopted"> {
  const to = row.to as string;
  const target = { databaseId: row.databaseId, schemaName: to };
  if (row.status === "alreadyAdopted" && row.placementStatus === "active" && !(await baselinePending(m, target, options.baseline))) return "alreadyAdopted";
  const needsBaseline = await claimAndRename(m, row, to, options);
  if (needsBaseline && options.baseline) {
    await markMigrationApplied(m, row.tenantId, options.baseline, { databaseId: row.databaseId, signal: options.signal, report: options.report });
    options.report?.({ tenantId: row.tenantId, databaseId: row.databaseId, to, step: "baselined", baseline: options.baseline });
  }
  return row.status === "alreadyAdopted" ? "alreadyAdopted" : "adopted";
}

const resultOf = (row: PlannedAdoption, status: AdoptionOutcome, extra: Partial<AdoptionResult> = {}): AdoptionResult => ({
  line: row.line,
  tenantId: row.tenantId,
  databaseId: row.databaseId,
  from: row.from,
  to: row.to,
  status,
  ...extra,
});

/** The baseline must be a tenant migration known to the code; checked before any work starts. */
function checkBaseline(baseline: string | undefined) {
  if (baseline !== undefined && !tenantMigrations.some((migration) => migration.id === baseline))
    throw new AppError("MIGRATION_NOT_PENDING", `${baseline} is not a tenant migration in this code`);
}

/**
 * Adopts the `ready` rows (and interrupted `alreadyAdopted` rows) in order. Stops at the first error; remaining rows are `notRun`.
 * Re-running is safe. `manifest` contains every row adopted in this or a previous run (`rollbackAdoption`).
 */
export async function adoptSchemas(m: Management, rows: readonly unknown[], options: AdoptOptions = {}) {
  checkBaseline(options.baseline);
  const plan = await planAdoption(m, rows, options);
  const results: AdoptionResult[] = [];
  const manifest: AdoptionManifestEntry[] = [];
  let stopped = false;
  for (const row of plan.rows) {
    if (row.status === "blocked") results.push(resultOf(row, "blocked", { problems: row.problems }));
    else if (stopped || options.signal?.aborted) {
      stopped = true;
      results.push(resultOf(row, "notRun"));
    } else
      try {
        results.push(resultOf(row, await adoptRow(m, row, options)));
        manifest.push({ tenantId: row.tenantId, databaseId: row.databaseId, from: row.from, to: row.to as string });
      } catch (error) {
        stopped = true;
        results.push(resultOf(row, "failed", { error: errorCode(error), message: error instanceof AppError ? error.message : undefined }));
      }
  }
  return { results, manifest, summary: summarize(results) };
}

export const manifestSchema = z.array(z.strictObject({ tenantId: z.string(), databaseId: z.string(), from: z.string(), to: z.string() }));

/** A manifest row must be self-consistent: a valid ID, its `tenant_`/`demo_` name, and an adoptable source name. */
function validateManifest(value: unknown): AdoptionManifestEntry[] {
  const parsed = manifestSchema.safeParse(value);
  const valid = parsed.success && parsed.data.every((entry) => isTenantId(entry.tenantId) && tenantSchemas(entry.tenantId).includes(entry.to) && isAdoptableSchema(entry.from));
  if (!valid) throw new AppError("USAGE", "manifest must be an array of {tenantId, databaseId, from, to} written by adopt apply");
  return parsed.data;
}

const rollbackRefused = (message: string) => new AppError("ROLLBACK_NOT_ALLOWED", message);

/** Must be unchanged since adoption: same database and schema, first placement version, no unfinished move, an eligible status. */
async function assertUnchangedSinceAdoption(m: Management, entry: AdoptionManifestEntry, placement: Placement) {
  if (placement.databaseId !== entry.databaseId || placement.schemaName !== entry.to || placement.placementVersion !== 1)
    throw rollbackRefused(`Tenant ${entry.tenantId} moved or its placement changed since adoption; restore from backup instead`);
  if (!["active", "provisioning", "maintenance"].includes(placement.status)) throw rollbackRefused(`Tenant ${entry.tenantId} has another operation`);
  const moves = await m.pools.platform.query("SELECT 1 FROM platform.moves WHERE tenant_id=$1 AND status IN ('running','failed') LIMIT 1", [entry.tenantId]);
  if (moves.length) throw rollbackRefused(`Tenant ${entry.tenantId} has an unfinished move`);
}

/** Deletes the placement and tenant rows in one transaction, conditional on the placement version that was read. */
async function deletePlacement(m: Management, placement: Placement) {
  await m.pools.platform.transaction(async (tx) => {
    const deleted = await tx.query(
      "DELETE FROM platform.placements WHERE tenant_id=$1 AND database_id=$2 AND placement_version=$3 AND move_operation_id IS NULL RETURNING 1",
      [placement.tenantId, placement.databaseId, placement.placementVersion],
    );
    if (deleted.length !== 1) throw new AppError("PLACEMENT_CONFLICT", "Placement changed concurrently; reload and retry");
    await tx.query("DELETE FROM platform.tenants WHERE tenant_id=$1", [placement.tenantId]);
  });
  await m.platform.changed(placement.tenantId);
}

/** A row without a placement: counts as rolled back if the schema is already under its old name, otherwise rejected. */
async function assertRolledBack(m: Management, entry: AdoptionManifestEntry) {
  const db = m.pools.node(entry.databaseId);
  const back = (await schemaExists(db, entry.from)) && (entry.from === entry.to || !(await schemaExists(db, entry.to)));
  if (!back) throw rollbackRefused(`Tenant ${entry.tenantId} has no placement and ${entry.from} is not back in place`);
}

const findPlacement = (m: Management, tenantId: string) =>
  m.platform.get(tenantId).catch((error: unknown) => {
    if (errorCode(error) !== "TENANT_NOT_FOUND") throw error;
    return undefined;
  });

/** A single manifest row under tenant locks: `maintenance` → schema back to its old name → placement/tenant rows deleted. */
async function rollbackEntry(m: Management, entry: AdoptionManifestEntry, options: Pick<AdoptOptions, "signal" | "report">) {
  if (!(await findPlacement(m, entry.tenantId))) {
    await assertRolledBack(m, entry);
    return "alreadyRolledBack" as const;
  }
  return withTenantSession(m, entry.tenantId, entry.databaseId, options, async (db, verify, assertOwned) => {
    const found = await findPlacement(m, entry.tenantId);
    if (!found) {
      await assertRolledBack(m, entry);
      return "alreadyRolledBack" as const;
    }
    await assertUnchangedSinceAdoption(m, entry, found);
    const placement = found.status === "maintenance" ? found : await m.platform.setStatus(found, "maintenance");
    if (entry.from !== entry.to && (await schemaExists(db, entry.from)))
      throw rollbackRefused(`${entry.from} already exists on ${entry.databaseId}; rename it before rolling back`);
    await renameSchema(db, verify, entry.to, entry.from);
    await assertOwned();
    await deletePlacement(m, placement);
    options.report?.({ ...entry, step: "rolledBack" });
    return "rolledBack" as const;
  });
}

/**
 * Rolls back every adoption in the manifest: the schema returns to its old name, and the placement and `platform.tenants` row are deleted. Rejected
 * if the tenant was moved after adoption or its placement changed. Stops at the first error; re-running is safe.
 * The `_migrations` table the baseline created inside the schema is not dropped. The API and workers must be stopped.
 */
export async function rollbackAdoption(m: Management, manifest: unknown, options: Pick<AdoptOptions, "signal" | "report"> = {}) {
  const entries = validateManifest(manifest);
  const results: (AdoptionManifestEntry & { status: string; error?: string; message?: string })[] = [];
  let stopped = false;
  for (const entry of entries) {
    if (stopped || options.signal?.aborted) {
      stopped = true;
      results.push({ ...entry, status: "notRun" });
      continue;
    }
    try {
      m.pools.nodeConfig(entry.databaseId);
      results.push({ ...entry, status: await rollbackEntry(m, entry, options) });
    } catch (error) {
      stopped = true;
      results.push({ ...entry, status: "failed", error: errorCode(error), message: error instanceof AppError ? error.message : undefined });
    }
  }
  return { results, summary: summarize(results) };
}
