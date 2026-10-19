/** An SQL backup of another application (`backup.sql`, `.gz` also works): pg_dump plain text (COPY or `--inserts`) and mysqldump. Read as a
 * stream without connecting to a DB, split table by table (`splitSqlDump`), and a transfer-code skeleton is generated from the chunks
 * (`scaffoldAppMigration`); the transfer itself is `app-migration.ts`.
 *
 * Only data and table definitions are read (CREATE TABLE, COPY, INSERT); statements such as functions, triggers and indexes are skipped. Rows
 * are written as JSON Lines; values are converted according to the CREATE TABLE type (integer → number, bool → boolean, json → object; bigint outside
 * the safe range, numeric and others stay text). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { AppError } from "../errors";
import { type GzipWriter, openGzipWriter, readLines } from "./jsonl";

export type Dialect = "postgres" | "mysql";
export type DumpColumn = { name: string; type: string };
export type DumpRow = { table: string; values: Record<string, unknown> };
export type DumpTable = { columns: DumpColumn[]; rows: number; file: string; nulls: Record<string, number> };
export type DumpAnalysis = { format: 1; source: string; dialect: Dialect; tables: Record<string, DumpTable> };

const FORMAT = 1;
const invalid = (message: string) => new AppError("DUMP_INVALID", message);

/** Quoted identifiers: `"a ""b"""` (PostgreSQL) and `` `a ``b``` `` (MySQL). */
const DOUBLE_QUOTED = '"(?:[^"]|"")*"';
const BACKTICK_QUOTED = "`(?:[^`]|``)*`";
const IDENTIFIER_TOKEN = `${DOUBLE_QUOTED}|${BACKTICK_QUOTED}`;
/** Integer types that do and do not always stay within the safe range. */
const SMALL_INTEGER_TYPES = "smallint|integer|int2|int4|mediumint|tinyint|serial|smallserial";
const BIG_INTEGER_TYPES = "bigint|int8|bigserial";
const INTEGER_TYPE = new RegExp(`^(${SMALL_INTEGER_TYPES}|int|${BIG_INTEGER_TYPES})\\b`);

const NAME_PARTS = new RegExp(`${IDENTIFIER_TOKEN}|[^.\\s]+`, "g");
const COLUMN_TOKENS = new RegExp(`${IDENTIFIER_TOKEN}|\\S+`, "g");
const CREATE_TABLE_HEAD = new RegExp(`^CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?((?:${IDENTIFIER_TOKEN}|[^\\s(])+)\\s*\\(`, "i");
/** COPY exists only in pg_dump: only a double-quoted name. */
const COPY_HEAD = new RegExp(`^COPY\\s+((?:${DOUBLE_QUOTED}|[^\\s(])+)\\s*(?:\\(([^)]*)\\))?\\s+FROM\\s+stdin`, "i");
const INSERT_HEAD = new RegExp(`^(?:INSERT|REPLACE)\\s+(?:IGNORE\\s+)?INTO\\s+(?:ONLY\\s+)?((?:${IDENTIFIER_TOKEN}|[^\\s(])+)\\s*(?:\\(([^)]*)\\))?\\s*VALUES\\s*`, "i");

