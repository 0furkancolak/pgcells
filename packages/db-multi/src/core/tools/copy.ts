/** Copies a tenant schema from the source snapshot to the target and verifies it with a fingerprint.
 * Data is moved as driver-independent bulk JSON (Bun SQL does not support COPY): `row_to_json` with a cursor on the source,
 * `json_populate_recordset` on the target. Only tables and sequences that can be reproduced exactly are supported. */
import { createHash } from "node:crypto";
import { type ExprCall, parse } from "pgsql-ast-parser";
import type { Database } from "../database";
import type { Connection } from "../driver";
import { AppError } from "../errors";
import { prepareQuery } from "../sql/compiler";
import { qualified, quoteIdentifier, validateSchema } from "../tenants/model";

export { qualified };

/** Row count; one batch is a single `json` parameter. */
const BATCH_ROWS = 500;
const LOCK_TIMEOUT_MS = 1000;
const DEFAULT_COPY_TIMEOUT_MS = 60 * 60 * 1000;

const unsupported = (message: string) => new AppError("UNSUPPORTED_MOVE", message);

export const SNAPSHOT_MODE = " ISOLATION LEVEL REPEATABLE READ READ ONLY";

const transferTimeouts = (timeoutMs: number) => ({ statementTimeoutMs: timeoutMs, lockTimeoutMs: LOCK_TIMEOUT_MS });

/** Transaction settings for a long read: statement timeout, short lock timeout and a read-only repeatable snapshot. */
export const snapshotTransaction = (timeoutMs: number) => ({ ...transferTimeouts(timeoutMs), mode: SNAPSHOT_MODE });

/** Yields the result of `selectSql` from a cursor in the open transaction in groups of `batchRows`. Cancellation is checked before
 * each FETCH. The cursor is closed only when read to the end; if interrupted it closes together with the transaction. */
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

/** Session-independent text format for catalog expressions and row values (transaction-local). */
const useCanonicalFormat = (db: Connection) => db.query(CANONICAL_FORMAT);

async function verifyCatalogResolution(db: Connection, schema: string) {
  const [row] = await db.query<{ safe: boolean }>(
    "SELECT (pg_catalog.current_schemas(true))[1]='pg_catalog' AND NOT ($1=ANY(pg_catalog.current_schemas(false))) AS safe",
    [schema],
  );
  if (!row?.safe) throw unsupported("Management roles must resolve builtin catalog names first and must not implicitly resolve the tenant schema");
}

// ---- Schema shape: read from the catalog, rebuilt as DDL ---------------

/** Catalog rows selected in `readSchema` (text columns; `identity`/`generated` are pg_attribute codes). */
type Column = Record<"name" | "type" | "identity" | "generated", string> & {
  table?: string;
  notNull: boolean;
  expression: string | null;
  sequence: string | null;
  collation?: string | null;
};
type Sequence = Record<"name" | "type" | "start" | "increment" | "min" | "max" | "cache", string> & {
  reference?: string;
  cycle: boolean;
  identity?: boolean;
  table?: string | null;
  column?: string | null;
};

const isCatalogSchema = (schema?: string) => !schema || schema === "pg_catalog";

/** `nextval('name'::regclass)`: a single argument, a catalog function and a literal reference early-bound to a copied sequence. */
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
 * compiler (only checked, not executed). */
export function validateDefault(expression: string, sequences: ReadonlySet<string>): void {
  try {
    const statement = parse(`SELECT ${expression}`)[0];
    const value = statement?.type === "select" ? statement.columns?.[0]?.expr : undefined;
    if (value?.type !== "call" || value.function.name !== "nextval") {
      prepareQuery(`SELECT ${expression}`);
      return;
    }
    if (!isLocalSequenceReference(value, sequences)) throw new Error("Unsupported sequence reference");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid expression";
    throw unsupported(`Default/generated expression needs supported builtins and explicit local sequence references: ${detail}`);
  }
}

