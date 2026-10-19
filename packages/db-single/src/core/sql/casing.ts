/** Compile-time naming: adds camelCase aliases, by source position, to the output columns of the outermost statement. There is no
 * per-row key conversion; PostgreSQL returns rows with camelCase names directly. Rules: `README.md` (Output column names). */
import { AppError } from "../errors";

type Node = Record<string, unknown>;
type Span = { start: number; end: number };
type Edit = Span & { text: string };
/** Table name → columns; the output of the migration fold (`foldTables(...).tables`). */
export type TableColumns = ReadonlyMap<string, readonly { readonly name: string }[]>;

export interface CasingInput {
  /** Source with comments masked; positions are identical to the original source. */
  readonly parsedSource: string;
  readonly edits: Edit[];
  /** Without it, `*` over real tables cannot be expanded and is rejected. */
  readonly tables?: TableColumns;
}

/** Visible FROM item: its qualifier name, its SQL column names (if known) and whether it is a USING join. */
interface Source {
  readonly visible: string;
  readonly columns: readonly string[] | null;
  readonly using: boolean;
}
/** CTE name → SQL output names (`null` if unknown). */
type Ctes = ReadonlyMap<string, readonly string[] | null>;
/** SQL name → new output name; `alias`: whether it came from an explicit alias. */
type Renamed = Map<string, { readonly name: string; readonly alias: boolean }>;
type Output = (sqlName: string, name: string, alias: boolean) => void;

function reject(detail: string): never {
  throw new AppError("SQL_UNSUPPORTED", `SQL_UNSUPPORTED: ${detail}`);
}

