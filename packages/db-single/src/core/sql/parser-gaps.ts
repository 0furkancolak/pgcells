/** The few migration clauses the pinned parser cannot parse: `ALTER COLUMN … TYPE … USING expression`, `UNIQUE NULLS NOT
 * DISTINCT` and `ALTER TYPE … ADD VALUE [IF NOT EXISTS] 'v' [BEFORE|AFTER 'w']`. A clause is covered with spaces only in the copy given
 * to the parser (the output is still produced from the original source); after parsing it is attached, by position, to exactly that
 * AST node and added as a field; the grammar walks these fields with the normal rules. A clause that cannot be attached is rejected.
 * Runtime queries use the same mechanism; in addition INTERSECT/EXCEPT, IS [NOT] DISTINCT FROM, GROUPING SETS and the window frame
 * are substituted/covered in the parser's copy (SUBSTITUTES, FRAME). */
import { parse } from "pgsql-ast-parser";
import { AppError } from "../errors";

type Node = Record<string, unknown>;
type Span = { start: number; end: number };
type GapKind = "using" | "nulls not distinct" | "if not exists" | "enum position" | "recursive";
interface Gap extends Span {
  readonly kind: GapKind;
}

const unsupported = (detail: string): never => {
  throw new AppError("SQL_UNSUPPORTED", `SQL_UNSUPPORTED: ${detail}`);
};

// Quoted strings and identifiers; comments are masked beforehand and dollar quoting has been rejected.
const QUOTED = /[eE]'(?:[^'\\]|\\.|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"/g;
const IDENTIFIER = String.raw`(?:"_*"|[A-Za-z_][\w$]*)`;
// Words the parser cannot parse but whose meaning the walker does not need are substituted in the parser's copy. The output is produced from
// the original source and the meaning comes from the original text in PostgreSQL; the walker only looks at the scope of leaf SELECTs, the
// function allowlist and the output names of the left branch: these are not affected by the tree shape or precedence of the substituted
// word. The substituted text always fits in the first word.
const word = (pattern: string) => new RegExp(String.raw`(?<![\w$])${pattern}(?![\w$])`, "gi");
const SUBSTITUTES: readonly (readonly [RegExp, string])[] = [
  [word("(?:INTERSECT|EXCEPT)"), "UNION"],
  [word(String.raw`IS\s+NOT\s+DISTINCT\s+FROM`), "="],
  [word(String.raw`IS\s+DISTINCT\s+FROM`), "<>"],
  [word(String.raw`GROUPING\s+SETS`), "ROLLUP"],
];
// Window frame: only `UNBOUNDED`/`CURRENT ROW`/integer bounds, and at the end of the `OVER (…)` parenthesis; `EXCLUDE`, `$n` and an
// offset with an expression do not match, so the frame is left to the parser and rejected.
const BOUND = String.raw`(?:UNBOUNDED\s+(?:PRECEDING|FOLLOWING)|CURRENT\s+ROW|\d+\s+(?:PRECEDING|FOLLOWING))`;
const FRAME = new RegExp(String.raw`(?<![\w$])(?:ROWS|RANGE|GROUPS)\s+(?:BETWEEN\s+${BOUND}\s+AND\s+${BOUND}|${BOUND})(?=\s*\))`, "gi");

/** Writes `text` into the range `[start, start + length)` and covers the rest with spaces; line breaks are preserved (positions do not change). */
function overwrite(chars: string[], start: number, length: number, text: string): void {
  for (let i = 0; i < length; i++) if (chars[start + i] !== "\n" && chars[start + i] !== "\r") chars[start + i] = text[i] ?? " ";
}

const ENUM_ADD_VALUE = new RegExp(
  String.raw`^\s*ALTER\s+TYPE\s+${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?\s+ADD\s+VALUE\s+(IF\s+NOT\s+EXISTS\s+)?'_*'(\s+(?:BEFORE|AFTER)\s+'_*')?\s*$`,
  "id",
);

