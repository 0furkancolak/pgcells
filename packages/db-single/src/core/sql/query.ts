/** Runtime: brands compiled SQL parts and binds them to a schema. Does not load the parser. */
import { validateSchema } from "../identifier";

export interface PreparedQuery {
  readonly requiresTransaction: boolean;
  /** A query that only reads (lock-free SELECT, no data-modifying CTE): the read context (replica) runs only these. */
  readonly readOnly: boolean;
  readonly bind: (schema: string) => string;
}
/** Queries branded by `defineQuery`. */
const preparedQueries = new WeakSet<object>();

/** Joins the compiled parts with the validated schema name. */
export const bindParts = (parts: readonly string[], schema: string) => parts.join(`"${validateSchema(schema)}"`);

/** Only compiler output may call this; `codegen --check` rejects other callers. */
export function defineQuery(parts: readonly string[], requiresTransaction: boolean, readOnly: boolean): PreparedQuery {
  const frozen = Object.freeze([...parts]);
  // A `Db` uses a single schema: the text for the last validated schema is kept, so no joining or regex runs on the hot path.
  let lastSchema: string | undefined;
  let lastText = "";
  const bind = (schema: string) => {
    if (schema !== lastSchema) {
      lastText = bindParts(frozen, schema);
      lastSchema = schema;
    }
    return lastText;
  };
  const query = Object.freeze({ requiresTransaction, readOnly, bind });
  preparedQueries.add(query);
  return query;
}

export const isPreparedQuery = (value: unknown): value is PreparedQuery => typeof value === "object" && value !== null && preparedQueries.has(value);