/** `"x"`, `` `x` `` → x; the `public.` prefix is dropped (other schemas stay `schema.table`). */
function name(raw: string) {
  const parts = raw.trim().match(NAME_PARTS) ?? [];
  const names = parts.map((part) => (/^["`]/.test(part) ? part.slice(1, -1).replaceAll(part.charAt(0).repeat(2), part.charAt(0)) : part.toLowerCase()));
  return (names[0] === "public" && names.length > 1 ? names.slice(1) : names).join(".");
}

/** Splits on top-level commas (excluding those inside parentheses and quotes). */
function splitTopLevel(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === "'") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const CONSTRAINT_WORDS = new Set(["not", "null", "default", "primary", "references", "unique", "check", "collate", "generated", "constraint", "auto_increment", "comment", "identity"]);
const TABLE_ITEMS = /^(constraint|primary|unique|key|index|foreign|check|exclude|like|fulltext)\b/i;

function parseCreateTable(statement: string): { table: string; columns: DumpColumn[] } | undefined {
  const head = statement.match(CREATE_TABLE_HEAD);
  if (!head) return;
  const body = statement.slice(head[0].length, statement.lastIndexOf(")"));
  const columns: DumpColumn[] = [];
  for (const item of splitTopLevel(body)) {
    if (TABLE_ITEMS.test(item)) continue;
    const tokens = item.match(COLUMN_TOKENS) ?? [];
    const words: string[] = [];
    for (const token of tokens.slice(1)) {
      const word = token.toLowerCase();
      if (CONSTRAINT_WORDS.has(word) || (word === "set" && words.at(-1) === "character")) {
        if (word === "set") words.pop();
        break;
      }
      words.push(word);
    }
    if (tokens[0]) columns.push({ name: name(tokens[0]), type: words.join(" ") });
  }
  return { table: name(head[1] as string), columns };
}

/** Value according to the CREATE TABLE type (COPY and INSERT give the same result). */
export function coerce(value: string | null, type = ""): unknown {
  if (value === null) return null;
  if (INTEGER_TYPE.test(type) && !type.includes("[]")) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  if (/^(real|float|double)/.test(type)) return Number(value);
  if (/^bool/.test(type)) return ["t", "true", "1", "y", "yes", "on"].includes(value.toLowerCase());
  if (/^jsonb?$/.test(type))
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  return value;
}

const COPY_ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
/** `\` escapes in string literals: in addition to the COPY escapes, MySQL's `\0` and `\Z`. */
const BACKSLASH_ESCAPES: Record<string, string> = { ...COPY_ESCAPES, "0": "\0", Z: "\x1a" };

/** COPY text-format field: `\N` is null, backslash escapes. */
function copyField(field: string): string | null {
  if (field === "\\N") return null;
  if (!field.includes("\\")) return field;
  return field.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_, code: string) => {
    if (code[0] === "x") return String.fromCharCode(parseInt(code.slice(1), 16));
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return COPY_ESCAPES[code] ?? code;
  });
}

/** A string starting with the single quote at `text[start]`: `''` is a single quote, and if `escapes` is set `\` escapes are decoded too.
 * Returns the value and the position after the closing quote. */
function readQuotedLiteral(text: string, start: number, escapes: boolean) {
  let value = "";
  let i = start + 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\" && escapes) {
      const next = text[i + 1] as string;
      value += BACKSLASH_ESCAPES[next] ?? next;
      i += 2;
    } else if (c === "'" && text[i + 1] === "'") {
      value += "'";
      i += 2;
    } else if (c === "'") break;
    else {
      value += c;
      i++;
    }
  }
  return { value, end: i + 1 };
}

/** A single value in a tuple; stops at a top-level `,` or `)` position (`end`). If the expression has a string literal the first one is the value;
 * otherwise NULL → null, TRUE/FALSE → "true"/"false", others the raw text with the `::type` cast dropped. */
