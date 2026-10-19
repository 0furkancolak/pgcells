/** Binds prepared SQL to the schema and manages the lifetime of queries, transactions and the context. */
import type { ReplicaPolicy } from "./config";
import type { Database, Pools } from "./database";
import type { Connection, Row } from "./driver";
import { AppError, databaseUnavailable } from "./errors";
import type { ReplicaHandle, ReplicaRouter } from "./replicas";
import { isPreparedQuery, type PreparedQuery } from "./sql/query";

export interface Queryable {
  query<R extends unknown[] = Row[]>(query: PreparedQuery, values?: readonly unknown[]): Promise<R>;
  transaction<T>(work: (db: Queryable) => Promise<T>): Promise<T>;
}

/** Read context against a replica: `readOnly` queries only; there are no transactions. */
export type ReadContext = Pick<Queryable, "query">;
/** `readOnly`: read context (an error is recoverable as in autocommit, and a writing query is rejected). `onWrite`: called when a non-`readOnly`
 * query runs (including those inside transactions); the request scope uses it to route reads to the primary after a write. */
export interface ContextMode {
  readOnly?: boolean;
  onWrite?: () => void;
}

/** The read session of a request scope: reads within the scope are pinned to the replica chosen by the first read (monotonic reads across calls);
 * if the replica fails with a connection error, the pin is dropped and the next read picks again. */
export interface ReadSession {
  handle?: ReplicaHandle;
}

/** Without `transactionDatabase`, `connection` is already a transaction (nested transactions are rejected); seeds use this too. */
export async function runContext<T>(
  connection: Connection,
  transactionDatabase: Database | undefined,
  schema: string,
  work: (db: Queryable) => Promise<T>,
  mode: ContextMode = {},
) {
  const insideTransaction = !transactionDatabase && !mode.readOnly;
  let isOpen = true;
  let failure: { error: unknown } | undefined;
  // Unfinished queries; created on the first query. The reaction runs when the query settles, before the caller's continuation, so an awaited query does not stay in the set.
  let running: Set<Promise<unknown>> | undefined;

  function track<R>(operation: Promise<R>): Promise<R> {
    const pending = (running ??= new Set());
    pending.add(operation);
    operation.then(
      () => void pending.delete(operation),
      (error: unknown) => {
        // An error caught inside a transaction still fails the transaction; in autocommit the caller can recover.
        if (insideTransaction) failure = { error };
        pending.delete(operation);
      },
    );
    return operation;
  }

  function assertOpen() {
    if (!isOpen) throw new AppError("TRANSACTION_CLOSED", "Database context is closed");
  }

  function assertRunnable(query: PreparedQuery) {
    if (!isPreparedQuery(query)) throw new AppError("INVALID_QUERY", "Use a prepared query");
    if (mode.readOnly && !query.readOnly) throw new AppError("QUERY_NOT_READ_ONLY", "Read contexts run read-only queries only");
    if (query.requiresTransaction && !insideTransaction) throw new AppError("TRANSACTION_REQUIRED", "Row locks require db.transaction");
  }

  const context: Queryable = Object.freeze({
    query<R extends unknown[] = Row[]>(query: PreparedQuery, values: readonly unknown[] = []): Promise<R> {
      assertOpen();
      assertRunnable(query);
      if (!query.readOnly) mode.onWrite?.();
      return track(connection.query(query.bind(schema), values) as Promise<R>);
    },
    transaction<R>(callback: (tx: Queryable) => Promise<R>): Promise<R> {
      assertOpen();
      if (!transactionDatabase) throw new AppError("NESTED_TRANSACTION", "Nested transactions are not supported");
      return track(transactionDatabase.transaction((tx) => runContext(tx, undefined, schema, callback, { onWrite: mode.onWrite })));
    },
  });

  let result: T;
  try {
    result = await work(context);
  } finally {
    isOpen = false;
    // A transaction cannot be committed/rolled back while un-awaited queries are still running.
    if (running?.size) await Promise.allSettled(running);
  }
  if (failure) throw failure.error;
  return result;
}

const NOT_READ_ONLY = () => Promise.reject(new AppError("QUERY_NOT_READ_ONLY", "Read contexts run prepared read-only queries only"));

/** Read on the primary. `readOnlyTransaction`: a replica is configured but unavailable; to keep the same meaning as a replica read, the read runs
 * in a `READ ONLY` transaction. Otherwise a single statement (one round trip); the `readOnly` flag was checked at compile time. */
const primaryReads = (db: Database, readOnlyTransaction: boolean): Connection => ({
  query: (readOnlyTransaction
    ? (text: string, params?: readonly unknown[]) => db.transaction((tx) => tx.query(text, params), { mode: " READ ONLY" })
    : (text: string, params?: readonly unknown[]) => db.query(text, params)) as Connection["query"],
  exec: NOT_READ_ONLY,
});

/** Read on a replica: a connection error marks the replica `up = false` (an SQL error does not); the error surfaces in every case. */
const replicaReads = ({ db, markDown }: { db: Database; markDown(): void }): Connection => ({
  query: (async (text: string, params?: readonly unknown[]) => {
    try {
      return await db.query(text, params);
    } catch (error) {
      if (databaseUnavailable(error)) markDown();
      throw error;
    }
  }) as Connection["query"],
  exec: NOT_READ_ONLY,
});

/** Each call is pinned to a replica. With no healthy replica, `onUnavailable` applies: primary or `REPLICA_UNAVAILABLE`. A primary read is a single
 * statement; it runs in a `READ ONLY` transaction only when a replica is configured but unavailable. `afterWrite`: a write happened in the same request,
 * so the read stays on the primary regardless of policy (single statement). If no replica is configured, the router is never asked. */
export function createReader(pools: Pick<Pools, "primary" | "replicaUrls">, router: Pick<ReplicaRouter, "pick">, onUnavailable: ReplicaPolicy, schema: string) {
  return async function read<T>(work: (db: ReadContext) => Promise<T>, afterWrite = false, session?: ReadSession): Promise<T> {
    const configured = pools.replicaUrls.length > 0;
    let handle = afterWrite || !configured ? undefined : (session?.handle ?? (await router.pick()));
    if (handle && session) {
      const picked = handle;
      session.handle = picked;
      handle = {
        db: picked.db,
        markDown: () => {
          picked.markDown();
          if (session.handle === picked) session.handle = undefined;
        },
      };
    }
    let connection: Connection;
    if (handle) connection = replicaReads(handle);
    else if (afterWrite) connection = primaryReads(pools.primary, false);
    else if (onUnavailable === "primary") connection = primaryReads(pools.primary, configured);
    else throw new AppError("REPLICA_UNAVAILABLE", "No usable replica is available");
    return runContext(connection, undefined, schema, work, { readOnly: true });
  };
}
