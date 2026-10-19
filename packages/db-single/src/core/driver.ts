/** Driver contract: Bun SQL, postgres.js and pg implement this small interface (`core/drivers/*`). The engine uses no other driver API.
 * Value types are driver-independent: int8/numeric as string, date and timestamptz as `Date` (date at UTC midnight), json parsed,
 * uuid/interval as string, bytea as `Buffer`. */
export type Row = Record<string, unknown>;

export interface Connection {
  /** Text query with `$n` parameters; never uses a named prepared statement (PgBouncer/Hyperdrive safe).
   * The array carries the affected/returned row count in `count` (the `@0furkancolak/pgcells-single/auth` adapter's `updateMany`/`deleteMany`). */
  query<R = Row>(text: string, params?: readonly unknown[]): Promise<R[] & { count?: number }>;
  /** Parameterless, multi-statement simple-protocol execution (DDL, `BEGIN; SET LOCAL …`). */
  exec(sql: string): Promise<void>;
}
/** A single connection reserved from the pool; if it died, the driver discards it after `release`. */
export interface Reserved extends Connection {
  /** `discard`: the connection does not return to the pool but is closed (even before the running statement finishes); the next reservation opens a new connection. */
  release(discard?: boolean): void;
  /** Tries to cancel the statements running on this connection on the server (CancelRequest; PgBouncer forwards it to the right server). A driver without
   * reliable cancellation (Bun SQL) does not define this; in that case the connection is discarded and the server cuts the statement via `client_connection_check_interval`. */
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
  /** Called when a connection closes (the server terminated it, the network dropped); management sessions notice death this way. */
  onClose?: () => void;
}
export type Driver = (url: string, options: PoolOptions) => Pool;

/** `Date` parameters go as ISO UTC text on every driver: Bun with `prepare:false` sends `toString()` (rejected),
 * pg sends the local time offset (`::date` shifts by a day at a negative offset). */
export function normalizeParams(values: readonly unknown[] = []): unknown[] {
  // Hot path: without a `Date` the array is not copied (drivers do not modify the parameter array).
  for (const value of values) if (value instanceof Date) return values.map((item) => (item instanceof Date ? item.toISOString() : item));
  return values as unknown[];
}

/** Drivers do not offer the duration as their own guarantee; closing the pool ends with the same upper bound on every driver. */
export function withTimeout(work: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  // No timer is left once the work finishes (on Workers one pool is closed per request).
  return Promise.race([work.then(() => {}), expired]).finally(() => clearTimeout(timer));
}

/** `begin` (e.g. `BEGIN; SET LOCAL …`) → work → `COMMIT`; on error `ROLLBACK` (on a dead or past-deadline connection that fails too,
 * and the connection is discarded). `beginWith`: the same connection running `begin` with a different deadline. */
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
