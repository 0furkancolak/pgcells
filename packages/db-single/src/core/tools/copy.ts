/** Reads the schema from a snapshot and rebuilds it on the target; backup/restore use this. Data is moved as driver-independent bulk JSON
 * (Bun SQL does not support COPY): `row_to_json` through a cursor on the source, `json_populate_recordset` on the target. Only tables,
 * sequences and enums that can be reproduced exactly are supported. */
import { type ExprCall, parse } from "pgsql-ast-parser";
import { ENUMS_SQL, notExtensionMember } from "../catalog";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { qualified, quoteIdentifier } from "../identifier";
import { prepareQuery } from "../sql/compiler";
import { canonicalTypes, literal } from "./pull";

/** Row count; a single batch is one `json` parameter. */
const BATCH_ROWS = 500;
const LOCK_TIMEOUT_MS = 1000;

const unsupported = (message: string) => new AppError("UNSUPPORTED_SCHEMA", message);

export const SNAPSHOT_MODE = " ISOLATION LEVEL REPEATABLE READ READ ONLY";

/** Transaction settings for a long read: statement timeout, a short lock timeout and a read-only repeatable-read snapshot. */
export const snapshotTransaction = (timeoutMs: number) => ({ statementTimeoutMs: timeoutMs, lockTimeoutMs: LOCK_TIMEOUT_MS, mode: SNAPSHOT_MODE });

/** Yields the result of `selectSql` from a cursor in the open transaction in groups of `batchRows`. Cancellation is checked
 * before every FETCH. The cursor is closed only when read to the end; if interrupted it closes along with the transaction. */
export async function* streamCursor<R>(db: Connection, cursorName: string, selectSql: string, batchRows: number, signal?: AbortSignal): AsyncGenerator<R[]> {
  await db.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${selectSql}`);
  for (;;) {
    signal?.throwIfAborted();
    const rows = await db.query<R>(`FETCH FORWARD ${batchRows} FROM ${cursorName}`);
    if (!rows.length) break;
    yield rows;
  }
  await db.exec(`CLOSE ${cursorName}`);
}

const CANONICAL_FORMAT = `SELECT pg_catalog.set_config('TimeZone','UTC',true),
  pg_catalog.set_config('DateStyle','ISO, YMD',true),
  pg_catalog.set_config('IntervalStyle','postgres',true),
  pg_catalog.set_config('extra_float_digits','3',true)`;

/** A session-independent text format for catalog expressions and row values (transaction-local). */
const useCanonicalFormat = (db: Connection) => db.query(CANONICAL_FORMAT);

/** Built-in names must resolve from `pg_catalog` first. The schema may be on the name-resolution path (`public`): unqualified references to that schema
 * in catalog text are explicitly bound to the target schema by `retarget`. */
async function verifyCatalogResolution(db: Connection) {
  const [row] = await db.query<{ safe: boolean }>("SELECT (pg_catalog.current_schemas(true))[1]='pg_catalog' AS safe");
  if (!row?.safe) throw unsupported("Management roles must resolve builtin catalog names first");
}

// ---- Schema shape: read from the catalog, rebuilt as DDL ---------------

/** Catalog rows selected in `readSchema` (text columns; `identity`/`generated` are pg_attribute codes). `enum`: the column's
 * (or, if `array`, its element's) enum of the copied schema; the type is bound to the target schema. */
type Column = Record<"name" | "type" | "identity" | "generated", string> & {
  table?: string;
  notNull: boolean;
  expression: string | null;
  sequence: string | null;
  collation?: string | null;
  enum?: string | null;
  array?: boolean;
};
/** `reference`: the `regtype` text of the reading session (as it appears in catalog expressions); `labels`: a JSON array of the ordered labels. */
type Enum = Record<"name" | "reference" | "labels", string>;
type Sequence = Record<"name" | "type" | "start" | "increment" | "min" | "max" | "cache", string> & {
  reference?: string;
  cycle: boolean;
  identity?: boolean;
  table?: string | null;
  column?: string | null;
};

const isCatalogSchema = (schema?: string) => !schema || schema === "pg_catalog";

/** A function that converts local enum casts in catalog text (`'a'::status`, `'{a}'::app.status[]`) to the type `to(name)` (the pattern is built
 * once per shape). Quoted strings and names are skipped; the name must not continue after the reference (`status` must not catch `statuses`). */
export function enumCasts(enums: readonly Pick<Enum, "name" | "reference">[], to: (name: string) => string) {
  if (!enums.length) return (sql: string) => sql;
  const names = new Map(enums.map((e) => [e.reference, e.name]));
  const references = [...names.keys()].map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`'(?:[^']|'')*'|"(?:[^"]|"")*"|::(${references})(?=$|[\\s,:)[\\]])`, "g");
  return (sql: string) => sql.replace(pattern, (token, reference?: string) => (reference === undefined ? token : `::${to(names.get(reference) ?? reference)}`));
}