/** `first_name` → `firstName`; only an underscore between lowercase letters/digits is removed, other names are unchanged. */
export const camelCase = (name: string) => name.replace(/(?<=[a-z0-9])_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const span = (node: Node) => (node._location as Span | undefined) ?? reject("missing source position");
const isStar = (expr: Node) => expr.type === "ref" && expr.name === "*";

/** Appends to `input.edits` the source edits that camelCase the output names of the validated runtime statement. */
export function aliasOutputColumns(statement: Node, input: CasingInput): void {
  aliasStatement(statement, new Map(), input);
}

/** The outermost statement: the WITH body, the first branch of a union, or the RETURNING list of a DML. Inner projections are left untouched. */
function aliasStatement(statement: Node, ctes: Ctes, input: CasingInput): Renamed {
  switch (statement.type) {
    case "with":
      return aliasStatement(statement.in as Node, withBindings(statement, ctes, input), input);
    case "select":
      return aliasSelect(statement, ctes, input);
    case "union":
    case "union all":
      return aliasUnion(statement, ctes, input);
    case "insert":
    case "update":
    case "delete":
      return aliasProjection((statement.returning as Node[] | undefined) ?? [], dmlSources(statement, ctes, input), input);
    default:
      return new Map();
  }
}

/** WITH bindings enter scope in order; a binding sees the earlier ones, not itself. */
function withBindings(statement: Node, ctes: Ctes, input: CasingInput): Ctes {
  const scope = new Map(ctes);
  for (const binding of statement.bind as Node[])
    scope.set((binding.alias as Node).name as string, outputNames(binding.statement as Node, scope, input));
  return scope;
}

function aliasSelect(select: Node, ctes: Ctes, input: CasingInput): Renamed {
  const renamed = aliasProjection(select.columns as Node[], fromSources(select.from, ctes, input), input);
  const distinct = Array.isArray(select.distinct) ? (select.distinct as Node[]) : [];
  rewriteOutputRefs([...orderExprs(select), ...distinct], renamed, input);
  // GROUP BY resolves a bare name to an input column first: a reference to a renamed explicit alias would lose its meaning.
  for (const expr of (select.groupBy as Node[] | undefined) ?? [])
    if (bareOutput(expr, renamed)?.alias) reject(`GROUP BY ${String(expr.name)} refers to a renamed output alias; group by the expression or position, or quote the alias`);
  return renamed;
}

/** PostgreSQL takes output names from the first branch. The parser attaches a union's ORDER BY to the last branch; a parenthesized branch's ORDER BY belongs to that branch. */
function aliasUnion(union: Node, ctes: Ctes, input: CasingInput): Renamed {
  const renamed = aliasStatement(union.left as Node, ctes, input);
  let last = union.right as Node;
  while (last.type === "union" || last.type === "union all") last = last.right as Node;
  if (last.type === "select" && input.parsedSource[span(last).start] !== "(") rewriteOutputRefs(orderExprs(last), renamed, input);
  return renamed;
}

const orderExprs = (select: Node) => ((select.orderBy as Node[] | undefined) ?? []).map((order) => order.by as Node);
const bareOutput = (expr: Node, renamed: Renamed) =>
  expr.type === "ref" && expr.table === undefined ? renamed.get(expr.name as string) : undefined;

/** ORDER BY and DISTINCT ON resolve a bare name to an output name first: a reference to a renamed output is rewritten with the new name. */
function rewriteOutputRefs(exprs: readonly Node[], renamed: Renamed, input: CasingInput): void {
  for (const expr of exprs) {
    const output = bareOutput(expr, renamed);
    if (output) input.edits.push({ ...span(expr), text: quote(output.name) });
  }
}

/** A bare column gets `AS "name"`, an unquoted snake alias becomes a quoted camelCase one, a quoted alias stays as is, and `*` is
 * expanded to an explicit list when needed. The same output name twice is rejected. */
function aliasProjection(columns: readonly Node[], sources: readonly Source[], input: CasingInput): Renamed {
  const renamed: Renamed = new Map();
  const seen = new Set<string>();
  const output: Output = (sqlName, name, alias) => {
    if (seen.has(name)) reject(`duplicate output column name "${name}"; alias one of the columns`);
    seen.add(name);
    if (name !== sqlName) renamed.set(sqlName, { name, alias });
  };
  for (const column of columns) {
    const expr = column.expr as Node;
    if (isStar(expr)) expandStar(expr, sources, input, output);
    else if (column.alias) renameAlias(column, input, output);
    else nameColumn(expr, input, output);
  }
  return renamed;
}

function renameAlias(column: Node, input: CasingInput, output: Output): void {
  const name = (column.alias as Node).name as string;
  const at = aliasSpan(column, input);
  // A quoted alias is the escape hatch: it stays as written.
  if (input.parsedSource[at.start] === '"') return output(name, name, true);
  const camel = camelCase(name);
  if (camel !== name) input.edits.push({ ...at, text: quote(camel) });
  output(name, camel, true);
}

/** A column without an alias (looking through casts) gets a camelCase name; other expressions keep PostgreSQL's default name. */
function nameColumn(expr: Node, input: CasingInput, output: Output): void {
  const column = columnName(expr);
  if (column === undefined) {
    const name = defaultName(expr);
    if (name !== undefined) output(name, name, false);
    return;
  }
  const camel = camelCase(column);
  if (camel !== column) {
    const end = expressionEnd(expr, input.parsedSource);
    input.edits.push({ start: end, end, text: ` AS ${quote(camel)}` });
  }
  output(column, camel, false);
}

/** `*` / `t.*` is expanded to an explicit, qualified column list only if at least one column name changes; otherwise it stays as is. */
function expandStar(ref: Node, sources: readonly Source[], input: CasingInput, output: Output): void {
  const columns =
    starColumns(ref, sources) ??
    reject("`*` needs columns known at compile time (migration tables, CTEs or subqueries with explicit projections, no USING joins); list the columns explicitly");
  for (const { name } of columns) output(name, camelCase(name), false);
  if (columns.every(({ name }) => camelCase(name) === name)) return;
  const list = columns.map(({ visible, name }) => `${quote(visible)}.${quote(name)}${camelCase(name) === name ? "" : ` AS ${quote(camelCase(name))}`}`);
  input.edits.push({ ...span(ref), text: list.join(", ") });
}

/** Expansion of `*` (qualifier, SQL name); `null` for a source with unknown columns, an unknown qualifier or a USING join. */
function starColumns(ref: Node, sources: readonly Source[]) {
  const qualifier = (ref.table as Node | undefined)?.name;
  const selected = qualifier === undefined ? sources : sources.filter((source) => source.visible === qualifier);
  if (!selected.length || (qualifier === undefined && sources.some((source) => source.using))) return null;
  const columns: { visible: string; name: string }[] = [];
  for (const { visible, columns: names } of selected) {
    if (!names) return null;
    columns.push(...names.map((name) => ({ visible, name })));
  }
  return columns;
}

/** The statement's PostgreSQL output names (SQL names before aliases are added); `null` if any is unknown. Does not throw. */
function outputNames(statement: Node, ctes: Ctes, input: CasingInput): readonly string[] | null {
  switch (statement.type) {
    case "with":
      return outputNames(statement.in as Node, withBindings(statement, ctes, input), input);
    case "select":
      return projectionNames(statement.columns as Node[], fromSources(statement.from, ctes, input));
    case "union":
    case "union all":
      return outputNames(statement.left as Node, ctes, input);
    case "insert":
    case "update":
    case "delete":
      return statement.returning ? projectionNames(statement.returning as Node[], dmlSources(statement, ctes, input)) : null;
    default:
      return null;
  }
}

function projectionNames(columns: readonly Node[], sources: readonly Source[]): readonly string[] | null {
  const names: string[] = [];
  for (const column of columns) {
    const expr = column.expr as Node;
    const found = isStar(expr)
      ? starColumns(expr, sources)?.map(({ name }) => name)
      : [((column.alias as Node | undefined)?.name as string | undefined) ?? defaultName(expr)];
    if (!found || found.includes(undefined)) return null;
    names.push(...(found as string[]));
  }
  return names;
}

/** Name of a column reference (looking through casts; PostgreSQL also gives a cast the column's name). */
function columnName(expr: Node): string | undefined {
  if (expr.type === "cast") return columnName(expr.operand as Node);
  return expr.type === "ref" && !isStar(expr) ? (expr.name as string) : undefined;
}

/** The name PostgreSQL gives an expression without an alias: a column, function or time keyword; others are not known here. */
function defaultName(expr: Node): string | undefined {
  if (expr.type === "call") return (expr.function as Node).name as string;
  if (expr.type === "keyword") return expr.keyword as string;
  if (expr.type === "cast") return defaultName(expr.operand as Node);
  return columnName(expr);
}

/** FROM items: a CTE, a migration table or a subquery with an explicit projection; a column alias list renames the leading columns. */
function fromSources(from: unknown, ctes: Ctes, input: CasingInput): Source[] {
  const items = from === undefined || from === null ? [] : ([from].flat() as Node[]);
  return items.map((item) => {
    const using = Array.isArray((item.join as Node | undefined)?.using);
    // Function in FROM: the visible name is the alias; columns are known only if an `AS e(a, b)` list is given (otherwise `*` is rejected).
    if (item.type === "call") {
      const alias = item.alias as Node;
      const names = (alias.columns as Node[] | undefined)?.map((column) => column.name as string);
      return source(alias.name as string, names ?? null, undefined, using);
    }
    if (item.type === "statement") return source(item.alias as string, outputNames(item.statement as Node, ctes, input), item.columnNames, using);
    const relation = item.name as Node;
    const name = relation.name as string;
    const columns = ctes.has(name) ? (ctes.get(name) ?? null) : tableColumns(name, input);
    return source((relation.alias as string | undefined) ?? name, columns, relation.columnNames, using);
  });
}

/** A DML target is always a real table; UPDATE ... FROM items are also visible in RETURNING. */
function dmlSources(statement: Node, ctes: Ctes, input: CasingInput): Source[] {
  const target = (statement.type === "insert" ? statement.into : statement.type === "update" ? statement.table : statement.from) as Node;
  const name = target.name as string;
  const sources = [source((target.alias as string | undefined) ?? name, tableColumns(name, input), undefined, false)];
  return statement.type === "update" ? [...sources, ...fromSources(statement.from, ctes, input)] : sources;
}

const tableColumns = (name: string, input: CasingInput) => input.tables?.get(name)?.map((column) => column.name) ?? null;

function source(visible: string, columns: readonly string[] | null, aliases: unknown, using: boolean): Source {
  const names = aliases as Node[] | undefined;
  return { visible, using, columns: columns && names ? columns.map((column, i) => (names[i]?.name as string | undefined) ?? column) : columns };
}

/** Source range of the alias; the parser gives no position for an alias without `AS`: the token after the end of the expression is read. */
function aliasSpan(column: Node, input: CasingInput): Span {
  const alias = column.alias as Node;
  if (alias._location) return alias._location as Span;
  const end = expressionEnd(column.expr as Node, input.parsedSource);
  const token = /^\s*("(?:[^"]|"")*"|[^\s,()"]+)/.exec(input.parsedSource.slice(end));
  const text = token?.[1];
  const name = text?.startsWith('"') ? text.slice(1, -1).replaceAll('""', '"') : text?.toLowerCase();
  if (!token || !text || name !== alias.name) reject("unsupported alias source position");
  const start = end + token[0].length - text.length;
  return { start, end: start + text.length };
}

