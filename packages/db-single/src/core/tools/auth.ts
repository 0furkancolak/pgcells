/** The Better Auth schema as a migration. `authSchemaDiff`: compares the Better Auth tables (`getSchema`) with a schema's `information_schema` /
 * `pg_index` information (CI drift check); the schema name is a bound parameter. `generateAuthMigration`:
 * applies the package's migrations to a temporary schema and writes the difference to a new `--up/--down` file. The SQL has the same form as
 * Better Auth `getMigrations`' PostgreSQL output (unqualified names; the schema is added when the migration is bound). */
import type { BetterAuthOptions } from "better-auth";
import { initGetFieldName } from "better-auth/adapters";
import { getAuthTables, getSchema } from "better-auth/db";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { quoteIdentifier, validateSchema } from "../identifier";
import { cancelled } from "../locks";
import type { Management } from "../management";
import { registry as packageRegistry, type Registry } from "../migrations/registry";
import { createMigration } from "../sql/codegen";
import { prepareMigration } from "../sql/compiler";

type AuthSchema = ReturnType<typeof getSchema>;
type Field = AuthSchema[string]["fields"][string];
type Fields = Record<string, Field>;
type TableIndex = NonNullable<AuthSchema[string]["indexes"]>[number];
type PlannedTable = { table: string; fields: Fields; order: number };
type PlannedIndex = { table: string; index: TableIndex; name: string };
type ExistingIndex = { table: string; columns: string[]; unique: boolean; valid: boolean };
type AuthSchemaDiff = Awaited<ReturnType<typeof authSchemaDiff>>;

type TypeMismatch = { table: string; column: string; expected: string; actual: string };

const COLUMNS_SQL = `SELECT table_name AS "table", column_name AS "column", data_type AS "type" FROM information_schema.columns WHERE table_schema = $1`;

/** `information_schema.columns.data_type` values; enum columns appear as `USER-DEFINED` and count as text fields. */
const TEXT_TYPES = ["text", "character varying", "character", "uuid", "USER-DEFINED"];
const COLUMN_TYPES: Record<string, readonly string[]> = {
  string: TEXT_TYPES,
  number: ["integer", "bigint", "smallint", "numeric", "real", "double precision"],
  boolean: ["boolean"],
  date: ["timestamp with time zone", "timestamp without time zone", "date"],
  json: ["json", "jsonb"],
  "string[]": ["json", "jsonb"],
  "number[]": ["json", "jsonb"],
};

/** Better Auth `getMigrations` passes the type check as a warning; here it is a difference (e.g. a boolean field mapped to a timestamp column). */
function expectedTypes(field: Field): readonly string[] {
  if (Array.isArray(field.type)) return TEXT_TYPES;
  return COLUMN_TYPES[field.type as string] ?? [];
}
const INDEXES_SQL = `SELECT t.relname AS "table", i.relname AS "name", a.attname AS "column", x.indisunique AS "unique",
  (x.indisvalid AND x.indpred IS NULL AND a.attname IS NOT NULL) AS "valid", k.ordinality AS "position"
FROM pg_catalog.pg_class t
JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
JOIN pg_catalog.pg_index x ON x.indrelid = t.oid
JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinality) ON TRUE
LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
WHERE n.nspname = $1 AND t.relkind = 'r' AND k.ordinality <= x.indnkeyatts
ORDER BY 1, 2, k.ordinality`;

const indexKey = (table: string, name: string) => `${table.toLowerCase()}\0${name.toLowerCase()}`;