/** `nextval('name'::regclass)`: a single argument, a catalog function and a literal early-bound reference to a copied sequence. */
function isLocalSequenceReference(call: ExprCall, sequences: ReadonlySet<string>): boolean {
  const arg = call.args[0];
  return (
    call.args.length === 1 &&
    isCatalogSchema(call.function.schema) &&
    arg?.type === "cast" &&
    arg.operand.type === "string" &&
    arg.to.kind !== "array" &&
    arg.to.name === "regclass" &&
    isCatalogSchema(arg.to.schema) &&
    sequences.has(arg.operand.value)
  );
}

/** A sequence default must be a literal, early-bound reference to a copied sequence; other expressions must fit the safe subset of the runtime
 * compiler (only checked, not executed). `asText`: casts to copied enums are checked as `text`. */
export function validateDefault(expression: string, sequences: ReadonlySet<string>, asText = (sql: string) => sql): void {
  try {
    // The catalog writes long type names (`character varying`, `timestamp with time zone`); the parser/compiler knows the short names.
    // Only the validation input is canonicalized: the DDL that is built carries the catalog's own text.
    const source = `SELECT ${canonicalTypes(asText(expression))}`;
    const statement = parse(source)[0];
    const value = statement?.type === "select" ? statement.columns?.[0]?.expr : undefined;
    if (value?.type !== "call" || value.function.name !== "nextval") {
      prepareQuery(source);
      return;
    }
    if (!isLocalSequenceReference(value, sequences)) throw new Error("Unsupported sequence reference");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid expression";
    throw unsupported(`Default/generated expression needs supported builtins and explicit local sequence references: ${detail}`);
  }
}

export function columnDefinition(schema: string, column: Column): string {
  const type = column.enum ? `${qualified(schema, column.enum)}${column.array ? "[]" : ""}` : column.type;
  let definition = `${quoteIdentifier(column.name)} ${type}`;
  if (column.collation) definition += ` COLLATE ${column.collation}`;
  if (column.identity) {
    if (!column.sequence) throw unsupported("Identity sequence missing");
    definition += ` GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY (SEQUENCE NAME ${qualified(schema, column.sequence)})`;
  } else if (column.generated) {
    if (column.generated !== "s" || !column.expression) throw unsupported("Unsupported generated column");
    definition += ` GENERATED ALWAYS AS (${column.expression}) STORED`;
  } else if (column.expression !== null) definition += ` DEFAULT ${column.expression}`;
  return column.notNull ? `${definition} NOT NULL` : definition;
}

export function sequenceDefinition(schema: string, sequence: Sequence, alter = false): string {
  const { start, increment, min, max, cache } = sequence;
  if (!["smallint", "integer", "bigint"].includes(sequence.type) || ![start, increment, min, max, cache].every((v) => /^-?\d+$/.test(v)))
    throw unsupported("Invalid sequence metadata");
  return `${alter ? "ALTER" : "CREATE"} SEQUENCE ${qualified(schema, sequence.name)} AS ${sequence.type} INCREMENT BY ${increment} MINVALUE ${min} MAXVALUE ${max} START WITH ${start} CACHE ${cache} ${sequence.cycle ? "CYCLE" : "NO CYCLE"}`;
}

