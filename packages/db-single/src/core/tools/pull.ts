/** `pull`: reads the structure of an existing schema from the catalog and writes a single initial migration. Definitions are read with `pg_get_*def`;
 * the schema qualifications in the definitions are removed by the compiler and names resolve to the bound schema. The output is
 * deterministic (name order), so two schemas with the same structure give the same text and the same structure digest. */
import { ENUMS_SQL, notExtensionMember } from "../catalog";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { quoteIdentifier, validateSchema } from "../identifier";
import type { Management } from "../management";
import { checksum, compileMigrations, MIGRATION_NAME, migrationPrefix } from "../migrations/source";
import { unqualifyMigration } from "../sql/compiler";

/** The package's ledgers and the old application's Drizzle ledger are always left out; `exclude` is added to these. */
const ALWAYS_EXCLUDED = ["_migrations", "_seeds", "drizzle_migrations"];

export interface PulledStructure {
  /** SQL without a schema, as accepted by the compiler (no header). */
  sql: string;
  /** The sha256 digest of the `sql` text. */
  structure: string;
  /** Tables left out (sorted). */
  exclude: string[];
  counts: { enums: number; tables: number; constraints: number; indexes: number };
}

type Unsupported = { kind: string; name: string };
type EnumRow = { name: string; labels: string };
type ColumnRow = {
  table_name: string;
  column_name: string;
  type: string;
  not_null: boolean;
  default_expr: string | null;
  identity: string;
  collation: string | null;
  seq_name: string | null;
  seq_start: string | null;
  seq_increment: string | null;
  seq_min: string | null;
  seq_max: string | null;
  seq_cache: string | null;
  seq_cycle: boolean | null;
};
type ConstraintRow = { table_name: string; name: string; kind: string; def: string };
type IndexRow = { name: string; def: string };

const IN_EXCLUDED = "IN (SELECT pg_catalog.jsonb_array_elements_text($2::text::jsonb))";
const NAMESPACE = "(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1)";
/** A relation (`c`) of the schema that does not belong to an extension: an extension's objects are not written to the migration and do not block pull. */
const OWN_RELATION = `c.relnamespace=${NAMESPACE} AND ${notExtensionMember("pg_class", "c")}`;

/** Objects the initial migration cannot express; if there is even one, pull is rejected (an incomplete migration is never silently written). */
const UNSUPPORTED_SQL = `SELECT kind, name FROM (
  SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'p' THEN 'partitioned table' WHEN 'f' THEN 'foreign table'
    WHEN 'c' THEN 'composite type' ELSE 'relation kind ' || c.relkind::text END AS kind, c.relname::text AS name
    FROM pg_catalog.pg_class c WHERE ${OWN_RELATION} AND c.relkind NOT IN ('r','i','S','t')
  UNION ALL SELECT 'sequence', c.relname::text FROM pg_catalog.pg_class c WHERE ${OWN_RELATION} AND c.relkind='S'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid=d.refobjid
      WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_class'::regclass
      AND (d.deptype='i' OR (d.deptype='a' AND t.relname ${IN_EXCLUDED})))
  UNION ALL SELECT 'function', p.proname::text FROM pg_catalog.pg_proc p WHERE p.pronamespace=${NAMESPACE} AND ${notExtensionMember("pg_proc", "p")}
  UNION ALL SELECT 'trigger', c.relname::text || '.' || t.tgname::text FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE ${OWN_RELATION} AND NOT t.tgisinternal AND c.relname NOT ${IN_EXCLUDED}
  UNION ALL SELECT 'policy', c.relname::text || '.' || p.polname::text FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    WHERE ${OWN_RELATION} AND c.relname NOT ${IN_EXCLUDED}
  UNION ALL SELECT 'row level security', c.relname::text FROM pg_catalog.pg_class c
    WHERE ${OWN_RELATION} AND c.relkind='r' AND (c.relrowsecurity OR c.relforcerowsecurity) AND c.relname NOT ${IN_EXCLUDED}
  UNION ALL SELECT 'unlogged or storage parameters', c.relname::text FROM pg_catalog.pg_class c
    WHERE ${OWN_RELATION} AND c.relkind='r' AND (c.relpersistence<>'p' OR c.reloptions IS NOT NULL) AND c.relname NOT ${IN_EXCLUDED}
  UNION ALL SELECT 'inherited table', c.relname::text FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid WHERE ${OWN_RELATION}
  UNION ALL SELECT 'generated column', c.relname::text || '.' || a.attname::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    WHERE ${OWN_RELATION} AND a.attgenerated<>'' AND NOT a.attisdropped
  UNION ALL SELECT 'type', t.typname::text FROM pg_catalog.pg_type t
    WHERE t.typnamespace=${NAMESPACE} AND t.typtype<>'e' AND t.typrelid=0 AND t.typelem=0 AND ${notExtensionMember("pg_type", "t")}
  UNION ALL SELECT 'invalid index', c.relname::text FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    WHERE ${OWN_RELATION} AND NOT i.indisvalid
  UNION ALL SELECT 'constraint type ' || co.contype::text, co.conname::text FROM pg_catalog.pg_constraint co
    WHERE co.connamespace=${NAMESPACE} AND co.contype NOT IN ('p','u','c','f','n')
) found ORDER BY kind, name`;

