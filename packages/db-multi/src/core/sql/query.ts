/** Runtime: brands compiled SQL parts and binds them to their scope's schema. Does not load the parser. */
import { AppError } from "../errors";
import { validateSchema } from "../tenants/model";

/** Platform/node migrations and the `src/queries/{node,platform}/` queries are bound to this schema. */
export const PLATFORM_SCHEMA = "platform";
/** Query folder = scope (as with migrations): `tenant` binds to the tenant/demo schema, `node` to each database's and `platform` to db0's
 * `platform` schema; the context also checks the scope (`QUERY_SCOPE`). */
export const QUERY_SCOPES = ["tenant", "node", "platform"] as const;
export type QueryScope = (typeof QUERY_SCOPES)[number];

export interface PreparedQuery {
  readonly requiresTransaction: boolean;
  readonly scope: QueryScope;
  /** Read-only query (SELECT without locks, no data-modifying CTE): the read context (replica) runs only these. */
  readonly readOnly: boolean;
  readonly bind: (schema: string) => string;
}
/** Queries branded by `defineQuery`. */
const preparedQueries = new WeakSet<object>();

/** Joins compiled parts with a validated schema name. */
export const bindParts = (parts: readonly string[], schema: string) => parts.join(`"${validateSchema(schema)}"`);

/** Number of bound texts stored per query (one text per schema); the oldest is dropped when full. */
const BOUND_TEXTS = 256;

/** Only compiler output may call this; `codegen --check` rejects other callers. */
export function defineQuery(parts: readonly string[], requiresTransaction: boolean, scope: QueryScope, readOnly: boolean): PreparedQuery {
  const frozen = Object.freeze([...parts]);
  const compose = (schema: string) => {
    if (scope === "tenant") return bindParts(frozen, schema);
    if (schema !== PLATFORM_SCHEMA) throw new AppError("QUERY_SCOPE", `${scope} query bound outside the platform schema`);
    return frozen.join(`"${PLATFORM_SCHEMA}"`);
  };
  // Only the text of a schema that passed validation is stored; the hot path does no joining or regex per query.
  const bound = new Map<string, string>();
  const bind = (schema: string) => {
    let text = bound.get(schema);
    if (text === undefined) {
      text = compose(schema);
      if (bound.size >= BOUND_TEXTS) bound.delete(bound.keys().next().value as string);
      bound.set(schema, text);
    }
    return text;
  };
  const query = Object.freeze({ requiresTransaction, scope, readOnly, bind });
  preparedQueries.add(query);
  return query;
}

export const isPreparedQuery = (value: unknown): value is PreparedQuery =>
  typeof value === "object" && value !== null && preparedQueries.has(value);
