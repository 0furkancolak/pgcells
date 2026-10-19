/** Validates the AST scope; produces source edits only for real relations and safe built-ins. Finds comment boundaries
 * and blocks expressions hidden inside comments. The entry points that compile source SQL (`prepareQuery`, `prepareMigration`) are
 * used by codegen, migrations and tests; the runtime does not load them. */
import { parse, type Statement } from "pgsql-ast-parser";
import { AppError } from "../errors";
import { aliasOutputColumns, type TableColumns } from "./casing";
import { accessMethods, types as builtinTypes, functionAliases, functions, grammar, keywords, operators, scalarOnly, serials, specialCalls } from "./grammar";
import { attachParserGaps, findParserGaps } from "./parser-gaps";
import { bindParts, defineQuery, type PreparedQuery } from "./query";

type Kind = keyof typeof grammar;
type Rules = Readonly<Record<string, Kind | null>>;
// Also checks at the type level that every child kind named in the grammar exists.
const table: Readonly<Record<Kind, Readonly<Record<string, Rules>>>> = grammar;
type Node = Record<string, unknown>;
type Span = { start: number; end: number };
/** `strip`: a source-schema removal edit applied only to the output of `unqualifyMigration`. */
type Edit = Span & { text: string; strip?: boolean };
// Marks where the schema is inserted; source containing NUL is rejected.
const SCHEMA = "\0";
// Subqueries are parsed as expressions but walked as statements.
const subqueries = new Set(["select", "with", "union", "union all", "values"]);

interface Compiled {
  readonly parts: readonly string[];
  readonly requiresTransaction: boolean;
  readonly readOnly: boolean;
  /** The parsed statement: the registry derives concurrent indexes, and codegen derives the table shape, from it. */
  readonly ast: Statement;
}

/** Walk state of a single `compile` call. */
interface Context {
  readonly source: string;
  /** Source with comments masked (same positions). */
  readonly parsedSource: string;
  readonly migration: boolean;
  /** Enum types created in the migration; updated by `CREATE TYPE … AS ENUM` / `DROP TYPE`. */
  readonly types: Set<string>;
  /** `table:name` / `type:name` created in the same migration section: `DROP … CASCADE` is accepted only for these. */
  readonly created: Set<string>;
  /** `pull` only: source schemas whose qualification is removed; without it every explicit schema is rejected. */
  readonly sourceSchemas?: ReadonlySet<string>;
  readonly edits: Edit[];
  requiresTransaction: boolean;
  /** `ROLLUP`/`CUBE` calls that are direct `GROUP BY` items: a same-named call elsewhere is not treated as a function. */
  readonly groupings: Set<Node>;
}

export function unsupported(detail: string): never {
  throw new AppError("SQL_UNSUPPORTED", `SQL_UNSUPPORTED: ${detail}`);
}

/** Position of the line break at the end of a line comment (the line break is not part of the comment). */
function skipLineComment(source: string, cursor: number): number {
  while (cursor < source.length && !/[\r\n]/.test(source[cursor] ?? "")) cursor++;
  return cursor;
}

/** Position where a nested block comment ends; an unterminated comment is rejected. */
function skipBlockComment(source: string, cursor: number): number {
  cursor += 2;
  let depth = 1;
  while (cursor < source.length && depth > 0) {
    const delimiter = source.slice(cursor, cursor + 2);
    if (delimiter === "/*" || delimiter === "*/") {
      depth += delimiter === "/*" ? 1 : -1;
      cursor += 2;
    } else cursor++;
  }
  if (depth) unsupported("unterminated block comment");
  return cursor;
}

/** Position where the quoted string/identifier at `quoteAt` ends; an unterminated quote is rejected. */
function skipQuoted(source: string, quoteAt: number, escaped: boolean): number {
  const quote = source[quoteAt];
  let cursor = quoteAt + 1;
  while (cursor < source.length) {
    // Ordinary strings follow standard_conforming_strings=on; a backslash escapes only in E'' strings.
    if (escaped && source[cursor] === "\\") cursor += 2;
    else if (source[cursor] !== quote) cursor++;
    else if (source[cursor + 1] === quote) cursor += 2;
    else return cursor + 1;
  }
  return unsupported("unterminated quoted SQL token");
}

