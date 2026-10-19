/** Factory for `pg`-compatible pool drivers: node-postgres (`drivers/pg.ts`) and Neon serverless (`drivers/neon.ts`) expose the same surface.
 * This file does not import `pg` or `@neondatabase/serverless`: optional peers must not become a dependency of each other (or of the Workers bundle). */
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
/** The surface of the `pg` module (or Neon's) that this factory uses; since the two packages declare their types differently, the caller passes it with `as unknown as PgModule`. */
export interface PgModule {
  Pool: new (config: PgPoolConfig) => PgPool;
  types: TypeParsers;
}
export interface PgDriverOptions {
  /** Cancels the client's running statement on the server; if omitted, `Reserved.cancel` is not defined (the connection is discarded after the deadline). */
  cancel?(client: PgClient, url: string): void;
}

// Same values as the other drivers: date as a UTC-midnight `Date`, interval as text. Global parsers are left untouched.
const overrides: Record<number, (value: string) => unknown> = {
  1082: (value) => new Date(`${value}T00:00:00Z`),
  1186: (value) => value,
};

function connection(client: Pick<PgPool, "query">): Connection {
  return {
    // A parameterless query goes over the simple protocol; a parameterized query uses an unnamed statement.
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
    // An error on an idle connection must not kill the process; the connection is dropped from the pool anyway.
    pool.on("error", () => {});
    // A connection that errored while borrowed is discarded on release. The listener is added once per connection (not per borrow).
    const broken = new WeakSet<PgClient>();
    pool.on("connect", (client) => {
      client.on("end", () => options.onClose?.());
      client.on("error", () => broken.add(client));
    });
    // pg-pool throws on a second end() call; sessions may still close after a connection loss has shut the pool down.
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