function readTupleValue(text: string, start: number, dialect: Dialect): { value: string | null; end: number } {
  let literal: string | undefined;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'") {
      const escapes = dialect === "mysql" || /[eE]$/.test(text.slice(start, i));
      const quoted = readQuotedLiteral(text, i, escapes);
      literal ??= quoted.value;
      i = quoted.end;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if ((c === "," || c === ")") && depth === 0) break;
    i++;
  }
  if (literal !== undefined) return { value: literal, end: i };
  const raw = text.slice(start, i).trim();
  if (/^null$/i.test(raw)) return { value: null, end: i };
  return { value: /^(true|false)$/i.test(raw) ? raw.toLowerCase() : raw.replace(/::[\w\s."[\]()]+$/, ""), end: i };
}

/** `VALUES (…), (…)` list: strings (`''`, `E'…'` and `\` escapes in MySQL), NULL/TRUE/FALSE, numbers; `::type` casts are dropped,
 * other expressions are returned as text. */
function parseValues(text: string, dialect: Dialect): (string | null)[][] {
  const tuples: (string | null)[][] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  while (i < text.length) {
    skipSpace();
    if (text[i] !== "(") break;
    i++;
    const tuple: (string | null)[] = [];
    for (;;) {
      skipSpace();
      const { value, end } = readTupleValue(text, i, dialect);
      tuple.push(value);
      // The separator (`,` or `)`) is skipped; `)` ends the tuple.
      i = end + 1;
      if (text[end] !== ",") break;
    }
    tuples.push(tuple);
    skipSpace();
    if (text[i] === ",") i++;
    else break;
  }
  return tuples;
}

/** Scanner that collects statements line by line: carries block comment, quote and line comment state across lines. */
function createStatementScanner() {
  let statement = "";
  let quote = "";
  let block = false;
  return {
    /** Scans the line; yields each completed statement (without `;`) and the remainder of the line after `;`. If the consumer exits early
     * (COPY data starts) the rest of the line is not appended to the next statement. `escapes`: `\` escape inside quotes (MySQL). */
    *feed(line: string, escapes: boolean): Generator<{ text: string; rest: string }> {
      let from = 0;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (block) {
          if (c === "*" && line[i + 1] === "/") {
            block = false;
            i++;
          }
        } else if (quote) {
          if (c === "\\" && (escapes || quote === "E")) i++;
          else if (c === "'" && (quote === "'" || quote === "E")) {
            if (line[i + 1] === "'") i++;
            else quote = "";
          } else if (c === quote) quote = "";
        } else if (c === "-" && line[i + 1] === "-") {
          statement += line.slice(from, i);
          from = line.length;
          break;
        } else if (c === "/" && line[i + 1] === "*" && line[i + 2] !== "!") {
          block = true;
          i++;
        } else if (c === "'") quote = /[eE]$/.test(line.slice(0, i)) && !/\w[eE]$/.test(line.slice(0, i)) ? "E" : "'";
        else if (c === '"' || c === "`") quote = c;
        else if (c === ";") {
          statement += line.slice(from, i);
          from = i + 1;
          const text = statement.trim();
          statement = "";
          yield { text, rest: line.slice(from) };
        }
      }
      statement += `${line.slice(from)}\n`;
    },
  };
}

type CopyTarget = { table: string; columns: DumpColumn[] };

/** Converts a value list to an object by column names; a value with an unknown column becomes `columnN` (a number if it looks like one). */
function toRow(table: string, columns: DumpColumn[], fields: (string | null)[]): DumpRow {
  if (columns.length && fields.length !== columns.length) throw invalid(`Row of ${table} has ${fields.length} values for ${columns.length} columns`);
  const values: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    const column = columns[index];
    values[column?.name ?? `column${index + 1}`] = column ? coerce(field, column.type) : field !== null && /^-?\d+(\.\d+)?$/.test(field) ? Number(field) : field;
  });
  return { table, values };
}

/** Maps column names to the types known from CREATE TABLE (unknown type ""). */
const typedColumns = (names: string[], known: DumpColumn[]): DumpColumn[] =>
  names.map((column) => ({ name: column, type: known.find((k) => k.name === column)?.type ?? "" }));

/** A single completed statement: CREATE TABLE learns the columns, INSERT yields rows, and if COPY starts it returns its target. */
function* handleStatement(text: string, state: DumpState): Generator<DumpRow, CopyTarget | undefined> {
  const { tables } = state;
  const created = /^CREATE\s/i.test(text) ? parseCreateTable(text) : undefined;
  if (created) tables.set(created.table, created.columns);
  const copied = text.match(COPY_HEAD);
  if (copied) {
    const table = name(copied[1] as string);
    const known = tables.get(table) ?? [];
    const copy = { table, columns: typedColumns(copied[2] ? splitTopLevel(copied[2]).map(name) : known.map((column) => column.name), known) };
    if (!tables.has(table)) tables.set(table, copy.columns);
    return copy;
  }
  const inserted = text.match(INSERT_HEAD);
  if (!inserted) return;
  const table = name(inserted[1] as string);
  const known = tables.get(table) ?? [];
  const columns = inserted[2] ? typedColumns(splitTopLevel(inserted[2]).map(name), known) : known;
  if (!tables.has(table)) tables.set(table, columns);
  const body = text.slice(inserted[0].length).replace(/\s+ON\s+(CONFLICT|DUPLICATE)\s[\s\S]*$/i, "");
  for (const tuple of parseValues(body, state.dialect ?? "postgres")) yield toRow(table, columns, tuple);
}