/** Covers quoted contents with `_`: keyword searches do not snag on string/identifier contents, and positions do not change. */
function codeView(masked: string): string {
  return masked.replace(QUOTED, (token) => token.replace(/(?<=^[eE]?['"])[\s\S]*(?=['"]$)/, (inner) => "_".repeat(inner.length)));
}

/** Statement ranges separated by `;` (semicolon excluded). */
function segments(code: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  for (let i = 0; i <= code.length; i++)
    if (i === code.length || code[i] === ";") {
      spans.push({ start, end: i });
      start = i + 1;
    }
  return spans;
}

/** Start positions of `pattern` (sticky) matches at parenthesis depth 0 that do not begin in the middle of a word. */
function topLevelMatches(code: string, { start, end }: Span, pattern: RegExp): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = start; i < end; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") depth--;
    else if (depth === 0 && !/[\w$]/.test(code[i - 1] ?? "")) {
      pattern.lastIndex = i;
      if (pattern.test(code)) found.push(i);
    }
  }
  return found;
}

/** Every top-level `USING expression` in an ALTER TABLE statement: the expression runs to the next top-level comma or the end of the statement. */
function usingGaps(code: string, segment: Span): Gap[] {
  if (!/^\s*ALTER\s+TABLE\b/i.test(code.slice(segment.start, segment.end))) return [];
  const commas = topLevelMatches(code, segment, /,/y);
  return topLevelMatches(code, segment, /USING\b/iy).map((start) => ({
    kind: "using",
    start,
    end: commas.find((comma) => comma > start) ?? segment.end,
  }));
}

/** The `IF NOT EXISTS` and `BEFORE|AFTER 'w'` parts, if the whole `ALTER TYPE … ADD VALUE` statement matches the strict form. */
function enumGaps(code: string, segment: Span): Gap[] {
  const match = ENUM_ADD_VALUE.exec(code.slice(segment.start, segment.end));
  const gaps: Gap[] = [];
  for (const [group, kind] of [[1, "if not exists"], [2, "enum position"]] as const) {
    const indices = match?.indices?.[group];
    if (indices) gaps.push({ kind, start: segment.start + indices[0], end: segment.start + indices[1] });
  }
  return gaps;
}

/** The `NULLS NOT DISTINCT` inside `UNIQUE NULLS NOT DISTINCT`. */
function nullsNotDistinctGaps(code: string): Gap[] {
  return [...code.matchAll(/\bUNIQUE(\s+)(NULLS\s+NOT\s+DISTINCT)\b/gi)].map((match) => {
    const start = match.index + "UNIQUE".length + (match[1]?.length ?? 0);
    return { kind: "nulls not distinct", start, end: start + (match[2]?.length ?? 0) };
  });
}

/** The `RECURSIVE` inside `WITH RECURSIVE`. */
function recursiveGaps(code: string): Gap[] {
  return [...code.matchAll(/(?<![\w$])WITH(\s+)(RECURSIVE)(?![\w$])/gi)].map((match) => {
    const start = match.index + "WITH".length + (match[1]?.length ?? 0);
    return { kind: "recursive", start, end: start + (match[2]?.length ?? 0) };
  });
}

export interface ParserGaps {
  /** The copy given to the parser: clauses are covered with spaces of equal length. */
  readonly parsable: string;
  readonly gaps: readonly Gap[];
  readonly code: string;
}

/** Finds and covers the clauses in the migration source whose comments are masked. */
export function findParserGaps(masked: string): ParserGaps {
  const code = codeView(masked);
  const gaps = [...nullsNotDistinctGaps(code), ...recursiveGaps(code), ...segments(code).flatMap((segment) => [...usingGaps(code, segment), ...enumGaps(code, segment)])];
  const chars = masked.split("");
  for (const { start, end } of gaps) for (let i = start; i < end; i++) if (!/\s/.test(chars[i] ?? "")) chars[i] = " ";
  for (const [pattern, text] of SUBSTITUTES) for (const match of code.matchAll(pattern)) overwrite(chars, match.index, match[0].length, text);
  for (const match of code.matchAll(FRAME)) overwrite(chars, match.index, match[0].length, "");
  return { parsable: chars.join(""), gaps, code };
}

const span = (node: unknown): Span | undefined => (node as Node | undefined)?._location as Span | undefined;
const blankBetween = (code: string, from: number, to: number) => from <= to && /^\)?\s*$/.test(code.slice(from, to));

/** Shifts the positions of a separately parsed expression to its place in the source. */
function shift(value: unknown, offset: number): void {
  if (Array.isArray(value)) for (const item of value) shift(item, offset);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "_location") {
        const location = child as Span;
        location.start += offset;
        location.end += offset;
      } else shift(child, offset);
    }
  }
}

