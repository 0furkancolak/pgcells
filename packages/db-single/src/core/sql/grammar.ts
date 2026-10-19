/** The accepted SQL subset: allowed AST fields, types, functions and operators. */
/** A set from a comma-separated list. */
const commaSet = (items: string) => new Set(items.split(","));

// alias=canonical catalog name; a bare entry is already canonical. The parser positions of the long time-zone/character varying aliases
// are unreliable, and char/character, unlike a bare bpchar, carries an implicit length: these aliases are not supported.
// pg_catalog types that return strings in all three drivers but whose array form differs between drivers (postgres.js returns raw text): scalar only.
const scalarOnlyList = "inet,cidr,macaddr,tsvector,tsquery,int4range,int8range,numrange,tsrange,tstzrange,daterange";
export const scalarOnly = commaSet(scalarOnlyList);
export const types: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    `uuid,text,boolean=bool,bool,smallint=int2,int2,integer=int4,int=int4,int4,bigint=int8,int8,real=float4,float4,double precision=float8,float8,numeric,decimal=numeric,varchar,bpchar,bytea,json,jsonb,date,time,timetz,timestamp,timestamptz,interval,${scalarOnlyList}`
      .split(",")
      .map((entry) => [entry.split("=")[0], entry.split("=").pop()]),
  ),
);
/** The `serial` family is not a real type but CREATE TABLE/ADD COLUMN syntax: written unqualified; PostgreSQL expands it to `int2/int4/int8` + a sequence + a default. */
export const serials: Readonly<Record<string, string>> = { smallserial: "int2", serial: "int4", bigserial: "int8" };
// Built-in function names: aggregates, text/number/date, JSON and window functions.
export const functions = new Set(
  `count sum avg min max
lower upper length char_length abs round ceil floor
now date_trunc date_part to_char gen_random_uuid split_part
json_agg jsonb_agg json_build_object jsonb_build_object array_agg string_agg
row_number rank dense_rank percent_rank cume_dist ntile
lag lead first_value last_value nth_value
unnest generate_series jsonb_set jsonb_each jsonb_each_text jsonb_array_elements jsonb_array_elements_text
jsonb_extract_path jsonb_extract_path_text concat replace btrim ltrim rtrim regexp_replace regexp_match regexp_matches array_length
to_tsvector to_tsquery plainto_tsquery websearch_to_tsquery ts_rank`.split(/\s+/),
);
// The real function that SQL syntax calls: `trim(x)` is `btrim(x)` in PostgreSQL; there is no `pg_catalog.trim`.
export const functionAliases: Readonly<Record<string, string>> = { trim: "btrim" };
// These are not functions resolved in a schema but forms of SQL syntax.
export const specialCalls = commaSet("any,coalesce,nullif,greatest,least,exists,grouping,rollup,cube");
export const keywords = commaSet("current_date,current_time,current_timestamp,localtime,localtimestamp");
// Approved operators per expression node type; other operators are rejected.
export const operators = new Map([
  ["binary", commaSet("OR,AND,IN,NOT IN,LIKE,NOT LIKE,ILIKE,NOT ILIKE,=,!=,>,>=,<,<=,+,-,*,/,%,||,@>,<@,?,?|,?&,#>>,~,~*,!~,!~*,@@,&&,<<,>>")],
  ["unary", commaSet("+,-,NOT,IS NULL,IS NOT NULL,IS TRUE,IS FALSE,IS NOT TRUE,IS NOT FALSE")],
  ["ternary", commaSet("BETWEEN,NOT BETWEEN")],
]);
/** Built-in index access methods (pg_am; not tied to a schema). */
export const accessMethods = commaSet("btree,hash,gin,gist,brin");