/** Hides comments from the parser; UTF-16 source positions do not change. */
export function maskSqlComments(source: string): string {
  const masked = source.split("");
  let cursor = 0;
  while (cursor < source.length) {
    const start = cursor;
    const pair = source.slice(cursor, cursor + 2);
    if (pair === "--" || pair === "/*") {
      cursor = pair === "--" ? skipLineComment(source, cursor) : skipBlockComment(source, cursor);
      for (let i = start; i < cursor; i++) if (source[i] !== "\r" && source[i] !== "\n") masked[i] = " ";
      continue;
    }
    // The supported grammar does not model dollar/Unicode-escape quoting: reject on the safe side instead of reading its content.
    if ((pair[0] === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(source.slice(cursor))) || /^[uU]&['"]/.test(source.slice(cursor, cursor + 3)))
      unsupported("unsupported SQL quoting syntax");
    const escaped = (pair === "E'" || pair === "e'") && (cursor === 0 || !/[A-Za-z0-9_$\u0080-\uffff]/.test(source[cursor - 1] ?? ""));
    const quoteAt = escaped ? cursor + 1 : cursor;
    if (source[quoteAt] === "'" || source[quoteAt] === '"') cursor = skipQuoted(source, quoteAt, escaped);
    else cursor++;
  }
  return masked.join("");
}

/** `tables`: migration tables; needed for the same `*` expansion as codegen (without them `*` over a real table is rejected). */
export function prepareQuery(source: string, tables?: TableColumns): PreparedQuery {
  const { parts, requiresTransaction, readOnly } = compile(source, false, undefined, tables)[0] as Compiled;
  return defineQuery(parts, requiresTransaction, readOnly);
}
/** `bind(schema)`: the schema the migration will run in. `types`: enum types from earlier migrations; updated by this source's
 * `CREATE TYPE … AS ENUM` / `DROP TYPE` (the registry passes the same set along, in order). `created`: tables/types created in earlier
 * parts of the same section (the registry compiles each section as a single part). */
export function prepareMigration(source: string, types = new Set<string>(), created = new Set<string>()) {
  const statements = compile(source, true, types, undefined, created);
  return Object.freeze({
    statements: statements.map((statement) => statement.ast),
    bind: (schema: string): readonly string[] => Object.freeze(statements.map(({ parts }) => bindParts(parts, schema))),
  });
}

/** `pull`: the source with the `sourceSchemas` qualifications removed, and the AST (which keeps the qualifications). The other checks
 * are the same as `prepareMigration`; the given `types`/`created` sets are not modified. */
export function unqualifyMigration(source: string, sourceSchemas: ReadonlySet<string>, types: ReadonlySet<string>, created: ReadonlySet<string>) {
  const { statements, context } = analyze(source, true, new Set(types), undefined, { created: new Set(created), sourceSchemas });
  const strips = context.edits.filter((edit) => edit.strip);
  return { source: applyEdits(source, context.parsedSource, strips, 0, source.length), statements: statements as unknown as Statement[] };
}

function location(node: Node): Span {
  const span = node._location as Span | undefined;
  if (!span || span.start >= span.end) unsupported("missing source position");
  return span;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > 63) unsupported("identifier must contain 1–63 UTF-8 bytes");
  return value;
}

/** The name and (if present) the alias must satisfy the identifier rules. */
function checkedName(node: Node): string {
  const name = identifier(node.name);
  if (node.alias !== undefined) identifier(node.alias);
  return name;
}

/** Inserts the schema marker at an AST token boundary; a marker in the SQL text is never altered. */
function qualifyWithSchema(node: Node, context: Context): void {
  const { start } = location(node);
  context.edits.push({ start, end: start, text: `${SCHEMA}.` });
}

/** An explicit schema is accepted only if it is a source schema of `pull`: the `schema.` prefix is removed from the output and the name
 * resolves to the bound schema. Every other schema (`public`, `pg_catalog` relations …) is rejected. */
function stripSourceSchema(node: Node, context: Context): void {
  if (node.schema === undefined) return;
  if (!context.sourceSchemas?.has(String(node.schema))) unsupported(`explicit schema qualification: ${String(node.schema)}`);
  const { start } = location(node);
  const prefix = /^(?:"(?:[^"]|"")*"|[^\s."]+)\s*\.\s*/.exec(context.parsedSource.slice(start));
  if (!prefix) unsupported("missing schema source position");
  context.edits.push({ start, end: start + prefix[0].length, text: "", strip: true });
}