/** Where the expression ends in the source: the parser position may leave out wrapping parentheses and the `)` of a type qualifier. */
function expressionEnd(expr: Node, parsed: string): number {
  const { start, end } = span(expr);
  let depth = parenDepth(parsed.slice(start, end));
  for (let i = start - 1; i >= 0 && /[\s(]/.test(parsed[i] ?? ""); i--) if (parsed[i] === "(") depth++;
  if (depth < 0) reject("unsupported projection source position");
  let cursor = end;
  for (; depth > 0; depth--) {
    while (/\s/.test(parsed[cursor] ?? "")) cursor++;
    if (parsed[cursor] !== ")") reject("unsupported projection source position");
    cursor++;
  }
  return cursor;
}

/** Net count of open parentheses outside quoted text and identifiers. */
function parenDepth(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "'" || char === '"') i = quoteEnd(text, i);
  }
  return depth;
}

/** Position of the closing quote for the quote at `at`; in E'' strings a backslash escapes. */
function quoteEnd(text: string, at: number): number {
  const mark = text[at];
  const escaped = mark === "'" && /(?:^|[^\w$])[eE]$/.test(text.slice(0, at));
  for (let i = at + 1; i < text.length; i++) {
    if (escaped && text[i] === "\\") i++;
    else if (text[i] === mark && text[i + 1] === mark) i++;
    else if (text[i] === mark) return i;
  }
  return text.length;
}