/** The statement the clause starts in: the last statement that begins before the clause. */
function statementAt(statements: readonly Node[], position: number): Node | undefined {
  return statements.filter((statement) => (span(statement)?.start ?? Infinity) <= position).at(-1);
}

/** `USING expression`: attached as the parsed `using` expression to the `set type` change that ends immediately before it. */
function attachUsing(statement: Node | undefined, gap: Gap, { code }: ParserGaps, masked: string): boolean {
  if (statement?.type !== "alter table") return false;
  const alter = (statement.changes as Node[])
    .map((change) => change.alter as Node | undefined)
    .find((candidate) => candidate?.type === "set type" && !candidate.using && blankBetween(code, span(candidate)?.end ?? Infinity, gap.start));
  if (!alter) return false;
  const exprStart = gap.start + "USING".length;
  let parsed: unknown;
  try {
    [parsed] = parse(masked.slice(exprStart, gap.end), { entry: "expr", locationTracking: true } as never) as unknown as unknown[];
  } catch {
    return unsupported("USING expression could not be parsed by the supported PostgreSQL grammar");
  }
  shift(parsed, exprStart);
  alter.using = parsed;
  return true;
}

/** `nullsNotDistinct` if the node's `UNIQUE` keyword (with `CONSTRAINT name`, if any) ends right before the clause. */
function attachNullsNotDistinct(value: unknown, gap: Gap, code: string): boolean {
  if (Array.isArray(value)) return value.some((item) => attachNullsNotDistinct(item, gap, code));
  if (!value || typeof value !== "object") return false;
  const node = value as Node;
  const start = span(node)?.start ?? Infinity;
  if (node.type === "unique" && start <= gap.start && new RegExp(String.raw`^(?:CONSTRAINT\s+${IDENTIFIER}\s+)?UNIQUE\s+$`, "i").test(code.slice(start, gap.start))) {
    node.nullsNotDistinct = true;
    return true;
  }
  return Object.entries(node).some(([key, child]) => key !== "_location" && attachNullsNotDistinct(child, gap, code));
}

/** The `with` node that ends in `WITH` (and starts with `(`, if any) becomes `recursive`. */
function attachRecursive(value: unknown, gap: Gap, code: string): boolean {
  if (Array.isArray(value)) return value.some((item) => attachRecursive(item, gap, code));
  if (!value || typeof value !== "object") return false;
  const node = value as Node;
  const start = span(node)?.start ?? Infinity;
  if (node.type === "with" && start <= gap.start && /^[(\s]*WITH\s+$/i.test(code.slice(start, gap.start))) {
    node.recursive = true;
    return true;
  }
  return Object.entries(node).some(([key, child]) => key !== "_location" && attachRecursive(child, gap, code));
}

/** `IF NOT EXISTS` before the value, `BEFORE|AFTER 'w'` after the value: attached as a field to the `add value` change. */
function attachEnumClause(statement: Node | undefined, gap: Gap, code: string, masked: string): boolean {
  const change = statement?.type === "alter enum" ? (statement.change as Node) : undefined;
  const value = span(change?.add);
  if (change?.type !== "add value" || !value) return false;
  if (gap.kind === "if not exists" && blankBetween(code, gap.end, value.start)) change.ifNotExists = true;
  else if (gap.kind === "enum position" && blankBetween(code, value.end, gap.start)) {
    const [, keyword = "", literal = ""] = /^\s*(BEFORE|AFTER)\s+'([\s\S]*)'\s*$/i.exec(masked.slice(gap.start, gap.end)) ?? [];
    change[keyword.toLowerCase()] = literal.replaceAll("''", "'");
  } else return false;
  return true;
}

/** Attaches every clause to the AST; a clause left unattached is rejected. */
export function attachParserGaps(statements: readonly Node[], found: ParserGaps, masked: string): void {
  for (const gap of found.gaps) {
    const statement = statementAt(statements, gap.start);
    const attached =
      gap.kind === "using"
        ? attachUsing(statement, gap, found, masked)
        : gap.kind === "nulls not distinct"
          ? attachNullsNotDistinct(statement, gap, found.code)
          : gap.kind === "recursive"
            ? attachRecursive(statement, gap, found.code)
            : attachEnumClause(statement, gap, found.code, masked);
    if (!attached) unsupported(`unsupported ${gap.kind.toUpperCase()} clause position`);
  }
}