function checkDataType(node: Node, context: Context, column = false): void {
  // The pinned parser drops array element qualifiers from the source range: reject instead of writing them twice.
  if (node.kind === "array") {
    if ((node.arrayOf as Node).config !== undefined) unsupported("array type modifiers are unsupported");
    // The array form of newer types differs between drivers (postgres.js returns raw text): scalar only.
    let element = node.arrayOf as Node;
    while (element.kind === "array") element = element.arrayOf as Node;
    if (scalarOnly.has(String(element.name)))
      unsupported(`${String(element.name)} arrays are unsupported (drivers disagree on their value shape); use a scalar column, ::text or JSON`);
    return;
  }
  const name = identifier(node.name);
  // serial is not a real type but column-definition syntax: only bare, unqualified and in a column; it stays as written.
  if (column && Object.hasOwn(serials, name) && node.schema === undefined && !node.doubleQuoted && node.config === undefined) return;
  if (node.schema !== "pg_catalog") stripSourceSchema(node, context);
  const schema = node.schema === "pg_catalog" ? "pg_catalog" : undefined;
  const canonical = Object.hasOwn(builtinTypes, name) ? builtinTypes[name] : undefined;
  // An enum created in the migration is always qualified with the bound schema (not left to the session's name resolution).
  if (!canonical && context.migration && context.types.has(name) && schema === undefined && node.config === undefined) {
    context.edits.push({ ...location(node), text: `${SCHEMA}."${name.replaceAll('"', '""')}"` });
    return;
  }
  if (!canonical || (node.doubleQuoted && canonical !== name)) unsupported(`unsupported type: ${name}`);
  const config = node.config as number[] | undefined;
  if (config?.some((n) => !Number.isSafeInteger(n) || n < 0)) unsupported("invalid type modifier");
  // A bare INTERVAL already uses SystemTypeName; qualifying it would turn the precision into a different generic type qualifier.
  if (name === "interval" && !node.doubleQuoted && schema === undefined) return;
  const { start, end } = location(node);
  // Scalar qualifier ranges end at the last argument without the ')': consume exactly that paren, never guess between tokens.
  const missingParen = config?.length && context.source[end - 1] !== ")";
  if (missingParen && context.source[end] !== ")") unsupported("unsupported type modifier source position");
  // Writes the canonical built-in name; type lookup does not depend on the session's name resolution.
  context.edits.push({
    start,
    end: missingParen ? end + 1 : end,
    text: `"pg_catalog"."${canonical}"${config?.length ? `(${config.join(",")})` : ""}`,
  });
}

type SemanticCheck = (node: Node, type: string, context: Context, scope: Set<string>) => void;

/** Semantic checks and source edits per node kind that the field table cannot express. */
const isGroupingCall = (node: Node) => node.type === "call" && ["rollup", "cube"].includes(String((node.function as Node).name));

