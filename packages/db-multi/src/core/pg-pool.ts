/** Factory for `pg`-compatible pool drivers: node-postgres (`drivers/pg.ts`) and Neon serverless (`drivers/neon.ts`) expose the same surface.
 * This file does not import `pg` or `@neondatabase/serverless`, so the optional peers do not become dependencies of each other (or of the Workers bundle). */
import { type Connection, type Driver, normalizeParams, withTimeout } from "./driver";

interface QueryResult {
  rows: unknown[];
  rowCount?: number | null;
}
export interface PgClient {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(error?: Error | boolean): void;
  on(event: "end" | "error", listener: () => void): unknown;
}
export interface PgPool {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  connect(): Promise<PgClient>;
  on(event: "error" | "connect", listener: (client: PgClient) => void): unknown;
  end(): Promise<void>;
}
type TypeParsers = { getTypeParser(oid: number, format?: "text" | "binary"): unknown };
export interface PgPoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds: number;
  connectionTimeoutMillis: number;
  types: TypeParsers;
}
/** The surface of the `pg` module (or Neon's) that this factory uses; since the two packages declare their types differently, the caller passes it as `as unknown as PgModule`. */
export interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPool;
  types: TypeParsers;
}
export interface PgDriverOptions {
  /** Cancels the client's running statement on the server; if not provided, `Reserved.cancel` is not defined (the connection is discarded after the deadline). */
  cancel?(client: PgClient, url: string): void;
}

// Same values as the other drivers: date is a `Date` at UTC midnight, interval is text. Global parsers are left untouched.
const overrides: Record<number, (value: string) => unknown> = {
  1082: (value) => new Date(`${value}T00:00:00Z`),
  1186: (value) => value,
};

function connection(client: Pick<PgPool, "query">): Connection {
  return {
    // A parameterless query goes through the simple protocol; a parameterized query uses an unnamed statement.
    query: async <R>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, normalizeParams(values));
      const rows = result.rows as R[] & { count?: number };
      rows.count = result.rowCount ?? undefined;
      return rows;
    },
    exec: async (text) => {
      await client.query(text);
    },
  };
}

export function createPgDriver(module: PgModule, { cancel }: PgDriverOptions = {}): Driver {
  const types: TypeParsers = { getTypeParser: (oid, format) => overrides[oid] ?? module.types.getTypeParser(oid, format) };
  return (url, options) => {
    const pool = new module.Pool({
      connectionString: url,
      max: options.max,
      idleTimeoutMillis: options.idleTimeoutSeconds * 1000,
      maxLifetimeSeconds: options.maxLifetimeSeconds,
      connectionTimeoutMillis: options.connectTimeoutSeconds * 1000,
      types,
    });
    // An error on an idle connection must not bring the process down; the connection is already dropped from the pool.
    pool.on("error", () => {});
    // A connection that errors while borrowed is discarded on release. The listener is added once per connection (not per borrow).
    const broken = new WeakSet<PgClient>();
    pool.on("connect", (client) => {
      client.on("end", () => options.onClose?.());
      client.on("error", () => broken.add(client));
    });
    // pg-pool throws on a second end() call; sessions can still close after a connection loss has closed the pool.
    let ending: Promise<void> | undefined;
    return {
      ...connection(pool),
      async reserve() {
        const client = await pool.connect();
        return {
          ...connection(client),
          ...(cancel ? { cancel: () => cancel(client, url) } : {}),
          release: (discard) => client.release(broken.has(client) || discard === true),
        };
      },
      close: (ms) => withTimeout((ending ??= pool.end().catch(() => {})), ms),
    };
  };
}
