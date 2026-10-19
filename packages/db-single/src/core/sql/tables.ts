/** Folds the up migration DDL without a database to derive the final table shapes, and writes a zod module per table.
 * DDL that cannot be folded is rejected (no guessing). `migration baseline` uses the same fold to check the live schema. */
import type {
  AlterColumn, AlterEnumType, AlterTableStatement, ColumnConstraint, CreateColumnDef, CreateTableStatement, DataTypeDef, Statement,
  TableAlteration, TableConstraint,
} from "pgsql-ast-parser";
import { AppError } from "../errors";
import { camelCase } from "./casing";
import { types as builtinTypes, scalarOnly, serials } from "./grammar";

export interface Column {
  name: string;
  /** Canonical built-in type or enum name. */
  type: string;
  arrayDepth: number;
  notNull: boolean;
  hasDefault: boolean;
  /** A `CHECK (col IN ('a', …))` constraint: the PostgreSQL name and the values. */
  check?: { name: string; values: string[] };
}
export interface Shapes {
  tables: Map<string, Column[]>;
  enums: Map<string, string[]>;
}

function reject(detail: string): never {
  throw new AppError("SQL_UNSUPPORTED", `SQL_UNSUPPORTED: codegen cannot fold ${detail}`);
}

const findColumn = (columns: Column[], name: string) => columns.find((column) => column.name === name) ?? reject(`unknown column ${name}`);

function columnType(enums: Shapes["enums"], def: DataTypeDef): Pick<Column, "type" | "arrayDepth"> {
  if (def.kind === "array") {
    const inner = columnType(enums, def.arrayOf);
    return { ...inner, arrayDepth: inner.arrayDepth + 1 };
  }
  if (Object.hasOwn(serials, def.name)) return { type: serials[def.name] as string, arrayDepth: 0 };
  if (Object.hasOwn(builtinTypes, def.name)) return { type: builtinTypes[def.name] as string, arrayDepth: 0 };
  return enums.has(def.name) ? { type: def.name, arrayDepth: 0 } : reject(`unknown type ${def.name}`);
}

/** A single-column `IN` list becomes a z.enum only on a text column; other CHECKs do not change the type. `ownColumn`: the owner of the column constraint. */
function applyCheck(table: string, columns: Column[], constraint: ColumnConstraint | TableConstraint, ownColumn?: Column) {
  if (constraint.type !== "check") return;
  const { expr } = constraint;
  if (expr.type !== "binary" || expr.op !== "IN" || expr.left.type !== "ref") return;
  const name = expr.left.name;
  const target = ownColumn ?? columns.find((column) => column.name === name);
  const items = expr.right.type === "list" ? expr.right.expressions : [expr.right];
  if (!target || target.name !== name || target.arrayDepth || !["text", "varchar", "bpchar"].includes(target.type)) return;
  const values = items.map((item) => (item.type === "string" ? item.value : undefined));
  if (values.every((value) => value !== undefined))
    target.check = { name: constraint.constraintName?.name ?? `${table}_${target.name}_check`, values: values as string[] };
}

function defineColumn(enums: Shapes["enums"], table: string, columns: Column[], def: CreateColumnDef) {
  if (columns.some((column) => column.name === def.name.name)) reject(`duplicate column ${table}.${def.name.name}`);
  const column: Column = { name: def.name.name, ...columnType(enums, def.dataType), notNull: false, hasDefault: false };
  columns.push(column);
  // serial: PostgreSQL adds NOT NULL + a sequence default.
  if (def.dataType.kind !== "array" && Object.hasOwn(serials, def.dataType.name)) Object.assign(column, { notNull: true, hasDefault: true });
  for (const constraint of def.constraints ?? []) {
    if (constraint.type === "not null" || constraint.type === "primary key") column.notNull = true;
    else if (constraint.type === "null") column.notNull = false;
    else if (constraint.type === "default") column.hasDefault = true;
    else if (constraint.type === "add generated") Object.assign(column, IDENTITY);
    else applyCheck(table, columns, constraint, column);
  }
}

// An identity column is NOT NULL and gets its value from a sequence.
const IDENTITY = { notNull: true, hasDefault: true } as const;

function applyTableConstraint(table: string, columns: Column[], constraint: TableConstraint) {
  if (constraint.type === "primary key") for (const name of constraint.columns) findColumn(columns, name.name).notNull = true;
  else applyCheck(table, columns, constraint);
}

function createTable(shapes: Shapes, statement: CreateTableStatement) {
  const table = statement.name.name;
  if (shapes.tables.has(table)) {
    if (statement.ifNotExists) return;
    reject(`duplicate table ${table}`);
  }
  const columns: Column[] = [];
  shapes.tables.set(table, columns);
  for (const def of statement.columns) defineColumn(shapes.enums, table, columns, def.kind === "column" ? def : reject("LIKE"));
  for (const constraint of statement.constraints ?? []) applyTableConstraint(table, columns, constraint);
}

