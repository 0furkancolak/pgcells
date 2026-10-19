/** Better Auth database adapter: a small SQL generator built on `createAdapterFactory` that runs on the engine's query path (`query` / `transaction`).
 * Every table is qualified as `"<schema>"."<table>"`, every value is a `$n` parameter; session state (search_path)
 * is not used. Table and column names come from the Better Auth `modelName` / `fields` mapping (`students`, `teachers` ...).
 *
 * - Operators: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `not_in`, `contains`, `starts_with`, `ends_with`; `AND` conditions and a single
 *   `OR` group (`(a AND b) AND (c OR d)`, same as the Kysely adapter). `mode: "insensitive"`: `lower()` / `ILIKE`.
 * - `consumeOne` and `incrementOne` are atomic as a single statement. Joins are not passed to the adapter or are ignored: Better Auth completes
 *   them with separate queries (`advanced.database.joins` only merges the extra queries).
 * - Values: dates are `Date` (the driver sends ISO text), booleans are native; json and array fields are written as JSON text, and jsonb comes back as
 *   an object when read. int8 comes back as text and is converted to a number for `number` fields.
 * - If the database generates the ids (`generateId: false` or `"uuid"`), `id` and the fields that reference it are `uuid` columns: text that is not a UUID
 *   (a malformed id from the client) never reaches the column; `eq` matches no row, `ne` matches every non-null row, and it is
 *   dropped from `in` / `not_in` lists. So the query does not fail with `invalid input syntax for type uuid`, and Better Auth sees "not found". */
import type { DBAdapterInstance } from "better-auth";
import { type AdapterFactoryConfig, type CleanedWhere, createAdapterFactory, type CustomAdapter } from "better-auth/adapters";
import type { Database } from "./database";
import type { Connection } from "./driver";
import { AppError } from "./errors";
import { quoteIdentifier } from "./tenants/model";

/** The engine's query path: a non-transaction query is a single round trip, a transaction runs on a reserved connection (timeout and deadline belong to the engine). */
export type Queryable = Pick<Database, "query" | "transaction">;
type Executor = Pick<Connection, "query">;
type Params = unknown[];
type AdapterHelpers = Parameters<Parameters<typeof createAdapterFactory>[0]["adapter"]>[0];
/** Whether the where field (database name) is a `uuid` column. */
type UuidKey = (field: string) => boolean;

const bind = (params: Params, value: unknown) => `$${params.push(value)}`;
/** In a LIKE pattern, `%`, `_` and `\` stand for themselves (are escaped). */
const likeLiteral = (value: unknown) => String(value).replace(/[\\%_]/g, "\\$&");
const LIKE: Record<string, (value: unknown) => string> = {
  contains: (value) => `%${likeLiteral(value)}%`,
  starts_with: (value) => `${likeLiteral(value)}%`,
  ends_with: (value) => `%${likeLiteral(value)}`,
};
const COMPARE: Record<string, string> = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };

/** Formats accepted by PostgreSQL `uuid` input: 32 hexadecimal digits, optional hyphens and curly braces. */
const UUID = /^(?:[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}|\{[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}\})$/i;
const notUuid = (value: unknown) => typeof value === "string" && !UUID.test(value);