export function columnDefinition(schema: string, column: Column): string {
  let definition = `${quoteIdentifier(column.name)} ${column.type}`;
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

/** Each rule is a (violation, message) pair; `$1` is the schema. The copier rejects what it cannot reproduce exactly. */
const SHAPE_RULES = `SELECT message FROM (VALUES
    (NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I','t')
          AND (c.relkind NOT IN ('r','S') OR c.relpersistence<>'p' OR c.relrowsecurity OR c.relforcerowsecurity OR c.reloptions IS NOT NULL
            OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
            OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
            OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid))),
     'Move supports persistent ordinary tables and sequences without policies, rules, triggers or inheritance'),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname=$1 AND t.typtype NOT IN ('c') AND t.typelem=0)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace
        JOIN pg_catalog.pg_class referenced ON referenced.oid=c.confrelid
        WHERE n.nspname=$1 AND referenced.relnamespace<>c.connamespace),
     'Custom schema routines/types or cross-schema foreign keys require a dedicated mover'),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid
        JOIN pg_catalog.pg_namespace tn ON tn.oid=typ.typnamespace
        LEFT JOIN pg_catalog.pg_type element ON element.oid=typ.typelem
        LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation
        LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
        WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
          AND (tn.nspname<>'pg_catalog' OR cn.nspname<>'pg_catalog'
            OR COALESCE(element.typname,typ.typname) NOT IN ('bool','int2','int4','int8','float4','float8','numeric','text','varchar',
              'bpchar','bytea','uuid','json','jsonb','date','time','timetz','timestamp','timestamptz','interval',
              'inet','cidr','macaddr','tsvector','tsquery','int4range','int8range','numrange','tsrange','tstzrange','daterange'))),
     'Only portable builtin column types and catalog collations are supported'),
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
     'Custom routines in defaults, constraints or indexes are unsupported'),
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
     'Custom operators, index operator classes and collations require a dedicated mover'),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co
        JOIN pg_catalog.pg_class a ON a.oid=co.conrelid JOIN pg_catalog.pg_namespace an ON an.oid=a.relnamespace
        JOIN pg_catalog.pg_class b ON b.oid=co.confrelid JOIN pg_catalog.pg_namespace bn ON bn.oid=b.relnamespace
        WHERE co.contype='f' AND (an.nspname=$1 OR bn.nspname=$1) AND an.oid<>bn.oid)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_sequence sq JOIN pg_catalog.pg_class c ON c.oid=sq.seqrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
        JOIN pg_catalog.pg_class owner ON owner.oid=d.refobjid
        WHERE n.nspname=$1 AND owner.relnamespace<>n.oid),
     'Foreign keys and sequence ownership must remain within the copied schema'),
    (EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT i.indisvalid),
     'Repair invalid indexes before moving')
  ) AS rules(violated, message) WHERE violated`;

const TABLES_SQL = `SELECT c.relname AS name
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`;

const COLUMNS_SQL = `SELECT c.relname AS table,a.attname AS name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS "notNull",a.attidentity AS identity,a.attgenerated AS generated,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS expression,
    (SELECT seq.relname FROM pg_catalog.pg_class seq
      JOIN pg_catalog.pg_depend dep ON dep.objid=seq.oid AND dep.classid='pg_catalog.pg_class'::pg_catalog.regclass
      WHERE seq.relkind='S' AND dep.refobjid=c.oid AND dep.refobjsubid=a.attnum AND dep.deptype IN ('a','i') LIMIT 1) AS sequence,
    CASE WHEN a.attcollation<>0 AND a.attcollation<>typ.typcollation
      THEN pg_catalog.quote_ident(cn.nspname)||'.'||pg_catalog.quote_ident(coll.collname) END AS collation
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_type typ ON typ.oid=a.atttypid
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
  WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
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
  WHERE n.nspname=$1 ORDER BY c.relname`;

const CONSTRAINTS_SQL = `SELECT c.relname AS table,co.conname AS name,co.contype AS kind,
    pg_catalog.pg_get_expr(co.conbin,co.conrelid) AS expression,pg_catalog.pg_get_constraintdef(co.oid) AS definition
  FROM pg_catalog.pg_constraint co
  JOIN pg_catalog.pg_class c ON c.oid=co.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=co.connamespace
  WHERE n.nspname=$1 ORDER BY co.conname`;

const INDEXES_SQL = `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_catalog.pg_index i
  JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint co WHERE co.conindid=i.indexrelid AND co.contype IN ('p','u','x'))
  ORDER BY c.relname`;

/** Reads the self-contained ordinary tables and sequences (with their current state); unsupported metadata raises an error before DDL
 * runs on the target. Run it inside the snapshot transaction that also reads the rows. */
export async function readSchema(db: Connection, schema: string) {
  await verifyCatalogResolution(db, schema);
  await useCanonicalFormat(db);
  const [violation] = await db.query<{ message: string }>(SHAPE_RULES, [schema]);
  if (violation) throw unsupported(violation.message);

  const read = <R>(sql: string) => db.query<R>(sql, [schema]);
  const tables = await read<{ name: string }>(TABLES_SQL);
  const columns = await read<Column>(COLUMNS_SQL);
  const sequences = await read<Sequence>(SEQUENCES_SQL);
  const constraints = await read<{ table: string; name: string; kind: string; definition: string; expression: string | null }>(CONSTRAINTS_SQL);
  const indexes = await read<{ definition: string }>(INDEXES_SQL);
  const references = new Set(sequences.map((s) => s.reference ?? ""));
  for (const { expression } of columns) if (expression) validateDefault(expression, references);
  for (const { expression } of constraints) if (expression) validateDefault(expression, new Set());
  const states: SequenceState[] = [];
  for (const sequence of sequences) {
    const [state] = await db.query<SequenceState>(`SELECT $1::text AS name,last_value::text AS "lastValue",is_called AS "isCalled" FROM ${qualified(schema, sequence.name)}`, [sequence.name]);
    if (!state) throw new AppError("COPY_FAILED", "Sequence state unavailable");
    states.push(state);
  }
  return { tables, columns, sequences, constraints, indexes, states };
}
type SequenceState = { name: string; lastValue: string; isCalled: boolean };
/** The exactly rebuildable shape of tables and sequences; stored in `tenant.json` in a backup. */
export type SchemaShape = Awaited<ReturnType<typeof readSchema>>;

// ---- Copying -----------------------------------------------------------------

const SERVER_FACTS_SQL = `SELECT pg_catalog.current_setting('server_version_num')::integer/10000 AS major,
  (SELECT pg_catalog.row_to_json(d)::text FROM (
    SELECT encoding,datcollate,datctype,datlocprovider,daticulocale,datcollversion,
      pg_catalog.pg_database_collation_actual_version(oid) AS actual_version
    FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) d) AS locale,
  COALESCE((SELECT pg_catalog.json_agg(extname||'@'||extversion)::text FROM pg_catalog.pg_extension),'[]') AS extensions`;

/** Server facts: for an exact copy the major version, locale/collation and extensions must match. A backup writes this to `tenant.json`. */
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
  for await (const rows of streamCursor<{ row: string }>(from, "tenant_copy_rows", select, BATCH_ROWS, signal)) {
    count += rows.length;
    await onBatch(rows.map((r) => r.row));
  }
  return count;
}