function alterColumn(enums: Shapes["enums"], column: Column, alter: AlterColumn) {
  if (alter.type === "set type") Object.assign(column, columnType(enums, alter.dataType));
  else if (alter.type === "set default" || alter.type === "drop default") column.hasDefault = alter.type === "set default";
  else if (alter.type === "set not null" || alter.type === "drop not null") column.notNull = alter.type === "set not null";
  else if (alter.type === "add generated") Object.assign(column, IDENTITY);
  else reject(`ALTER COLUMN ${alter.type}`);
}

/** Parser gap fields (`parser-gaps.ts`): `IF NOT EXISTS`, `BEFORE`/`AFTER`. */
type EnumAddition = { add: { value: string }; ifNotExists?: true; before?: string; after?: string };

/** `ALTER TYPE … ADD VALUE`: the value is added in PostgreSQL's order; with `IF NOT EXISTS` an existing value is skipped. */
function addEnumValue(enums: Shapes["enums"], statement: AlterEnumType) {
  const values = enums.get(statement.name.name) ?? reject(`unknown type ${statement.name.name}`);
  if (statement.change.type !== "add value") reject(`ALTER TYPE ${statement.change.type}`);
  const { add, ifNotExists, before, after } = statement.change as unknown as EnumAddition;
  if (values.includes(add.value)) return ifNotExists ? undefined : reject(`duplicate enum value ${add.value}`);
  const anchor = before ?? after;
  if (anchor === undefined) return void values.push(add.value);
  if (!values.includes(anchor)) reject(`unknown enum value ${anchor}`);
  values.splice(values.indexOf(anchor) + (after === undefined ? 0 : 1), 0, add.value);
}

/** `DROP TYPE … CASCADE` also drops the columns that use these types. */
function dropColumnsOfTypes(tables: Shapes["tables"], types: readonly string[]) {
  for (const columns of tables.values()) columns.splice(0, columns.length, ...columns.filter((column) => !types.includes(column.type)));
}

/** The table being altered; `name` is updated by RENAME, and later changes use the new name. */
type AlterTarget = { shapes: Shapes; name: string; columns: Column[] };
type AlterHandlers = { [T in TableAlteration["type"]]?: (target: AlterTarget, change: Extract<TableAlteration, { type: T }>) => void };

/** Fold per ALTER TABLE change type; a type not in the list is rejected. */
const ALTER_TABLE_CHANGES: AlterHandlers = {
  "add column": ({ shapes, name, columns }, change) => {
    if (!change.ifNotExists || !columns.some((column) => column.name === change.column.name.name)) defineColumn(shapes.enums, name, columns, change.column);
  },
  "drop column": ({ columns }, change) => {
    const index = columns.findIndex((column) => column.name === change.column.name);
    if (index >= 0) columns.splice(index, 1);
    else if (!change.ifExists) reject(`unknown column ${change.column.name}`);
  },
  "rename column": ({ columns }, change) => {
    if (columns.some((column) => column.name === change.to.name)) reject(`duplicate column ${change.to.name}`);
    findColumn(columns, change.column.name).name = change.to.name;
  },
  rename: (target, change) => {
    if (target.shapes.tables.has(change.to.name)) reject(`duplicate table ${change.to.name}`);
    target.shapes.tables.delete(target.name);
    target.name = change.to.name;
    target.shapes.tables.set(target.name, target.columns);
  },
  "add constraint": ({ name, columns }, change) => applyTableConstraint(name, columns, change.constraint),
  "drop constraint": ({ columns }, change) => {
    for (const column of columns) if (column.check?.name === change.constraint.name) column.check = undefined;
  },
  "rename constraint": ({ columns }, change) => {
    for (const column of columns) if (column.check?.name === change.constraint.name) column.check = { ...column.check, name: change.to.name };
  },
  "alter column": ({ shapes, columns }, change) => alterColumn(shapes.enums, findColumn(columns, change.column.name), change.alter),
};

function applyAlterTable(shapes: Shapes, statement: AlterTableStatement) {
  const columns = shapes.tables.get(statement.table.name);
  if (!columns) {
    if (statement.ifExists) return;
    reject(`unknown table ${statement.table.name}`);
  }
  const target: AlterTarget = { shapes, name: statement.table.name, columns };
  for (const change of statement.changes) {
    const apply = ALTER_TABLE_CHANGES[change.type] as ((target: AlterTarget, change: TableAlteration) => void) | undefined;
    if (apply) apply(target, change);
    else reject(`ALTER TABLE ${change.type}`);
  }
}