const union = { type: null, left: "statement", right: "statement" } as const;
const literal = { type: null, value: null } as const;
const empty = { type: null } as const;
// `schema` can only be the source schema of `pull`; the compiler rejects every other value.
const relation = { name: null, schema: null, alias: null, columnNames: "name" } as const;
const named = { type: null, constraintName: "name" } as const;
const primaryKey = { ...named, columns: "name" } as const;
// `nullsNotDistinct`: added by the parser gap (parser-gaps.ts).
const unique = { ...primaryKey, nullsNotDistinct: null } as const;
// Identity column; `GENERATED ALWAYS AS (expression) STORED` (`expression`, `stored`) is rejected because it is not in the list.
const generated = { type: null, always: null, constraintName: "name", sequence: "identity" } as const;
const dataType = { array: { kind: null, arrayOf: "dataType" }, "*": { name: null, schema: null, doubleQuoted: null, config: null } } as const;
const withStatement = { type: null, bind: "binding", in: "statement", recursive: null } as const;
const reference = { ...named, foreignTable: "target", foreignColumns: "name", localColumns: "name", onDelete: null, onUpdate: null, match: null } as const;
const drop = { type: null, names: "target", ifExists: null, cascade: null } as const;
// Data migrations (and seeds) use the same DML rules as the runtime.
const dml = {
  insert: { type: null, into: "target", columns: "name", insert: "statement", returning: "selected", onConflict: "conflict" },
  update: { type: null, table: "target", sets: "set", where: "expr", from: "from", returning: "selected" },
  delete: { type: null, from: "target", where: "expr", returning: "selected" },
} as const;

/**
 * Node kind → node `type` (or `kind`) → allowed fields and the kind of each child (`null` = leaf value). `"*"` matches every type.
 * Types and fields not in the list are rejected; children are walked in the order listed here.
 */