/** At most this many object names appear in a message; the rest becomes "and N more" (a schema with hundreds of enums must not bloat the message). */
const LISTED_OBJECTS = 20;
const listed = (relation: string, where = "") =>
  `(SELECT pg_catalog.string_agg(name,', ' ORDER BY name) FILTER (WHERE i<=${LISTED_OBJECTS})||COALESCE(CASE WHEN max(i)>${LISTED_OBJECTS} THEN ' and '||(max(i)-${LISTED_OBJECTS})||' more' END,'')
    FROM (SELECT name,row_number() OVER (ORDER BY name) AS i FROM ${relation} ${where}) numbered)`;

/** Each rule is a (violation, message, objects) triple; `$1` is the schema. The backup rejects what it cannot reproduce exactly; the message names the blocking relations,
 * routines and types, or `table.column`s. */
const SHAPE_RULES = `WITH relations AS (
    SELECT pg_catalog.quote_ident(c.relname) AS name,
      (c.relkind NOT IN ('r','S') OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.reloptions IS NOT NULL
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid)) AS bad
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t') AND ${notExtensionMember("pg_class", "c")}),
  enums AS (SELECT t.oid FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=$1 AND t.typtype='e' AND ${notExtensionMember("pg_type", "t")}),
  custom AS (
    SELECT 'routine '||pg_catalog.quote_ident(p.proname) AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=$1 AND ${notExtensionMember("pg_proc", "p")}
    UNION ALL SELECT 'type '||pg_catalog.quote_ident(t.typname) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=$1 AND t.typtype NOT IN ('c','e') AND t.typelem=0 AND ${notExtensionMember("pg_type", "t")}),
  -- An index expression/predicate may cast only to built-in types and the copied enums (or arrays of them) (extension tables excluded).
  index_casts AS (SELECT DISTINCT pg_catalog.quote_ident(c.relname) AS name FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=c.oid AND d.refclassid='pg_catalog.pg_type'::pg_catalog.regclass
      JOIN pg_catalog.pg_type t ON t.oid=d.refobjid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
      JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid JOIN pg_catalog.pg_class r ON r.oid=i.indrelid
    WHERE n.nspname=$1 AND tn.nspname<>'pg_catalog' AND COALESCE(NULLIF(t.typelem,0),t.oid) NOT IN (SELECT oid FROM enums)
      AND ${notExtensionMember("pg_class", "r")}),
  columns AS (
    SELECT pg_catalog.quote_ident(c.relname)||'.'||pg_catalog.quote_ident(a.attname) AS name
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid
      JOIN pg_catalog.pg_namespace tn ON tn.oid=typ.typnamespace
      LEFT JOIN pg_catalog.pg_type element ON element.oid=typ.typelem
      LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation
      LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND ${notExtensionMember("pg_class", "c")}
      AND (cn.nspname<>'pg_catalog' OR COALESCE(element.oid,typ.oid) NOT IN (SELECT oid FROM enums) AND (tn.nspname<>'pg_catalog'
        OR COALESCE(element.typname,typ.typname) NOT IN ('bool','int2','int4','int8','float4','float8','numeric','text','varchar',
          'bpchar','bytea','uuid','json','jsonb','date','time','timetz','timestamp','timestamptz','interval',
          'inet','cidr','macaddr','tsvector','tsquery','int4range','int8range','numrange','tsrange','tstzrange','daterange'))))
  SELECT message||COALESCE(': '||objects,'') AS message FROM (VALUES
    (NOT EXISTS(SELECT 1 FROM relations), 'Schema is missing or empty', NULL),
    (EXISTS(SELECT 1 FROM relations WHERE bad),
     'Backup supports persistent ordinary tables and sequences without policies, rules, triggers or inheritance',
     ${listed("relations", "WHERE bad")}),
    (EXISTS(SELECT 1 FROM index_casts), 'Indexes may cast only to builtin types and the copied enums', ${listed("index_casts")}),
    (EXISTS(SELECT 1 FROM custom)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace
        JOIN pg_catalog.pg_class referenced ON referenced.oid=c.confrelid
        WHERE n.nspname=$1 AND referenced.relnamespace<>c.connamespace),
     'Custom schema routines/types or cross-schema foreign keys are not supported',
     ${listed("custom")}),
    (EXISTS(SELECT 1 FROM columns), 'Only portable builtin column types and catalog collations are supported',
     ${listed("columns")}),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_proc p ON d.refclassid='pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid=p.oid
        JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
        WHERE pn.nspname<>'pg_catalog'
          AND (d.objid IN (SELECT a.oid FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid=a.adrelid
                JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)
            OR d.objid IN (SELECT co.oid FROM pg_catalog.pg_constraint co JOIN pg_catalog.pg_namespace n ON n.oid=co.connamespace
                WHERE n.nspname=$1)
            OR d.objid IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname=$1))),
     'Custom routines in defaults, constraints or indexes are unsupported', NULL),
    ((WITH objects AS (
        SELECT 'pg_catalog.pg_class'::pg_catalog.regclass AS classid,c.oid AS objid FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
        UNION ALL SELECT 'pg_catalog.pg_attrdef'::pg_catalog.regclass,a.oid FROM pg_catalog.pg_attrdef a
          JOIN pg_catalog.pg_class c ON c.oid=a.adrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
        UNION ALL SELECT 'pg_catalog.pg_constraint'::pg_catalog.regclass,c.oid FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1)
      SELECT EXISTS(SELECT 1 FROM objects o JOIN pg_catalog.pg_depend d ON d.classid=o.classid AND d.objid=o.objid
        LEFT JOIN pg_catalog.pg_operator op ON d.refclassid='pg_catalog.pg_operator'::pg_catalog.regclass AND d.refobjid=op.oid
        LEFT JOIN pg_catalog.pg_opclass oc ON d.refclassid='pg_catalog.pg_opclass'::pg_catalog.regclass AND d.refobjid=oc.oid
        LEFT JOIN pg_catalog.pg_collation coll ON d.refclassid='pg_catalog.pg_collation'::pg_catalog.regclass AND d.refobjid=coll.oid
        JOIN pg_catalog.pg_namespace n ON n.oid=COALESCE(op.oprnamespace,oc.opcnamespace,coll.collnamespace)
        WHERE n.nspname<>'pg_catalog')),
     'Custom operators, index operator classes and collations are not supported', NULL),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co
        JOIN pg_catalog.pg_class a ON a.oid=co.conrelid JOIN pg_catalog.pg_namespace an ON an.oid=a.relnamespace
        JOIN pg_catalog.pg_class b ON b.oid=co.confrelid JOIN pg_catalog.pg_namespace bn ON bn.oid=b.relnamespace
        WHERE co.contype='f' AND (an.nspname=$1 OR bn.nspname=$1) AND an.oid<>bn.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_sequence sq JOIN pg_catalog.pg_class c ON c.oid=sq.seqrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
        JOIN pg_catalog.pg_class owner ON owner.oid=d.refobjid
        WHERE n.nspname=$1 AND owner.relnamespace<>n.oid),
     'Foreign keys and sequence ownership must remain within the copied schema', NULL),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT i.indisvalid),
     'Repair invalid indexes before taking a backup', NULL)
  ) AS rules(violated, message, objects) WHERE violated`;