export type DumpState = { tables: Map<string, DumpColumn[]>; dialect?: Dialect };
/** Yields the dump's rows as a stream; `state.tables` fills with the columns learned from CREATE TABLE, `state.dialect` from the header. */
export async function* readSqlDump(path: string, state: DumpState = { tables: new Map() }): AsyncGenerator<DumpRow> {
  const scanner = createStatementScanner();
  let copy: CopyTarget | undefined;
  for await (const line of readLines(path)) {
    if (copy) {
      if (line === "\\.") copy = undefined;
      else yield toRow(copy.table, copy.columns, line.split("\t").map(copyField));
      continue;
    }
    if (state.dialect === undefined && /^--\s*(MySQL|MariaDB) dump/i.test(line)) state.dialect = "mysql";
    for (const { text, rest } of scanner.feed(line, state.dialect === "mysql")) {
      copy = yield* handleStatement(text, state);
      if (!copy) continue;
      if (rest.trim()) throw invalid("COPY data must start on a new line");
      break;
    }
  }
  if (copy) throw invalid(`COPY data of ${copy.table} is not terminated`);
}

const fileName = (table: string) => `${table.replace(/[^a-z0-9_.-]/gi, "_")}.jsonl.gz`;
type TableStats = { rows: number; nulls: Record<string, number> };

/** Splits the dump into `<out>/tables/<table>.jsonl.gz` chunks and writes `<out>/analysis.json` (column, type, row and null counts;
 * no sample values are written). */