/** Table → column names and table+index name → index; all from a single schema. */
async function introspect(query: Pick<Connection, "query">, schema: string) {
  const tables = new Map<string, Map<string, string>>();
  for (const { table, column, type } of await query.query<{ table: string; column: string; type: string }>(COLUMNS_SQL, [schema]))
    tables.set(table, (tables.get(table) ?? new Map()).set(column, type));
  const indexes = new Map<string, ExistingIndex>();
  for (const row of await query.query<{ table: string; name: string; column: string | null; unique: boolean; valid: boolean }>(INDEXES_SQL, [schema])) {
    const key = indexKey(row.table, row.name);
    const index = indexes.get(key) ?? { table: row.table, columns: [], unique: row.unique, valid: true };
    if (row.column) index.columns.push(row.column);
    index.valid &&= row.valid;
    indexes.set(key, index);
  }
  return { tables, indexes };
}

const indexMismatch = (table: string, name: string) =>
  new AppError("INVALID_CONFIG", `Database index "${name}" (for table "${table}") exists but is invalid, partial, on another table or does not match the Better Auth fields and uniqueness`);
const sameIndex = (existing: ExistingIndex, index: TableIndex) =>
  existing.valid && existing.unique === (index.unique ?? false) && existing.columns.join("\0") === index.columns.join("\0");

/** The Better Auth `getMigrations` plan: new tables by table `order`, missing columns in existing tables, missing table indexes;
 * plus type mismatches of existing columns (`typeMismatches`, no SQL is produced). */
function planDiff(schema: AuthSchema, { tables, indexes }: Awaited<ReturnType<typeof introspect>>) {
  const toBeCreated: PlannedTable[] = [];
  const toBeAdded: PlannedTable[] = [];
  const toBeAddedIndexes: PlannedIndex[] = [];
  const typeMismatches: TypeMismatch[] = [];
  const planned = new Set<string>();
  // Index names are unique across the schema: the name to be generated must not exist on another table's index either.
  const taken = (name: string) => [...indexes.keys()].some((key) => key.endsWith(`\0${name.toLowerCase()}`));
  for (const [table, value] of Object.entries(schema)) {
    if (value.disableMigrations) continue;
    for (const index of value.indexes ?? []) {
      const key = indexKey(table, index.name);
      const existing = indexes.get(key);
      if (existing ? !sameIndex(existing, index) : taken(index.name)) throw indexMismatch(table, index.name);
      if (existing || planned.has(key)) continue;
      planned.add(key);
      toBeAddedIndexes.push({ table, index, name: index.name });
    }
    const order = value.order || Infinity;
    const columns = tables.get(table);
    if (!columns) {
      const at = toBeCreated.findIndex((created) => created.order > order);
      toBeCreated.splice(at === -1 ? toBeCreated.length : at, 0, { table, fields: value.fields, order });
      continue;
    }
    const missing = Object.entries(value.fields).filter(([column]) => !columns.has(column));
    if (missing.length) toBeAdded.push({ table, fields: Object.fromEntries(missing), order });
    for (const [column, field] of Object.entries(value.fields)) {
      // Missing index or uniqueness constraint on an existing column (the writer adds the indexes of new columns and tables itself).
      const covered = [...indexes.values()].some((index) => index.table === table && index.valid && index.columns.join() === column && (index.unique || !field.unique));
      const name = fieldIndexName(table, column, field.unique ?? false);
      if (columns.has(column) && (field.index || field.unique) && !covered && !planned.has(indexKey(table, name))) {
        // The generated name is on an index that does not count as a match: CREATE INDEX with the same name would collide in the migration.
        if (taken(name)) throw indexMismatch(table, name);
        planned.add(indexKey(table, name));
        toBeAddedIndexes.push({ table, index: { name, columns: [column], unique: field.unique }, name });
      }
      const actual = columns.get(column);
      const expected = field.references?.field === "id" ? TEXT_TYPES.concat("integer") : expectedTypes(field);
      if (actual && !expected.includes(actual)) typeMismatches.push({ table, column, expected: String(field.type), actual });
    }
  }
  return { toBeCreated, toBeAdded, toBeAddedIndexes, typeMismatches };
}