// Indexes and data statements do not change the table shape.
const SHAPELESS_STATEMENTS = ["create index", "drop index", "alter index", "insert", "update", "delete", "with"];

export function foldTables(statements: Iterable<Statement>): Shapes {
  const shapes: Shapes = { tables: new Map(), enums: new Map() };
  for (const statement of statements) {
    switch (statement.type) {
      case "create table":
        createTable(shapes, statement);
        break;
      case "alter table":
        applyAlterTable(shapes, statement);
        break;
      case "drop table":
      case "drop type": {
        const objects = statement.type === "drop table" ? shapes.tables : shapes.enums;
        for (const { name } of statement.names) if (!objects.delete(name) && !statement.ifExists) reject(`unknown ${statement.type} ${name}`);
        if (statement.type === "drop type" && statement.cascade === "cascade") dropColumnsOfTypes(shapes.tables, statement.names.map(({ name }) => name));
        break;
      }
      case "create enum":
        shapes.enums.set(statement.name.name, statement.values.map((value) => value.value));
        break;
      case "alter enum":
        addEnumValue(shapes.enums, statement);
        break;
      default:
        if (!SHAPELESS_STATEMENTS.includes(statement.type)) reject(statement.type);
    }
  }
  return shapes;
}

// The same mapping as the driver values (README: Drivers).
const ZOD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    "z.uuid()": "uuid",
    "z.string()": `text,varchar,bpchar,int8,numeric,time,timetz,interval,${[...scalarOnly].join(",")}`,
    "z.number().int()": "int2,int4",
    "z.number()": "float4,float8",
    "z.boolean()": "bool",
    "z.date()": "date,timestamp,timestamptz",
    "z.unknown()": "json,jsonb",
    "z.instanceof(Uint8Array)": "bytea",
  }).flatMap(([zod, names]) => names.split(",").map((name) => [name, zod])),
);

/** `students` → `student`, `move_targets` → `moveTarget`. */
const baseName = (table: string) => table.replace(/ies$/, "y").replace(/([^s])s$/, "$1").replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Object key: a valid identifier is written bare, others as a JSON string. */
const propertyKey = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));

/** The zod field of a single column (camelCase key); in the `insert` schema a column with a default or nullable is optional. */
function zodField(column: Column, enums: Shapes["enums"], insert: boolean): string {
  const values = column.check?.values ?? enums.get(column.type);
  let zod = values ? `z.enum(${JSON.stringify(values)})` : (ZOD[column.type] as string);
  for (let i = 0; i < column.arrayDepth; i++) zod = `z.array(${zod})`;
  if (!column.notNull) zod += ".nullable()";
  if (insert && (!column.notNull || column.hasDefault)) zod += ".optional()";
  return `  ${propertyKey(camelCase(column.name))}: ${zod},`;
}

/** If two columns map to the same camelCase key (e.g. `first_name` and `"firstName"`), the row type cannot be built. */
function checkColumnKeys(table: string, columns: readonly Column[]): void {
  const keys = new Set<string>();
  for (const { name } of columns) {
    if (keys.has(camelCase(name))) reject(`columns of ${table} into unique camelCase keys (${camelCase(name)})`);
    keys.add(camelCase(name));
  }
}

/** Module per table: `<name>Row` (SELECT row), `<name>Insert` (columns with a default/nullable are optional), their types and
 * `<name>Columns` (camelCase key → SQL column name; for dynamic SQL and adapters). */
export function tableModules({ tables, enums }: Shapes): Map<string, string> {
  const modules = new Map<string, string>();
  const baseNames = new Set<string>();
  for (const [table, columns] of [...tables].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const base = baseName(table);
    if (!/^[a-z][a-z0-9_]*$/.test(table) || baseNames.has(base)) reject(`table name ${table} into a unique module name`);
    baseNames.add(base);
    checkColumnKeys(table, columns);
    const type = base[0]?.toUpperCase() + base.slice(1);
    const object = (insert: boolean) => `z.object({\n${columns.map((column) => zodField(column, enums, insert)).join("\n")}\n})`;
    const columnMap = columns.map(({ name }) => `  ${propertyKey(camelCase(name))}: ${JSON.stringify(name)},`).join("\n");
    modules.set(
      `src/tables/${table}.gen.ts`,
      `// Generated by \`bun run db:codegen\` from src/migrations. Do not edit.
import { z } from "zod";

export const ${base}Row = ${object(false)};
export const ${base}Insert = ${object(true)};
export const ${base}Columns = {\n${columnMap}\n} as const;
export type ${type}Row = z.infer<typeof ${base}Row>;
export type ${type}Insert = z.infer<typeof ${base}Insert>;
`,
    );
  }
  return modules;
}