export async function splitSqlDump(path: string, out: string, options: { dialect?: Dialect; signal?: AbortSignal } = {}): Promise<DumpAnalysis> {
  await mkdir(join(out, "tables"), { recursive: true });
  const state: DumpState = { tables: new Map(), dialect: options.dialect };
  const stats = new Map<string, TableStats>();
  // A single open gzip stream (low memory): closed when the table changes; if a table comes again a new gzip member is appended to the file.
  let open: { table: string; writer: GzipWriter } | undefined;
  const closeOpen = async () => {
    if (!open) return;
    const { writer } = open;
    open = undefined;
    await writer.close();
  };
  try {
    for await (const { table, values } of readSqlDump(path, state)) {
      options.signal?.throwIfAborted();
      if (open?.table !== table) {
        await closeOpen();
        open = { table, writer: openGzipWriter(join(out, "tables", fileName(table)), { append: stats.has(table) }) };
      }
      const stat = stats.get(table) ?? { rows: 0, nulls: {} };
      stats.set(table, stat);
      stat.rows++;
      for (const [key, value] of Object.entries(values)) if (value === null) stat.nulls[key] = (stat.nulls[key] ?? 0) + 1;
      await open.writer.write(JSON.stringify(values));
    }
  } finally {
    await closeOpen();
  }
  const tables: Record<string, DumpTable> = {};
  for (const [table, list] of [...state.tables].sort(([a], [b]) => a.localeCompare(b))) {
    const stat = stats.get(table) ?? { rows: 0, nulls: {} };
    tables[table] = { columns: list, rows: stat.rows, file: stat.rows ? `tables/${fileName(table)}` : "", nulls: stat.nulls };
  }
  const analysis: DumpAnalysis = { format: FORMAT, source: basename(path), dialect: state.dialect ?? "postgres", tables };
  await writeFile(join(out, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`);
  return analysis;
}

export async function readAnalysis(dir: string): Promise<DumpAnalysis> {
  const analysis = JSON.parse(await readFile(join(dir, "analysis.json"), "utf8")) as DumpAnalysis;
  if (analysis.format !== FORMAT) throw invalid("analysis.json format is not supported; split the dump again");
  return analysis;
}

/** SQL type → TypeScript type; the first matching rule wins, `string` if none match. */
const TS_TYPES: [RegExp, string][] = [
  [/\[\]$/, "string"],
  [new RegExp(`^(${SMALL_INTEGER_TYPES}|int\\b|real|float|double)`), "number"],
  [new RegExp(`^(${BIG_INTEGER_TYPES})`), "number | string"],
  [/^bool/, "boolean"],
  [/^jsonb?$/, "unknown"],
];
const tsType = (type: string) => TS_TYPES.find(([pattern]) => pattern.test(type))?.[1] ?? "string";
const property = (key: string) => (/^[a-z_$][\w$]*$/i.test(key) ? key : JSON.stringify(key));
const USER_TABLE = /(^|[._])(users?|members?|accounts?|customers?|kullanici(lar)?|uyeler?)$/;

type TableEntry = [table: string, info: DumpTable];
const isUsersTable = ([table, info]: TableEntry) => USER_TABLE.test(table) && info.columns.some((c) => /e-?mail/.test(c.name));
const findColumn = (info: DumpTable, pattern: RegExp) => info.columns.find((c) => pattern.test(c.name))?.name;
const stepComment = ([table, info]: TableEntry) => `    // ${table}: ${info.rows} rows; ${info.columns.map((c) => c.name).join(", ")}`;

/** A table row in the `Rows` type: the type of each column (a column seen with null or of unknown type gets `| null`) and the SQL type as a comment. */
function rowTypes([table, info]: TableEntry) {
  const fields = info.columns.map((c) => `    ${property(c.name)}: ${tsType(c.type)}${info.nulls[c.name] || !c.type ? " | null" : ""}; // ${c.type || "?"}`);
  return `  ${property(table)}: {\n${fields.join("\n")}\n  };`;
}

/** User table step: the `ImportedUser` fields are guessed from known column names. */
function userStep(entry: TableEntry) {
  const [table, info] = entry;
  const field = (key: string, pattern: RegExp) => {
    const column = findColumn(info, pattern);
    return column ? `${key}: row[${JSON.stringify(column)}]` : undefined;
  };
  const fields = [
    field("externalId", /^(id|user_?id|uid)$/),
    field("email", /e-?mail/),
    field("name", /^(name|full_?name|display_?name|username|ad_?soyad)$/),
    field("passwordHash", /(password|passwd|pass_?hash|sifre)/),
    field("createdAt", /^(created_?at|created|date_?joined|kayit_?tarihi)$/),
  ].filter(Boolean);
  const email = findColumn(info, /e-?mail/) as string;
  const mapped = `({ ${fields.join(", ")} })`;
  // A row without an email cannot be a user: if the column contains null, the skeleton skips the row.
  const body = info.nulls[email] ? `(row[${JSON.stringify(email)}] ? ${mapped} : null)` : mapped;
  return `${stepComment(entry)}\n    { table: ${JSON.stringify(table)}, users: (row) => ${body} },`;
}

/** An example `into` + `map` step as a comment line for the other tables. */
function tableStep(entry: TableEntry) {
  const [table, info] = entry;
  const id = findColumn(info, /^id$/);
  const example = id ? `{ id: ctx.uuid(${JSON.stringify(table)}, row.id) /* , target_column: row.source_column */ }` : "{ /* target_column: row.source_column */ }";
  return `${stepComment(entry)}\n    // { table: ${JSON.stringify(table)}, into: "target_table", map: (row, ctx) => (${example}) },`;
}

/** Transfer module skeleton from the chunks: row types, one step for each populated table (the users table first as a `users` step).
 * The developer fills in the mappings; the file returns a function with `defineAppMigration` (`legacy2app(m, tenantId, dir)`). */
export function scaffoldAppMigration(analysis: DumpAnalysis, options: { name: string; source: string; importFrom?: string }) {
  const filled = Object.entries(analysis.tables).filter(([, table]) => table.rows > 0);
  const ordered = [...filled.filter(isUsersTable), ...filled.filter((entry) => !isUsersTable(entry))];
  const steps = ordered.map((entry) => (isUsersTable(entry) ? userStep(entry) : tableStep(entry)));
  return `/** ${options.source} → transfer into this application (${analysis.source}). Generated with \`dump scaffold\`: fill in the mappings, delete unneeded steps.
 * Steps run in order (users first, then tables in foreign key order); a row is skipped if \`map\` returns null.
 *
 *   bun run tools app-migrate <tenant> <chunk directory | backup.sql> --file ${options.importFrom ? "src/app-migrations/" : ""}${options.name}.ts --dry-run
 */
import { defineAppMigration } from "${options.importFrom ?? "@0furkancolak/pgcells/tools"}";

type Rows = {
${ordered.map(rowTypes).join("\n")}
};

export default defineAppMigration<Rows>({
  source: ${JSON.stringify(options.source)},
  steps: [
${steps.join("\n")}
  ],
});
`;
}
