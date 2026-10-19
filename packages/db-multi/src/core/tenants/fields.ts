/** `platform.tenants` application fields: columns the application adds with its own platform migrations (e.g. the application's `name`,
 * `display_name`, `owner_email`). The package does not define these columns; keys are validated against the real columns in the database,
 * and values are written with a single bound JSON parameter and quoted column names, in the same statement that creates the row. */
import { z } from "zod";
import type { Connection } from "../driver";
import { AppError, errorCode } from "../errors";
import { quoteIdentifier } from "./model";

/** API and CLI input: column name (snake_case; camelCase if unambiguous) → plain value. */
export const tenantFieldsSchema = z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type TenantFields = z.infer<typeof tenantFieldsSchema>;
/** A validated row: real column name → value. Only the output of `resolveTenantFields`/`restoredTenantRow` is written. */
export type TenantRow = Readonly<Record<string, unknown>>;

export interface TenantColumns {
  /** Writable (non-generated) columns in the database. */
  readonly writable: ReadonlySet<string>;
  /** Columns defined by the package's own migrations (`tenant_id`, `created_at`); not written from input. */
  readonly packageOwned: ReadonlySet<string>;
}

const invalid = (message: string) => new AppError("INVALID_CONFIG", message);

/** `ownerEmail` → `owner_email`; a key without uppercase letters is unchanged. */
export const snakeCase = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** The column for a key: the exact name comes first (a quoted uppercase column), otherwise its snake_case equivalent. */
function columnOf(key: string, columns: TenantColumns) {
  return columns.writable.has(key) || columns.packageOwned.has(key) ? key : snakeCase(key);
}

/** Candidate names to look up in the database for the keys (for the cache refresh decision). */
export const candidateColumns = (keys: readonly string[]) => keys.flatMap((key) => [key, snakeCase(key)]);

/** Validates the input: an unknown/generated column, a package column, two keys mapping to the same column or a non-plain value is `INVALID_CONFIG`. */
export function resolveTenantFields(fields: unknown, columns: TenantColumns): TenantRow {
  const parsed = tenantFieldsSchema.safeParse(fields ?? {});
  if (!parsed.success) throw invalid("tenant fields must be a JSON object of string, number, boolean or null values");
  const row = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed.data)) {
    const column = columnOf(key, columns);
    if (columns.packageOwned.has(column)) throw invalid(`tenant field ${key}: ${column} is written by the package`);
    if (!columns.writable.has(column)) throw invalid(`tenant field ${key}: platform.tenants has no writable column ${column}`);
    if (row.has(column)) throw invalid(`tenant field ${key}: column ${column} is given twice`);
    row.set(column, value);
  }
  return Object.fromEntries(row);
}

/** A `platform.tenants` row in the backup: writable columns other than `tenant_id` (including the package's own) are written as is; columns that
 * are missing in the target or generated go into the `skipped` list. */
export function restoredTenantRow(stored: Readonly<Record<string, unknown>>, columns: TenantColumns) {
  const entries = Object.entries(stored).filter(([column]) => column !== "tenant_id");
  return {
    row: Object.fromEntries(entries.filter(([column]) => columns.writable.has(column))) as TenantRow,
    skipped: entries.filter(([column]) => !columns.writable.has(column)).map(([column]) => column),
  };
}

const INSERT_TENANT_ID = "INSERT INTO platform.tenants (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING RETURNING 1";

/** Writing the tenant row: with no fields, only `tenant_id`; with fields, the columns are quoted and the values are a single bound JSON converted to the column
 * types with `json_populate_record`. If the record already exists, no row is returned. */
export function tenantInsert(tenantId: string, row: TenantRow): { sql: string; values: unknown[] } {
  const columns = Object.keys(row).map(quoteIdentifier);
  if (!columns.length) return { sql: INSERT_TENANT_ID, values: [tenantId] };
  const sql = `INSERT INTO platform.tenants (tenant_id,${columns.join(",")}) OVERRIDING SYSTEM VALUE SELECT $1,${columns.map((column) => `r.${column}`).join(",")}
    FROM pg_catalog.json_populate_record(NULL::platform.tenants,$2::text::json) r ON CONFLICT (tenant_id) DO NOTHING RETURNING 1`;
  return { sql, values: [tenantId, JSON.stringify(row)] };
}

/** With the bound schema/table name; `information_schema` shows only accessible columns. */
const WRITABLE_COLUMNS = "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER'";

export async function readTenantColumns(db: Pick<Connection, "query">): Promise<ReadonlySet<string>> {
  const rows = await db.query<{ name: string }>(WRITABLE_COLUMNS, ["platform", "tenants"]);
  return new Set(rows.map((row) => row.name));
}

/** A NOT NULL violation (`23502`) in the tenant row: the code stays the same, the message names the missing column and the fix (row values are not written). */
export function tenantInsertError(error: unknown): unknown {
  if (errorCode(error) !== "23502") return error;
  const { column, message } = error as { column?: unknown; message?: unknown };
  const name = typeof column === "string" && column ? column : typeof message === "string" ? /column "([^"]+)"/.exec(message)?.[1] : undefined;
  const subject = name ? `platform.tenants.${name} is NOT NULL` : "a platform.tenants column is NOT NULL";
  return new AppError("23502", `${subject}; pass it in the tenant fields (tenant option, --tenant or the adoption row's tenant object)`);
}