const TABLES_SQL = `SELECT c.relname AS name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND c.relkind='r' AND ${notExtensionMember("pg_class", "c")} ORDER BY c.relname`;

const COLUMNS_SQL = `SELECT c.relname AS table,a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS "notNull",a.attidentity AS identity,a.attgenerated AS generated,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS expression,
    (SELECT seq.relname FROM pg_catalog.pg_class seq
      JOIN pg_catalog.pg_depend dep ON dep.objid=seq.oid AND dep.classid='pg_catalog.pg_class'::pg_catalog.regclass
      WHERE seq.relkind='S' AND dep.refobjid=c.oid AND dep.refobjsubid=a.attnum AND dep.deptype IN ('a','i') LIMIT 1) AS sequence,
    CASE WHEN a.attcollation<>0 AND a.attcollation<>typ.typcollation
      THEN pg_catalog.quote_ident(cn.nspname)||'.'||pg_catalog.quote_ident(coll.collname) END AS collation,
    CASE WHEN COALESCE(element.typtype,typ.typtype)='e' THEN COALESCE(element.typname,typ.typname) END AS enum,typ.typelem<>0 AS array
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid
  LEFT JOIN pg_catalog.pg_type element ON element.oid=typ.typelem
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
  WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND ${notExtensionMember("pg_class", "c")}
  ORDER BY c.relname,a.attnum`;