const SEMANTIC_CHECKS: Partial<Record<Kind, SemanticCheck>> = {
  name: (node) => {
    checkedName(node);
  },
  // A relation resolves to a CTE or the application schema; a target always resolves to the application schema.
  relation: (node, _type, context, scope) => {
    stripSourceSchema(node, context);
    const name = checkedName(node);
    // The name whose qualification was removed would resolve to a same-named CTE: reject because the meaning would change.
    if (node.schema !== undefined && scope.has(name)) unsupported(`schema-qualified relation ${name} would resolve to a CTE`);
    if (!scope.has(name)) qualifyWithSchema(node, context);
  },
  target: (node, _type, context) => {
    stripSourceSchema(node, context);
    checkedName(node);
    qualifyWithSchema(node, context);
  },
  binding: (node, _type, _context, scope) => {
    scope.add((node.alias as Node).name as string);
  },
  dataType: (node, _type, context) => checkDataType(node, context),
  columnType: (node, _type, context) => checkDataType(node, context, true),
  // A built-in collation is written qualified, like types; quoting preserves case.
  collation: (node, _type, context) => {
    context.edits.push({ ...location(node), text: `"pg_catalog"."${identifier(node.name).replaceAll('"', '""')}"` });
  },
  function: (node, _type, context) => {
    const name = identifier(node.name);
    const alias = Object.hasOwn(functionAliases, name) && node.schema === undefined ? functionAliases[name] : undefined;
    if (specialCalls.has(name) && node.schema === undefined) {
      const span = location(node);
      // `GROUPING SETS` is substituted as `ROLLUP` in the parser's copy (parser-gaps.ts); it is two words in the original text.
      const groupingSets = name === "rollup" && /^grouping\s+sets(?![\w$])/i.test(context.source.slice(span.start));
      if (!groupingSets && context.source.slice(span.start, span.end).toLowerCase() !== name) unsupported("quoted SQL syntax is not an allowed function");
    } else if (alias === undefined && (!functions.has(name) || (node.schema !== undefined && node.schema !== "pg_catalog"))) unsupported(`unsupported function: ${name}`);
    else {
      const span = location(node);
      // `trim(x)` is syntax only when written bare; a quoted "trim" is a real function name and does not exist.
      if (alias !== undefined && context.source.slice(span.start, span.end).toLowerCase() !== name) unsupported("quoted SQL syntax is not an allowed function");
      context.edits.push({ ...span, text: `"pg_catalog"."${alias ?? name}"` });
    }
  },
  accessMethod: (node) => {
    if (!accessMethods.has(String(node.name))) unsupported(`unsupported index method: ${String(node.name)}`);
  },
  lock: (_node, _type, context) => {
    context.requiresTransaction = true;
  },
  conflict: (node, _type, context, scope) => {
    if (node.do !== "do nothing") walk(context, node.do, "conflictUpdate", scope);
  },
  from: (node, type) => {
    if (type === "statement") identifier(node.alias);
    if (type === "call" && !node.alias) unsupported("a function in FROM needs an alias");
    // rollup/cube/grouping are special calls (not qualified); written as a function in FROM they would resolve to an unqualified name.
    if (type === "call" && specialCalls.has(identifier((node.function as Node).name))) unsupported("a special call is not a table function");
  },
  callAlias: (node) => {
    checkedName(node);
  },
  expr: (node, type, context) => {
    if (type === "ref" && node.name !== "*") identifier(node.name);
    if (type === "parameter" && !/^\$[1-9][0-9]*$/.test(String(node.name))) unsupported("invalid parameter");
    if (operators.get(type)?.has(String(node.op)) === false) unsupported("unsupported operator");
    if (isGroupingCall(node) && !context.groupings.has(node)) unsupported("ROLLUP, CUBE and GROUPING SETS are allowed only directly in GROUP BY");
    if (type === "keyword" && !keywords.has(String(node.keyword))) unsupported("unsupported SQL keyword");
  },
};

const createdKey = (kind: "table" | "type", target: unknown) => `${kind}:${String((target as Node).name)}`;

/** Tracks the tables/types created in the section. The section runs in a single transaction: a dependency on a not-yet-committed object
 * cannot be created from another schema, so `DROP TABLE|TYPE … CASCADE` is accepted only for these objects. */