const COLUMNS_SQL = `SELECT c.relname AS table_name, a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity::text AS identity,
    CASE WHEN a.attcollation<>t.typcollation THEN co.collname END AS collation,
    sc.relname AS seq_name, s.seqstart::text AS seq_start, s.seqincrement::text AS seq_increment, s.seqmin::text AS seq_min,
    s.seqmax::text AS seq_max, s.seqcache::text AS seq_cache, s.seqcycle AS seq_cycle
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
  LEFT JOIN pg_catalog.pg_depend dep ON a.attidentity<>'' AND dep.refclassid='pg_catalog.pg_class'::regclass AND dep.refobjid=c.oid
    AND dep.refobjsubid=a.attnum AND dep.classid='pg_catalog.pg_class'::regclass AND dep.deptype='i'
  LEFT JOIN pg_catalog.pg_class sc ON sc.oid=dep.objid
  LEFT JOIN pg_catalog.pg_sequence s ON s.seqrelid=sc.oid
  WHERE ${OWN_RELATION} AND c.relkind='r' AND c.relname NOT ${IN_EXCLUDED}
  ORDER BY c.relname, a.attnum`;

/** NOT NULL (`n` in PostgreSQL 18) is written on the column; the others with their definition. */
const CONSTRAINTS_SQL = `SELECT c.relname AS table_name, co.conname AS name, co.contype::text AS kind, pg_catalog.pg_get_constraintdef(co.oid) AS def
  FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_class c ON c.oid=co.conrelid
  WHERE ${OWN_RELATION} AND co.contype IN ('p','u','c','f') AND c.relname NOT ${IN_EXCLUDED}
  ORDER BY c.relname, pg_catalog.array_position(ARRAY['p','u','c','f'], co.contype::text), co.conname`;

/** A constraint's own index (PK/UNIQUE) is written with the constraint. */
const INDEXES_SQL = `SELECT ic.relname AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS def
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
  WHERE ${OWN_RELATION} AND c.relkind='r' AND c.relname NOT ${IN_EXCLUDED}
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint co WHERE co.conindid=i.indexrelid AND co.conrelid=i.indrelid AND co.contype IN ('p','u'))
  ORDER BY c.relname, ic.relname`;

/** `format_type` output → the compiler's canonical spelling (the long time-zone and `character varying` names are not supported). */
export function sqlType(type: string): string {
  const array = /(?:\[\])+$/.exec(type)?.[0] ?? "";
  const base = type.slice(0, type.length - array.length);
  const time = /^(timestamp|time)(\(\d+\))? with(out)? time zone$/.exec(base);
  if (time) return `${time[1]}${time[3] ? "" : "tz"}${time[2] ?? ""}${array}`;
  const sized = /^(character varying|character|double precision)(\([\d,]+\))?$/.exec(base);
  const aliases: Record<string, string> = { "character varying": "varchar", character: "bpchar", "double precision": "float8" };
  if (sized?.[1]) return `${aliases[sized[1]]}${sized[2] ?? ""}${array}`;
  return type;
}