const SEQUENCES_SQL = `SELECT c.oid::pg_catalog.regclass::text AS reference,c.relname AS name,pg_catalog.format_type(s.seqtypid,NULL) AS type,
    s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmin::text AS min,s.seqmax::text AS max,
    s.seqcache::text AS cache,s.seqcycle AS cycle,(dep.deptype='i') AS identity,owner.relname AS table,a.attname AS column
  FROM pg_catalog.pg_sequence s
  JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_depend dep ON dep.classid='pg_catalog.pg_class'::pg_catalog.regclass AND dep.objid=c.oid AND dep.deptype IN ('a','i')
  LEFT JOIN pg_catalog.pg_class owner ON owner.oid=dep.refobjid
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=dep.refobjid AND a.attnum=dep.refobjsubid
  WHERE n.nspname=$1 AND ${notExtensionMember("pg_class", "c")} ORDER BY c.relname`;

const CONSTRAINTS_SQL = `SELECT c.relname AS table,co.conname AS name,co.contype AS kind,
    pg_catalog.pg_get_expr(co.conbin,co.conrelid) AS expression,pg_catalog.pg_get_constraintdef(co.oid) AS definition,
    r.oid::pg_catalog.regclass::text AS referenced,r.relname AS "referencedTable"
  FROM pg_catalog.pg_constraint co
  JOIN pg_catalog.pg_class c ON c.oid=co.conrelid
  LEFT JOIN pg_catalog.pg_class r ON r.oid=co.confrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=co.connamespace
  WHERE n.nspname=$1 AND ${notExtensionMember("pg_class", "c")} ORDER BY co.conname`;

const INDEXES_SQL = `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
    pg_catalog.quote_ident(n.nspname)||'.'||pg_catalog.quote_ident(t.relname) AS relation,t.relname AS table
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  JOIN pg_catalog.pg_class t ON t.oid=i.indrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND ${notExtensionMember("pg_class", "t")} AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co WHERE co.conindid=i.indexrelid AND co.contype IN ('p','u','x'))
  ORDER BY c.relname`;

/** Reads self-contained ordinary tables and sequences (with their current state); unsupported metadata fails before any DDL
 * runs on the target. Run it inside the same snapshot transaction that also reads the rows. */
export async function readSchema(db: Connection, schema: string) {
  await verifyCatalogResolution(db);
  await useCanonicalFormat(db);
  const violations = await db.query<{ message: string }>(SHAPE_RULES, [schema]);
  if (violations.length) throw unsupported(violations.map(({ message }) => message).join("; "));

  const read = <R>(sql: string) => db.query<R>(sql, [schema]);
  const enums = await read<Enum>(ENUMS_SQL);
  const tables = await read<{ name: string }>(TABLES_SQL);
  const columns = await read<Column>(COLUMNS_SQL);
  const sequences = await read<Sequence>(SEQUENCES_SQL);
  const constraints = await read<{ table: string; name: string; kind: string; definition: string; expression: string | null; referenced: string | null; referencedTable: string | null }>(
    CONSTRAINTS_SQL,
  );
  const indexes = await read<{ definition: string; relation: string; table: string }>(INDEXES_SQL);
  const references = new Set(sequences.map((s) => s.reference ?? ""));
  const asText = enumCasts(enums, () => "text");
  for (const { expression } of columns) if (expression) validateDefault(expression, references, asText);
  for (const { expression } of constraints) if (expression) validateDefault(expression, new Set(), asText);
  const states: SequenceState[] = [];
  for (const sequence of sequences) {
    const [state] = await db.query<SequenceState>(`SELECT $1::text AS name,last_value::text AS "lastValue",is_called AS "isCalled" FROM ${qualified(schema, sequence.name)}`, [sequence.name]);
    if (!state) throw new AppError("COPY_FAILED", "Sequence state unavailable");
    states.push(state);
  }
  return { enums, tables, columns, sequences, constraints, indexes, states };
}
type SequenceState = { name: string; lastValue: string; isCalled: boolean };
/** The shape of enums, tables and sequences that can be rebuilt exactly; stored in `backup.json` in a backup. */
export type SchemaShape = Awaited<ReturnType<typeof readSchema>>;