export const grammar = {
  statement: {
    select: { type: null, columns: "selected", from: "from", where: "expr", groupBy: "expr", having: "expr", limit: "limit", orderBy: "order", distinct: null, for: "lock", skip: "skip" },
    // WITH opens a scope; each binding joins the scope after its own body.
    with: withStatement,
    union,
    "union all": union,
    values: { type: null, values: "expr" },
    ...dml,
  },
  binding: { "*": { statement: "statement", alias: "name" } },
  expr: {
    ref: { type: null, name: null, table: "name" },
    parameter: { type: null, name: null },
    string: literal,
    integer: literal,
    numeric: literal,
    boolean: literal,
    null: empty,
    default: empty,
    constant: { type: null, dataType: "dataType", value: null },
    cast: { type: null, operand: "expr", to: "dataType" },
    call: { type: null, function: "function", args: "expr", distinct: null, orderBy: "order", filter: "expr", withinGroup: "order", over: "over" },
    binary: { type: null, left: "expr", right: "expr", op: null },
    // `->` / `->>`: the parser gives the key only as a constant string/number (`data->$1` cannot be parsed).
    member: { type: null, operand: "expr", op: null, member: null },
    unary: { type: null, operand: "expr", op: null },
    list: { type: null, expressions: "expr" },
    array: { type: null, expressions: "expr" },
    "array select": { type: null, select: "statement" },
    arrayIndex: { type: null, array: "expr", index: "expr" },
    case: { type: null, value: "expr", whens: "when", else: "expr" },
    ternary: { type: null, value: "expr", lo: "expr", hi: "expr", op: null },
    keyword: { type: null, keyword: null },
    // EXTRACT(field FROM expression): PostgreSQL always resolves this as pg_catalog.extract; the field is a keyword.
    extract: { type: null, field: "name", from: "expr" },
  },
  from: {
    table: { type: null, name: "relation", join: "join" },
    statement: { type: null, statement: "statement", alias: null, columnNames: "name", join: "join", lateral: null },
    // A table-returning function in FROM; an alias is required (the compiler checks). The column list is in `alias.columns`.
    call: { type: null, function: "function", args: "expr", alias: "callAlias", lateral: null, join: "join" },
  },
  name: { "*": { name: null } },
  callAlias: { "*": { name: null, columns: "name" } },
  // Relations resolve to a CTE or the application schema; targets always resolve to the application schema.
  relation: { "*": relation },
  target: { "*": relation },
  dataType,
  columnType: dataType,
  function: { "*": { name: null, schema: null } },
  selected: { "*": { expr: "expr", alias: "name" } },
  order: { "*": { by: "expr", order: null, nulls: null } },
  limit: { "*": { limit: "expr", offset: "expr" } },
  join: { "*": { type: null, on: "expr", using: "name" } },
  set: { "*": { column: "name", value: "expr" } },
  when: { "*": { when: "expr", value: "expr" } },
  conflict: { "*": { on: "conflictTarget", do: null, where: "expr" } },
  conflictTarget: { "on expr": { type: null, exprs: "expr" }, "on constraint": { type: null, constraint: "name" } },
  conflictUpdate: { "*": { sets: "set" } },
  over: { "*": { partitionBy: "expr", orderBy: "order" } },
  lock: { update: empty, "no key update": empty, share: empty, "key share": empty },
  skip: { nowait: empty, "skip locked": empty },
  migration: {
    "create table": { type: null, name: "target", ifNotExists: null, columns: "column", constraints: "constraint" },
    "alter table": { type: null, table: "target", ifExists: null, changes: "change" },
    "create index": { type: null, table: "target", indexName: "name", expressions: "indexExpr", where: "expr", unique: null, concurrently: null, ifNotExists: null, using: "accessMethod" },
    "drop table": drop,
    "drop index": { ...drop, concurrently: null },
    // Enum types are created in the application schema; later references are bound to that schema in the compiler.
    "create enum": { type: null, name: "target", values: null },
    "drop type": drop,
    "alter index": { type: null, index: "target", ifExists: null, change: "indexChange" },
    // ADD VALUE only; `ifNotExists`/`before`/`after` are added by the parser gap.
    "alter enum": { type: null, name: "target", change: "enumChange" },
    // Data migration: the same WITH rules as the runtime.
    with: withStatement,
    ...dml,
  },
  column: { column: { kind: null, name: "name", dataType: "columnType", constraints: "constraint" } },
  constraint: {
    "primary key": primaryKey,
    unique,
    "add generated": generated,
    "not null": named,
    null: named,
    default: { ...named, default: "expr" },
    check: { ...named, expr: "expr" },
    reference,
    "foreign key": reference,
  },
  // Even if the sequence name is written unqualified, it is created in the table's schema; the compiler still writes the bound schema explicitly. `OWNED BY` is rejected.
  identity: { "*": { name: "target", as: "dataType", incrementBy: null, minValue: null, maxValue: null, startWith: null, cache: null, cycle: null } },
  indexExpr: { "*": { expression: "expr", collate: "collation", order: null, nulls: null } },
  accessMethod: { "*": { name: null } },
  // Unqualified only; the compiler writes it as a pg_catalog collation.
  collation: { "*": { name: null } },
  change: {
    "add column": { type: null, ifNotExists: null, column: "column" },
    "drop column": { type: null, ifExists: null, column: "name", behaviour: null },
    rename: { type: null, to: "name" },
    "rename column": { type: null, column: "name", to: "name" },
    "rename constraint": { type: null, constraint: "name", to: "name" },
    "alter column": { type: null, column: "name", alter: "alterColumn" },
    "add constraint": { type: null, constraint: "constraint" },
    "drop constraint": { type: null, ifExists: null, constraint: "name", behaviour: null },
  },
  alterColumn: {
    // `using`: the conversion expression parsed separately by the parser gap.
    "set type": { type: null, dataType: "dataType", using: "expr" },
    "add generated": generated,
    "set default": { type: null, default: "expr" },
    "drop default": empty,
    "set not null": empty,
    "drop not null": empty,
  },
  indexChange: { rename: { type: null, to: "name" } },
  enumChange: { "add value": { type: null, add: "enumValue", ifNotExists: null, before: null, after: null } },
  enumValue: { "*": { value: null } },
} as const;