/** Long index names are shortened to 63 bytes with an FNV-1a hash, as Better Auth does. */
function fieldIndexName(table: string, column: string, unique: boolean) {
  const kind = unique ? "uidx" : "idx";
  const name = `${table}_${column}_${kind}`;
  if (new TextEncoder().encode(name).length <= 63) return name;
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  const suffix = `_${(hash >>> 0).toString(16).padStart(8, "0")}_${kind}`;
  let head = "";
  for (const character of name.slice(0, -kind.length - 1)) {
    if (new TextEncoder().encode(head + character + suffix).length > 63) break;
    head += character;
  }
  return head + suffix;
}

const literal = (value: string | number | boolean) => (typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value));

/** The Better Auth `getMigrations` PostgreSQL SQL; `add` is a column added to an existing table (constant defaults only there). */
function createSqlWriter(options: BetterAuthOptions) {
  const generateId = options.advanced?.database?.generateId;
  const idType = generateId === "serial" ? "integer" : generateId === "uuid" ? "uuid" : "text";
  const fieldName = initGetFieldName({ schema: getAuthTables(options), usePlural: false });
  const referencedColumn = (model: string, field: string) => {
    try {
      return fieldName({ model, field });
    } catch {
      return field;
    }
  };

  function columnType(column: string, field: Field) {
    if (field.references?.field === "id") return idType;
    if (Array.isArray(field.type)) return "text";
    const types: Record<string, string> = { string: "text", boolean: "boolean", number: field.bigint ? "bigint" : "integer", date: "timestamptz", json: "jsonb", "string[]": "jsonb", "number[]": "jsonb" };
    const type = types[field.type as string];
    if (!type) throw new AppError("INVALID_CONFIG", `Unsupported Better Auth field type for "${column}"`);
    return type;
  }

  function defaultClause(field: Field, add: boolean) {
    if (field.type === "date" && typeof field.defaultValue === "function") return " default CURRENT_TIMESTAMP";
    const value = field.defaultValue;
    const staticDefault = add && !(field.unique && field.required === false) && ["string", "number", "boolean"].includes(field.type as string);
    return staticDefault && (typeof value === "string" || typeof value === "number" || typeof value === "boolean") ? ` default ${literal(value)}` : "";
  }

  function column(name: string, field: Field, add: boolean) {
    let text = `${quoteIdentifier(name)} ${columnType(name, field)}${defaultClause(field, add)}`;
    if (field.required !== false) text += " not null";
    if (!add && field.unique) text += " unique";
    const reference = field.references;
    if (reference) text += ` references ${quoteIdentifier(reference.model)} (${quoteIdentifier(referencedColumn(reference.model, reference.field))}) on delete ${reference.onDelete || "cascade"}`;
    return text;
  }

  const index = (name: string, table: string, columns: readonly string[], unique = false) =>
    `create ${unique ? "unique " : ""}index ${quoteIdentifier(name)} on ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})`;

  function idColumn() {
    if (generateId === "serial") return `"id" integer GENERATED BY DEFAULT AS IDENTITY not null primary key`;
    if (generateId === "uuid") return `"id" uuid default pg_catalog.gen_random_uuid() not null primary key`;
    return `"id" text not null primary key`;
  }

  return ({ toBeCreated, toBeAdded, toBeAddedIndexes }: ReturnType<typeof planDiff>) => {
    const statements: string[] = [];
    const deferred: string[] = [];
    for (const { table, fields } of toBeAdded)
      for (const [name, field] of Object.entries(fields)) {
        if (field.index || field.unique) deferred.push(index(fieldIndexName(table, name, field.unique ?? false), table, [name], field.unique));
        statements.push(`alter table ${quoteIdentifier(table)} add column ${column(name, field, true)}`);
      }
    for (const { table, fields } of toBeCreated) {
      const columns = [idColumn(), ...Object.entries(fields).map(([name, field]) => column(name, field, false))];
      for (const [name, field] of Object.entries(fields)) if (field.index && !field.unique) deferred.push(index(fieldIndexName(table, name, false), table, [name]));
      statements.push(`create table ${quoteIdentifier(table)} (${columns.join(", ")})`);
    }
    for (const planned of toBeAddedIndexes) deferred.push(index(planned.name, planned.table, planned.index.columns, planned.index.unique));
    const all = [...statements, ...deferred];
    return all.length ? `${all.join(";\n\n")};` : "";
  };
}