// Quoted strings and identifiers stay as they are; long type names in expressions (cast, CHECK, index) are canonicalized.
const EXPRESSION_TYPES = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\b(?:timestamp|time)(?:\(\d+\))? with(?:out)? time zone\b|\bcharacter varying\b|\bcharacter\b(?:\(\d+\))?|\bdouble precision\b/gi;
export const canonicalTypes = (expression: string) => expression.replace(EXPRESSION_TYPES, (token) => (/^['"]/.test(token) ? token : sqlType(token.toLowerCase())));

/** An E-string is read the same under every `standard_conforming_strings` setting. */
export const literal = (value: string) => `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

function columnSql(column: ColumnRow): string {
  const parts = [`  ${quoteIdentifier(column.column_name)} ${sqlType(column.type)}`];
  if (column.collation) parts.push(`COLLATE ${quoteIdentifier(column.collation)}`);
  if (column.identity) {
    if (!column.seq_name) throw new AppError("PULL_UNSUPPORTED", `${column.table_name}.${column.column_name}: identity sequence not found`);
    const options = [
      `sequence name ${quoteIdentifier(column.seq_name)}`,
      `INCREMENT BY ${column.seq_increment}`,
      `MINVALUE ${column.seq_min}`,
      `MAXVALUE ${column.seq_max}`,
      `START WITH ${column.seq_start}`,
      `CACHE ${column.seq_cache}`,
      ...(column.seq_cycle ? ["CYCLE"] : []),
    ];
    parts.push(`GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY (${options.join(" ")})`);
  }
  if (column.default_expr !== null) parts.push(`DEFAULT ${canonicalTypes(column.default_expr)}`);
  if (column.not_null) parts.push("NOT NULL");
  return parts.join(" ");
}

/** Statements: enums → tables (columns and PK/UNIQUE/CHECK) → foreign keys and NOT VALID constraints → indexes; all in name order. */
function render(enums: EnumRow[], columns: ColumnRow[], constraints: ConstraintRow[], indexes: IndexRow[]): string {
  const statements = enums.map((row) => `CREATE TYPE ${quoteIdentifier(row.name)} AS ENUM (${(JSON.parse(row.labels) as string[]).map(literal).join(", ")});`);
  const tables = new Map<string, string[]>();
  for (const column of columns) tables.set(column.table_name, [...(tables.get(column.table_name) ?? []), columnSql(column)]);
  const inline = (constraint: ConstraintRow) => constraint.kind !== "f" && !/\bNOT VALID$/.test(constraint.def);
  for (const constraint of constraints.filter(inline))
    tables.get(constraint.table_name)?.push(`  CONSTRAINT ${quoteIdentifier(constraint.name)} ${canonicalTypes(constraint.def)}`);
  for (const [table, lines] of tables) statements.push(`CREATE TABLE ${quoteIdentifier(table)} (\n${lines.join(",\n")}\n);`);
  for (const constraint of constraints.filter((row) => !inline(row)))
    statements.push(`ALTER TABLE ${quoteIdentifier(constraint.table_name)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} ${canonicalTypes(constraint.def)};`);
  for (const index of indexes) statements.push(`${canonicalTypes(index.def)};`);
  return statements.length ? `${statements.join("\n\n")}\n` : "";
}

/** The structure of a single schema; if there are unsupported objects, `PULL_UNSUPPORTED` with all of them listed. */
export async function pullStructure(db: Connection, schema: string, exclude: readonly string[] = []): Promise<PulledStructure> {
  try {
    validateSchema(schema);
  } catch {
    throw new AppError("USAGE", "pull needs a plain lower-case schema name other than information_schema and pg_*");
  }
  const excluded = [...new Set([...ALWAYS_EXCLUDED, ...exclude])].sort();
  const params = [schema, JSON.stringify(excluded)];
  const [found] = await db.query<{ found: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=$1) AS found", [schema]);
  if (!found?.found) throw new AppError("SOURCE_SCHEMA_MISSING", `schema ${schema} does not exist`);
  const unsupported = await db.query<Unsupported>(UNSUPPORTED_SQL, params);
  if (unsupported.length)
    throw new AppError("PULL_UNSUPPORTED", `schema ${schema} has objects an initial migration cannot express: ${unsupported.map((row) => `${row.kind} ${row.name}`).join(", ")}`);
  // An enum without labels is not written (a backup copies it; the initial migration only creates enums that have labels).
  const enums = (await db.query<EnumRow>(ENUMS_SQL, [schema])).filter((row) => row.labels !== "[]");
  const columns = await db.query<ColumnRow>(COLUMNS_SQL, params);
  const constraints = await db.query<ConstraintRow>(CONSTRAINTS_SQL, params);
  const indexes = await db.query<IndexRow>(INDEXES_SQL, params);
  const source = render(enums, columns, constraints, indexes);
  let sql: string;
  try {
    sql = unqualifyMigration(source, new Set([schema]), new Set(), new Set()).source;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    throw new AppError("PULL_UNSUPPORTED", `schema ${schema}: ${error.message}`);
  }
  const counts = { enums: enums.length, tables: new Set(columns.map((row) => row.table_name)).size, constraints: constraints.length, indexes: indexes.length };
  return { sql, structure: checksum(sql), exclude: excluded, counts };
}

/** The text of the initial migration: the header names the source, and `--down` is empty (rolling back would delete all data). */
export function pulledMigration({ sql }: PulledStructure, schema: string): string {
  return `--up\n-- Source: schema ${schema}. Do not edit this file; later changes go into a new migration.\n\n${sql}\n--down\n`;
}

export interface PullOptions {
  name?: string;
  exclude?: readonly string[];
  now?: Date;
  root?: string;
}

/** `pull`: reads the structure, validates it with the compiler and writes it as `src/migrations/<time>_<name>.sql` (updates the list). If an error occurs no file is written. */
export async function pullSchema(m: Management, schema: string, { name = "init", exclude = [], now = new Date(), root = "." }: PullOptions = {}) {
  if (!MIGRATION_NAME.test(name)) throw new AppError("USAGE", "Migration name must be snake_case");
  const pulled = await pullStructure(m.db, schema, exclude);
  const source = pulledMigration(pulled, schema);
  compileMigrations([[`${migrationPrefix(now)}_${name}`, source]]);
  const { createMigration } = await import("../sql/codegen");
  const created = await createMigration({ name, now, root, source });
  const next = `bun run db:codegen; on the existing database mark it applied instead of running it (bun run cli migration baseline ${created.id} --schema ${schema}); later changes go into a new migration (bun run db:generate <name>)`;
  return { ...created, schema, ...pulled.counts, structure: pulled.structure, exclude: pulled.exclude, next };
}