const SERVER_FACTS_SQL = `SELECT pg_catalog.current_setting('server_version_num')::integer/10000 AS major,
  (SELECT pg_catalog.row_to_json(d)::text FROM (
    SELECT encoding,datcollate,datctype,datlocprovider,daticulocale,datcollversion,
      pg_catalog.pg_database_collation_actual_version(oid) AS actual_version
    FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) d) AS locale,
  COALESCE((SELECT pg_catalog.json_agg(extname||'@'||extversion)::text FROM pg_catalog.pg_extension),'[]') AS extensions`;

/** Server facts: for an exact copy the major version, locale/collation and extensions must match. A backup writes this to `backup.json`. */
export type ServerFacts = { major: number; locale: string; extensions: string };
export async function serverFacts(db: Pick<Connection, "query">): Promise<ServerFacts> {
  const [facts] = await db.query<ServerFacts>(SERVER_FACTS_SQL);
  if (!facts) throw new AppError("COPY_FAILED", "Server facts unavailable");
  return facts;
}

/** Server facts that must match for an exact copy (the source's extensions must exist on the target). */
export function assertCompatible(from: ServerFacts, to: ServerFacts): void {
  if (from.major !== to.major) throw new AppError("VERSION_MISMATCH", "Source and target PostgreSQL major versions must match");
  if (from.locale !== to.locale) throw new AppError("COLLATION_MISMATCH", "Source and target database encoding, locale and collation versions must match");
  const available = new Set<string>(JSON.parse(to.extensions));
  if ((JSON.parse(from.extensions) as string[]).some((e) => !available.has(e))) throw new AppError("EXTENSION_MISMATCH", "Target extension versions differ");
}

/** `row_to_json` row text (one JSON object per row) → the table's stored columns. */
export function insertRows(to: Connection, relation: string, stored: readonly string[], rows: readonly string[]) {
  return to.query(
    `INSERT INTO ${relation} (${stored}) OVERRIDING SYSTEM VALUE SELECT ${stored} FROM pg_catalog.json_populate_recordset(NULL::${relation},$1::text::json)`,
    [`[${rows.join(",")}]`],
  );
}

/** Streams the table's rows from a cursor as `row_to_json` text batches; the snapshot transaction belongs to the caller. */
export async function readRows(from: Connection, relation: string, onBatch: (rows: string[]) => Promise<void>, signal?: AbortSignal) {
  let count = 0;
  const select = `SELECT pg_catalog.row_to_json(t)::text AS row FROM ${relation} t`;
  for await (const rows of streamCursor<{ row: string }>(from, "copy_rows", select, BATCH_ROWS, signal)) {
    count += rows.length;
    await onBatch(rows.map((r) => r.row));
  }
  return count;
}

/** Explicitly binds the source schema reference in catalog text to `name` in the target schema; a backup can also be restored under a different schema name.
 * The reference is in the form the catalog writes (`regclass` text: unqualified if the schema is on the name-resolution path, e.g. `public`; always
 * qualified in an index definition) and is searched with its delimiters (`users` must not catch the start of `users_id_seq`). */
