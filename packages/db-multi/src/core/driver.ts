/** Driver contract: Bun SQL, postgres.js and pg implement this small interface (`core/drivers/*`). The engine uses no other driver API.
 * Value types are driver-independent: int8/numeric are strings, date and timestamptz are `Date` (date at UTC midnight), json is parsed,
 * uuid/interval are strings, bytea is `Buffer`. */
export type Row = Record<string, unknown>;

export interface Connection {
  /** Text query with `$n` parameters; never uses a named prepared statement (safe for PgBouncer/Hyperdrive).
   * The array carries the affected/returned row count in `count` (used by the `@0furkancolak/pgcells/auth` adapter's `updateMany`/`deleteMany`).
   * `tenantId`: not sent to the driver; it only marks the tenant in the `onSpan` span. */
  query<R = Row>(text: string, params?: readonly unknown[], tenantId?: string): Promise<R[] & { count?: number }>;
  /** Parameterless, multi-statement simple-protocol execution (DDL, `BEGIN; SET LOCAL …`). */
  exec(sql: string): Promise<void>;
}
/** A single connection reserved from the pool; if it is dead, the driver discards it after `release`. */
export interface Reserved extends Connection {
  /** `discard`: the connection does not return to the pool and is closed (even before the running statement finishes); the next reservation opens a new connection. */
  release(discard?: boolean): void;
  /** Tries to cancel the statements running on this connection on the server (CancelRequest; PgBouncer forwards it to the right server). A driver without
   * reliable cancellation (Bun SQL) does not define this; in that case the connection is discarded and the server stops the statement via `client_connection_check_interval`. */
  cancel?(): void;
}
export interface Pool extends Connection {
  reserve(): Promise<Reserved>;
  close(timeoutMs: number): Promise<void>;
}
export interface PoolOptions {
  max: number;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  connectTimeoutSeconds: number;
  /** Called when a connection closes (the server terminated it, the network dropped); management sessions notice their death this way. */
  onClose?: () => void;
}
export type Driver = (url: string, options: PoolOptions) => Pool;

/** `Date` parameters are sent as ISO UTC text on every driver: Bun with `prepare:false` sends `toString()` (rejected),
 * and pg sends the local time offset (`::date` shifts by a day at a negative offset). */
export function normalizeParams(values: readonly unknown[] = []): unknown[] {
  // Hot path: if there is no `Date`, the array is not copied (drivers do not modify the parameter array).
  for (const value of values) if (value instanceof Date) return values.map((item) => (item instanceof Date ? item.toISOString() : item));
  return values as unknown[];
}

/** Drivers do not offer the timeout as their own guarantee; closing the pool ends with the same upper bound on every driver. */
export const withTimeout = (work: Promise<unknown>, ms: number) =>
  Promise.race([work.then(() => {}), new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())]);

/** `begin` (e.g. `BEGIN; SET LOCAL …`) → work → `COMMIT`; on error `ROLLBACK` (on a dead or deadline-expired connection that fails too,
 * and the connection is discarded). `beginWith`: the same connection, running `begin` with a different deadline. */
export async function runInTransaction<T>(
  connection: Connection,
  begin: string,
  work: (connection: Connection) => Promise<T>,
  beginWith: Connection = connection,
): Promise<T> {
  await beginWith.exec(begin);
  try {
    const result = await work(connection);
    await connection.exec("COMMIT");
    return result;
  } catch (error) {
    await connection.exec("ROLLBACK").catch(() => {});
    throw error;
  }
}