function trackCreated(node: Node, type: string, context: Context): void {
  const { created } = context;
  if (type === "create table") created.add(createdKey("table", node.name));
  else if (type === "create enum") created.add(createdKey("type", node.name));
  else if (type === "alter table") {
    for (const change of node.changes as Node[])
      if (change.type === "rename" && created.delete(createdKey("table", node.table))) created.add(createdKey("table", change.to));
  } else if (type === "drop table" || type === "drop type") {
    for (const target of node.names as Node[]) {
      const own = created.delete(createdKey(type === "drop table" ? "table" : "type", target));
      if (node.cascade === "cascade" && !own) unsupported("CASCADE is only allowed for objects created earlier in the same migration section");
    }
  }
}

/** Checks keyed on `type` for nodes with no per-kind check: enum types, created objects and SELECT lock rules. */
function checkByType(node: Node, type: string, context: Context, scope: Set<string>): void {
  if (context.migration) trackCreated(node, type, context);
  if (type === "create enum" || type === "drop type") {
    for (const target of type === "create enum" ? [node.name as Node] : (node.names as Node[])) {
      const name = target.name as string;
      if (Object.hasOwn(builtinTypes, name)) unsupported(`type name shadows a builtin: ${name}`);
      if (type === "create enum") context.types.add(name);
      else context.types.delete(name);
    }
  } else if (type === "select") {
    if (Array.isArray(node.distinct)) walk(context, node.distinct, "expr", scope);
    if (node.skip && !node.for) unsupported("lock wait policy requires FOR");
  }
}

/** The allowed fields for the node's kind and type; a type or field not in the list is rejected. */
function allowedFields(node: Node, kind: Kind, type: string): Rules {
  const variants = table[kind];
  const rules = Object.hasOwn(variants, type) ? variants[type] : variants["*"];
  if (!rules) unsupported(`unsupported ${kind}: ${type}`);
  for (const key of Object.keys(node)) if (key !== "_location" && !Object.hasOwn(rules, key)) unsupported(`unsupported ${kind} field: ${key}`);
  return rules;
}

/** Walks the children in grammar order first, then runs the node's semantic check. */
function walk(context: Context, value: unknown, kind: Kind, scope: Set<string>): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(context, item, kind, scope);
    return;
  }
  if (typeof value !== "object") unsupported(`invalid ${kind}`);
  const node = value as Node;
  const type = String(node.type ?? node.kind);
  if (kind === "expr" && subqueries.has(type)) kind = "statement";
  const rules = allowedFields(node, kind, type);
  // WITH opens a new scope; each binding joins the scope after its own body. In RECURSIVE all bindings are visible in the bodies.
  if (type === "with") {
    scope = new Set(scope);
    if (node.recursive) for (const binding of node.bind as Node[]) scope.add((binding.alias as Node).name as string);
  }
  // It is a direct item only if `GROUP BY` / `,` immediately precedes it: `GROUP BY (rollup(a))` is a parenthesized plain expression and resolves like a function.
  if (type === "select")
    for (const item of (node.groupBy as Node[] | undefined) ?? [])
      if (isGroupingCall(item) && /(?:\bBY|,)\s*$/i.test(context.parsedSource.slice(0, location(item).start))) context.groupings.add(item);
  for (const [key, child] of Object.entries(rules)) if (child) walk(context, node[key], child, scope);
  const check = SEMANTIC_CHECKS[kind];
  if (check) check(node, type, context, scope);
  else checkByType(node, type, context, scope);
  // The DROP TABLE/TYPE CASCADE rule lives in trackCreated; column/constraint/index CASCADE is always rejected.
  const ownCascadeRule = type === "drop table" || type === "drop type";
  if ((node.cascade === "cascade" && !ownCascadeRule) || node.behaviour === "cascade") unsupported("CASCADE may affect other schemas");
}

function parseStatements(parsedSource: string, migration: boolean): Node[] {
  let statements: Node[];
  try {
    statements = parse(parsedSource, { locationTracking: true }) as unknown as Node[];
  } catch {
    return unsupported("SQL could not be parsed by the supported PostgreSQL grammar");
  }
  if (!statements.length || (!migration && statements.length !== 1)) unsupported("expected one runtime statement or a nonempty migration");
  return statements;
}