const retarget = (sql: string, [before, reference, after]: readonly [string, string, string], schema: string, name: string) =>
  sql.replace(`${before}${reference}${after}`, () => `${before}${qualified(schema, name)}${after}`);

/** `fill(relation, stored columns, table)` loads each table's rows between table creation and the constraints. */
export type FillTable = (relation: string, stored: string[], table: string) => Promise<void>;

/** Builds `schema` from `shape` in the caller's target transaction: enums, sequences, tables, rows (`fill`), keys,
 * indexes, foreign keys and sequence state. Cancellation is checked between statements. */
export async function buildSchema(to: Connection, schema: string, shape: SchemaShape, fill: FillTable, signal?: AbortSignal) {
  const run = async (sql: string) => {
    signal?.throwIfAborted();
    await to.exec(sql);
  };
  await verifyCatalogResolution(to);
  await useCanonicalFormat(to);
  await run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
  // The reference is inside a literal in the catalog text: the quote is written twice (`'"it''s"'::regclass`).
  const inLiteral = (text: string) => text.replaceAll("'", "''");
  const localSequences = (expression: string) =>
    shape.sequences.reduce((sql, s) => sql.replace(`'${inLiteral(s.reference ?? "")}'::regclass`, () => `'${inLiteral(qualified(schema, s.name))}'::regclass`), expression);
  // Older backups without an `enums` field are also restored.
  const enums = shape.enums ?? [];
  const localEnums = enumCasts(enums, (name) => qualified(schema, name));
  for (const e of enums) await run(`CREATE TYPE ${qualified(schema, e.name)} AS ENUM (${(JSON.parse(e.labels) as string[]).map(literal).join(", ")})`);
  // Identity sequences are created with their columns, then altered to match.
  for (const sequence of shape.sequences) if (!sequence.identity) await run(sequenceDefinition(schema, sequence));
  for (const table of shape.tables) {
    const columns = shape.columns.filter((c) => c.table === table.name).map((c) => columnDefinition(schema, { ...c, expression: c.expression && localEnums(localSequences(c.expression)) }));
    await run(`CREATE TABLE ${qualified(schema, table.name)} (${columns.join(", ")})`);
  }
  for (const sequence of shape.sequences) if (sequence.identity) await run(sequenceDefinition(schema, sequence, true));

  for (const table of shape.tables) {
    const stored = shape.columns.filter((c) => c.table === table.name && !c.generated).map((c) => quoteIdentifier(c.name));
    if (!stored.length) throw unsupported("Tables need at least one stored non-generated column");
    await fill(qualified(schema, table.name), stored, table.name);
  }

  // Keys and indexes come before foreign keys; loading the data first allows dependency cycles.
  const addConstraints = async (foreign: boolean) => {
    for (const c of shape.constraints)
      if ((c.kind === "f") === foreign) {
        const definition = c.referenced && c.referencedTable ? retarget(c.definition, [" REFERENCES ", c.referenced, "("], schema, c.referencedTable) : c.definition;
        await run(`ALTER TABLE ${qualified(schema, c.table)} ADD CONSTRAINT ${quoteIdentifier(c.name)} ${localEnums(definition)}`);
      }
  };
  await addConstraints(false);
  for (const index of shape.indexes) await run(localEnums(retarget(index.definition, [" ON ", index.relation, " USING "], schema, index.table)));
  await addConstraints(true);

  for (const sequence of shape.sequences) {
    const name = qualified(schema, sequence.name);
    const state = shape.states.find((s) => s.name === sequence.name);
    if (!state) throw new AppError("COPY_FAILED", "Sequence state unavailable");
    await to.query("SELECT pg_catalog.setval($1::pg_catalog.regclass,$2::pg_catalog.int8,$3::boolean)", [name, state.lastValue, state.isCalled]);
    if (!sequence.identity && sequence.table && sequence.column)
      await run(`ALTER SEQUENCE ${name} OWNED BY ${qualified(schema, sequence.table)}.${quoteIdentifier(sequence.column)}`);
  }
  signal?.throwIfAborted();
}