const isInsensitive = ({ mode, value }: CleanedWhere) =>
  mode === "insensitive" && (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string")));

function listCondition(column: string, { operator, value }: CleanedWhere, insensitive: boolean, uuid: boolean, params: Params) {
  let items = (Array.isArray(value) ? value : [value]) as unknown[];
  if (uuid) items = items.filter((item) => !notUuid(item));
  if (!items.length) return operator === "in" ? "false" : "true";
  const list = items.map((item) => bind(params, insensitive ? String(item).toLowerCase() : item)).join(", ");
  return `${column} ${operator === "in" ? "IN" : "NOT IN"} (${list})`;
}

function condition(where: CleanedWhere, params: Params, uuidKey: UuidKey): string {
  const { field, operator, value } = where;
  const insensitive = isInsensitive(where);
  const column = quoteIdentifier(field);
  const uuid = uuidKey(field);
  if (operator === "in" || operator === "not_in") return listCondition(insensitive ? `lower(${column})` : column, where, insensitive, uuid, params);
  if (uuid && notUuid(value) && (operator === "eq" || operator === "ne")) return operator === "eq" ? "false" : `${column} IS NOT NULL`;
  const like = LIKE[operator];
  if (like) return `${column} ${insensitive ? "ILIKE" : "LIKE"} ${bind(params, like(value))}`;
  const compare = COMPARE[operator];
  if (!compare) throw new AppError("UNSUPPORTED", `Unsupported Better Auth where operator: ${operator}`);
  if (value === null && (operator === "eq" || operator === "ne")) return `${column} IS ${operator === "eq" ? "" : "NOT "}NULL`;
  if (insensitive && (operator === "eq" || operator === "ne")) return `lower(${column}) ${compare} ${bind(params, String(value).toLowerCase())}`;
  return `${column} ${compare} ${bind(params, value)}`;
}

/** `AND` conditions and, if present, a parenthesized `OR` group; empty when there are no conditions. */
function whereClause(where: readonly CleanedWhere[] | undefined, params: Params, uuidKey: UuidKey): string {
  if (!where?.length) return "";
  const and: string[] = [];
  const or: string[] = [];
  for (const item of where) (item.connector === "OR" ? or : and).push(condition(item, params, uuidKey));
  if (or.length) and.push(or.length === 1 ? (or[0] as string) : `(${or.join(" OR ")})`);
  return ` WHERE ${and.join(" AND ")}`;
}

/** LIMIT/OFFSET enter the text only as a validated integer. */
function integer(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError("UNSUPPORTED", `Better Auth ${name} must be a non-negative integer`);
  return value;
}

const affected = (rows: { count?: number }) => rows.count ?? 0;

/** Better Auth methods bound to a single executor (a pool or a transaction connection). */
function sqlAdapter(executor: Executor, schema: string) {
  const tables = new Map<string, string>();
  const table = (model: string) => {
    let name = tables.get(model);
    if (!name) tables.set(model, (name = `${quoteIdentifier(schema)}.${quoteIdentifier(model)}`));
    return name;
  };
  const first = async <T>(text: string, params: Params) => ((await executor.query<T>(text, params))[0] ?? null) as T | null;

  return ({ getFieldName, getFieldAttributes, options }: AdapterHelpers): CustomAdapter => {
    const generateId = options.advanced?.database?.generateId;
    const databaseIds = generateId === false || generateId === "uuid";
    const uuidKeys = new Map<string, boolean>();
    /** The model's `uuid` columns: `id` and the fields that reference `id` (only when the database generates the ids). */
    const uuidKeyOf = (model: string): UuidKey => (field) => {
      if (!databaseIds) return false;
      const key = `${model}\0${field}`;
      let uuid = uuidKeys.get(key);
      if (uuid === undefined) {
        const attributes = field === "id" ? undefined : getFieldAttributes({ model, field });
        uuidKeys.set(key, (uuid = field === "id" || attributes?.references?.field === "id"));
      }
      return uuid;
    };
    const where = (model: string, clauses: readonly CleanedWhere[] | undefined, params: Params) => whereClause(clauses, params, uuidKeyOf(model));
    const columns = (model: string, select?: string[]) =>
      select?.length ? select.map((field) => quoteIdentifier(getFieldName({ model, field }))).join(", ") : "*";
    const assignments = (data: Record<string, unknown>, params: Params) =>
      Object.entries(data).map(([column, value]) => `${quoteIdentifier(column)} = ${bind(params, value)}`);
    /** The id of the first row matching the condition; `consumeOne` and `incrementOne` target it within the same statement without locking. */
    const firstId = (model: string, clauses: CleanedWhere[], params: Params) => {
      const id = quoteIdentifier(getFieldName({ model, field: "id" }));
      return `${id} IN (SELECT ${id} FROM ${table(model)}${where(model, clauses, params)} LIMIT 1)`;
    };

    return {
      create: async ({ model, data }) => {
        const params: Params = [];
        const keys = Object.keys(data);
        const values = keys.length ? ` (${keys.map(quoteIdentifier).join(", ")}) VALUES (${keys.map((key) => bind(params, data[key])).join(", ")})` : " DEFAULT VALUES";
        return (await first(`INSERT INTO ${table(model)}${values} RETURNING *`, params)) as typeof data;
      },
      findOne: ({ model, where: clauses, select }) => {
        const params: Params = [];
        return first(`SELECT ${columns(model, select)} FROM ${table(model)}${where(model, clauses, params)} LIMIT 1`, params);
      },
      findMany: async ({ model, where: clauses, limit, select, sortBy, offset }) => {
        const params: Params = [];
        let text = `SELECT ${columns(model, select)} FROM ${table(model)}${where(model, clauses, params)}`;
        if (sortBy?.field) text += ` ORDER BY ${quoteIdentifier(getFieldName({ model, field: sortBy.field }))} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`;
        if (limit !== undefined) text += ` LIMIT ${integer(limit, "limit")}`;
        if (offset !== undefined) text += ` OFFSET ${integer(offset, "offset")}`;
        return executor.query(text, params);
      },
      count: async ({ model, where: clauses }) => {
        const params: Params = [];
        const row = await first<{ count: unknown }>(`SELECT count(*) AS count FROM ${table(model)}${where(model, clauses, params)}`, params);
        return Number(row?.count ?? 0);
      },
      update: async ({ model, where: clauses, update }) => {
        const params: Params = [];
        const set = assignments(update as Record<string, unknown>, params);
        if (!set.length) return first(`SELECT * FROM ${table(model)}${where(model, clauses, params)} LIMIT 1`, params);
        return first(`UPDATE ${table(model)} SET ${set.join(", ")}${where(model, clauses, params)} RETURNING *`, params);
      },
      updateMany: async ({ model, where: clauses, update }) => {
        const params: Params = [];
        const set = assignments(update, params);
        if (!set.length) return 0;
        return affected(await executor.query(`UPDATE ${table(model)} SET ${set.join(", ")}${where(model, clauses, params)}`, params));
      },
      delete: async ({ model, where: clauses }) => {
        const params: Params = [];
        await executor.query(`DELETE FROM ${table(model)}${where(model, clauses, params)}`, params);
      },
      deleteMany: async ({ model, where: clauses }) => {
        const params: Params = [];
        return affected(await executor.query(`DELETE FROM ${table(model)}${where(model, clauses, params)}`, params));
      },
      consumeOne: ({ model, where: clauses }) => {
        const params: Params = [];
        return first(`DELETE FROM ${table(model)} WHERE ${firstId(model, clauses, params)} RETURNING *`, params);
      },
      incrementOne: ({ model, where: clauses, increment, set }) => {
        const params: Params = [];
        const counters = Object.entries(increment).map(([column, delta]) => `${quoteIdentifier(column)} = COALESCE(${quoteIdentifier(column)}, 0) + ${bind(params, delta)}`);
        const values = [...counters, ...assignments(set ?? {}, params)].join(", ");
        const filter = where(model, clauses, params);
        return first(`UPDATE ${table(model)} SET ${values}${filter}${filter ? " AND" : " WHERE"} ${firstId(model, clauses, params)} RETURNING *`, params);
      },
    };
  };
}

const CONFIG = {
  adapterId: "repo-db",
  adapterName: "@repo/db",
  supportsBooleans: true,
  supportsDates: true,
  supportsJSON: false,
  supportsArrays: false,
  supportsUUIDs: true,
  // int8/numeric come back as text from the engine; a Better Auth `number` field expects a number.
  customTransformOutput: ({ data, fieldAttributes }) => (fieldAttributes.type === "number" && typeof data === "string" ? Number(data) : data),
} satisfies Omit<AdapterFactoryConfig, "transaction">;

/** The Better Auth `database` option bound to `schema`. The transaction is the engine's `db.transaction`: the same reserved connection, `BEGIN … COMMIT`. */
export function engineAdapter(db: Queryable, schema: string): DBAdapterInstance {
  return (options) => {
    const inTransaction = (tx: Connection) => createAdapterFactory({ config: { ...CONFIG, transaction: false }, adapter: sqlAdapter(tx, schema) })(options);
    return createAdapterFactory({
      config: { ...CONFIG, transaction: (work) => db.transaction((tx) => work(inTransaction(tx))) },
      adapter: sqlAdapter(db, schema),
    })(options);
  };
}