/** AST statement ends may skip the closing parenthesis: the boundary is the start of the next statement. */
function statementBounds(statements: readonly Node[], index: number, sourceLength: number): Span {
  const next = statements[index + 1];
  const start = index === 0 ? 0 : location(statements[index] as Node).start;
  const end = next ? location(next).start : sourceLength;
  return { start, end };
}

/** Applies the ordered edits in `[start, end)` to the source; an insertion at the end of the source (e.g. the last RETURNING alias) belongs to the last statement. */
function applyEdits(source: string, parsedSource: string, edits: readonly Edit[], start: number, end: number): string {
  let sql = "";
  let cursor = start;
  for (const edit of edits) {
    if (edit.start < start || edit.start > end || (edit.start === end && end < source.length)) continue;
    if (edit.start < cursor) unsupported("overlapping AST source edits");
    sql += source.slice(cursor, edit.start) + edit.text;
    // Canonical type/function ranges may contain comments: keep their whitespace (including line-comment terminators).
    if (source.slice(edit.start, edit.end) !== parsedSource.slice(edit.start, edit.end))
      for (let i = edit.start; i < edit.end; i++) if (/\s/.test(parsedSource[i] ?? "")) sql += source[i];
    cursor = edit.end;
  }
  return sql + source.slice(cursor, end);
}

type MigrationState = Pick<Context, "created" | "sourceSchemas">;

/** Parses (attaching the parser gaps in a migration), walks the grammar and collects the ordered source edits. */
function analyze(source: string, migration: boolean, types: Set<string>, tables: TableColumns | undefined, state: MigrationState) {
  if (source.includes(SCHEMA)) unsupported("NUL in SQL source");
  const parsedSource = maskSqlComments(source);
  const gaps = findParserGaps(parsedSource);
  const statements = parseStatements(gaps.parsable, migration);
  attachParserGaps(statements, gaps, parsedSource);
  const context: Context = { source, parsedSource, migration, types, ...state, edits: [], requiresTransaction: false, groupings: new Set() };
  for (const statement of statements) walk(context, statement, migration ? "migration" : "statement", new Set());
  // Output names change only in a validated runtime query; migration/seed DML and inner projections stay as they are.
  if (!migration) aliasOutputColumns(statements[0] as Node, { parsedSource, edits: context.edits, tables });
  context.edits.sort((a, b) => a.start - b.start);
  return { statements, context };
}

/** `true` if the runtime query only reads: a top-level SELECT/VALUES/UNION, lock-free (no `FOR …`), and every CTE body also a read.
 * Functions with side effects (such as `nextval`) cannot be separated statically; a replica rejects writes itself; a primary read (no replica, or after a write) is a single statement. */
function readsOnly(node: Node): boolean {
  switch (node.type) {
    case "select":
      return !node.for;
    case "values":
      return true;
    case "union":
    case "union all":
      return readsOnly(node.left as Node) && readsOnly(node.right as Node);
    case "with":
      return (node.bind as { statement: Node }[]).every((binding) => readsOnly(binding.statement)) && readsOnly(node.in as Node);
    default:
      return false;
  }
}

/** `tables`: used only in runtime queries, to expand the outermost `*` for camelCase output names (`casing.ts`).
 * `created`: tables/types created earlier in the migration section (the CASCADE rule). */
export function compile(
  source: string,
  migration: boolean,
  types = new Set<string>(),
  tables?: TableColumns,
  created = new Set<string>(),
): readonly Compiled[] {
  const { statements, context } = analyze(source, migration, types, tables, { created });
  return Object.freeze(
    statements.map((statement, index) => {
      const { start, end } = statementBounds(statements, index, source.length);
      const parts = Object.freeze(applyEdits(source, context.parsedSource, context.edits, start, end).split(SCHEMA));
      return Object.freeze({ parts, requiresTransaction: context.requiresTransaction, readOnly: readsOnly(statement as unknown as Node), ast: statement as unknown as Statement });
    }),
  );
}