/** `schema` is the application schema. */
export async function authSchemaDiff(m: Pick<Management, "db">, input: BetterAuthOptions, { schema }: { schema: string }) {
  // `createAuth` has the database generate the IDs (`generateId: false`); the options module does not know this, and the IDs of new tables must also be uuid:
  // the module's own `generateId` is overridden with uuid too.
  const options = { ...input, advanced: { ...input.advanced, database: { ...input.advanced?.database, generateId: "uuid" as const } } };
  const existing = await introspect(m.db, validateSchema(schema));
  const plan = planDiff(getSchema(options), existing);
  return { ...plan, sql: createSqlWriter(options)(plan) };
}

/** The `--down` that reverts the difference: indexes other than those of new tables, added columns, then new tables (in reverse order). */
function downMigration({ toBeCreated, toBeAdded, toBeAddedIndexes }: AuthSchemaDiff) {
  const createdTables = toBeCreated.map(({ table }) => table);
  return [
    ...toBeAddedIndexes.filter(({ table }) => !createdTables.includes(table)).map(({ name }) => `DROP INDEX ${quoteIdentifier(name)};`),
    ...toBeAdded.flatMap(({ table, fields }) =>
      Object.keys(fields).map((column) => `ALTER TABLE ${quoteIdentifier(table)} DROP COLUMN ${quoteIdentifier(column)};`),
    ),
    ...(createdTables.length ? [`DROP TABLE ${createdTables.reverse().map(quoteIdentifier).join(", ")};`] : []),
  ].join("\n");
}

/** Writes no file if there is no difference. A `--down` is produced (new tables, added columns and indexes); both sections are compiled before writing.
 * `signal` is checked before each migration and after the difference is computed; the temporary schema is dropped on every path, and a drop error does not replace the original error. */
type GenerateOptions = { db: Management; options: BetterAuthOptions; name?: string; root?: string; now?: Date; registry?: Registry; signal?: AbortSignal };
export async function generateAuthMigration({ db: m, options, name = "better_auth", root, now, registry = packageRegistry, signal }: GenerateOptions) {
  const schema = `auth_generate_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const dropSchema = () => m.db.exec(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
  await m.db.exec(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const stop = () => {
    if (signal?.aborted) throw cancelled();
  };
  async function generate() {
    // CREATE INDEX CONCURRENTLY does not run inside a transaction: like the runner, it is executed directly on the pool.
    for (const migration of registry.migrations) {
      stop();
      for (const statement of migration.up.bind(schema)) await (migration.concurrentIndex ? m.db.pool.exec(statement) : m.db.exec(statement));
    }
    const diff = await authSchemaDiff(m, options, { schema });
    stop();
    // A type mismatch cannot be fixed automatically with SQL (a data conversion is needed): writing a file would hide it.
    if (diff.typeMismatches.length)
      throw new AppError("INVALID_CONFIG", `Better Auth columns have unexpected types: ${diff.typeMismatches.map((x) => `${x.table}.${x.column} (${x.actual}, expected ${x.expected})`).join(", ")}`);
    if (!diff.sql) return { created: false as const };
    const down = downMigration(diff);
    prepareMigration(diff.sql);
    prepareMigration(down);
    return { created: true as const, ...(await createMigration({ name, root, now, source: `--up\n${diff.sql}\n\n--down\n${down}\n` })) };
  }
  const result = await generate().catch(async (error: unknown) => {
    await dropSchema().catch(() => {});
    throw error;
  });
  await dropSchema();
  return result;
}