/** `fill(relation, stored columns, table)` loads each table's rows between table creation and constraints. */
export type FillTable = (relation: string, stored: string[], table: string) => Promise<void>;

/** Builds `schema` from `shape` in the caller's target transaction: sequences, tables, rows (`fill`), keys,
 * indexes, foreign keys and sequence state. Cancellation is checked between statements. */
export async function buildSchema(to: Connection, schema: string, shape: SchemaShape, fill: FillTable, signal?: AbortSignal) {
  const run = async (sql: string) => {
    signal?.throwIfAborted();
    await to.exec(sql);
  };
  await verifyCatalogResolution(to, schema);
  await useCanonicalFormat(to);
  await run(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  // Identity sequences are created with their columns, then altered to match.
  for (const sequence of shape.sequences) if (!sequence.identity) await run(sequenceDefinition(schema, sequence));
  for (const table of shape.tables) {
    const columns = shape.columns.filter((c) => c.table === table.name).map((c) => columnDefinition(schema, c));
    await run(`CREATE TABLE ${qualified(schema, table.name)} (${columns.join(", ")})`);
  }
  for (const sequence of shape.sequences) if (sequence.identity) await run(sequenceDefinition(schema, sequence, true));

  for (const table of shape.tables) {
    const stored = shape.columns.filter((c) => c.table === table.name && !c.generated).map((c) => quoteIdentifier(c.name));
    if (!stored.length) throw unsupported("Tables need at least one stored non-generated column");
    await fill(qualified(schema, table.name), stored, table.name);
  }

  // Keys and indexes before foreign keys; loading the data first allows dependency cycles.
  const addConstraints = async (foreign: boolean) => {
    for (const c of shape.constraints)
      if ((c.kind === "f") === foreign) await run(`ALTER TABLE ${qualified(schema, c.table)} ADD CONSTRAINT ${quoteIdentifier(c.name)} ${c.definition}`);
  };
  await addConstraints(false);
  for (const index of shape.indexes) await run(index.definition);
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

/** Builds `schema` on the target from the source's repeatable-read snapshot in a single target transaction. Cancellation and the time limit
 * are checked between statements and batches; if exceeded the target is rolled back. */
export async function copySchema(source: Database, target: Database, schema: string, timeoutMs = DEFAULT_COPY_TIMEOUT_MS, signal?: AbortSignal) {
  validateSchema(schema);
  const cancellation = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  cancellation.throwIfAborted();
  assertCompatible(...(await Promise.all([serverFacts(source), serverFacts(target)])));
  await source.transaction(async (from) => {
    const shape = await readSchema(from, schema);
    await target.transaction(
      (to) =>
        buildSchema(to, schema, shape, async (relation, stored) => {
          await readRows(from, relation, (rows) => insertRows(to, relation, stored, rows).then(() => {}), cancellation);
        }, cancellation),
      transferTimeouts(timeoutMs),
    );
  }, snapshotTransaction(timeoutMs));
}

// ---- Verification -------------------------------------------------------------------

const FINGERPRINT_METADATA = [
  `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`,
  `SELECT c.relname,a.attname,cn.nspname,coll.collname,coll.collprovider,coll.collisdeterministic,coll.collcollate,coll.collctype,
      coll.colliculocale,coll.collversion,pg_catalog.pg_collation_actual_version(coll.oid) AS actual_version
    FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace
    WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`,
  `SELECT c.relname,s.seqtypid::regtype::text,s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle
    FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname`,
  `SELECT t.relname,c.conname,pg_get_constraintdef(c.oid) AS definition,c.convalidated
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace JOIN pg_class t ON t.oid=c.conrelid
    WHERE n.nspname=$1 ORDER BY t.relname,c.conname`,
  `SELECT c.relname,pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname`,
];

const FINGERPRINT_RELATIONS = `SELECT c.relname AS name,c.relkind AS kind
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname=$1 AND c.relkind IN ('r','p','S','f','m','v') ORDER BY c.relname`;

/** SHA-256 over the schema metadata, sequence state and sorted row text; equal on the source and the target after a copy. */
export async function fingerprint(db: Pick<Database, "transaction">, schema: string): Promise<string> {
  validateSchema(schema);
  return db.transaction(async (tx) => {
    // Along with the row text, the metadata expressions are also brought to the canonical format in the same session.
    await useCanonicalFormat(tx);
    const hash = createHash("sha256");
    const relations = await tx.query<{ name: string; kind: string }>(FINGERPRINT_RELATIONS, [schema]);
    if (relations.some((r) => !["r", "S"].includes(r.kind))) throw unsupported("Only ordinary tables and sequences are supported by this mover");
    if (relations.length === 0) throw new AppError("EMPTY_SCHEMA", "Source schema does not contain data tables");
    for (const metadata of FINGERPRINT_METADATA) hash.update(JSON.stringify(await tx.query(metadata, [schema])));
    for (const relation of relations) {
      hash.update(JSON.stringify(relation));
      const identifier = qualified(schema, relation.name);
      if (relation.kind === "S") {
        hash.update(JSON.stringify(await tx.query(`SELECT last_value::text,is_called FROM ${identifier}`)));
        continue;
      }
      const select = `SELECT row_to_json(t)::text AS row FROM ${identifier} t ORDER BY row_to_json(t)::text COLLATE "C"`;
      for await (const batch of streamCursor<{ row: string }>(tx, "tenant_fingerprint_rows", select, BATCH_ROWS))
        for (const { row } of batch) hash.update(row).update("\n");
    }
    return hash.digest("hex");
  });
}
