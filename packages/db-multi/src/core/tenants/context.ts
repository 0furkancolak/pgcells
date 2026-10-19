/** Binds prepared SQL to the context's schema and manages the query, transaction and context lifetime (tenant, node, platform). */
import type { ReplicaPolicy } from "../config";
import type { Database, Pools } from "../database";
import type { Connection, Row } from "../driver";
import { AppError, databaseUnavailable } from "../errors";
import { isPreparedQuery, type PreparedQuery, type QueryScope } from "../sql/query";
import { type Placement, requireActive } from "./model";
import type { ReplicaHandle, ReplicaRouter } from "./replicas";

export interface TenantContext {
  query<R extends unknown[] = Row[]>(query: PreparedQuery, values?: readonly unknown[]): Promise<R>;
  transaction<T>(work: (db: TenantContext) => Promise<T>): Promise<T>;
}

/** A read context from a replica: `readOnly` queries only; there is no transaction. */
export type ReadContext = Pick<TenantContext, "query">;
/** `readOnly`: a read context (an error is recoverable as in autocommit; a writing query is rejected). `onWrite`: called when a non-`readOnly` query
 * runs (including those inside a transaction); the request scope uses it to direct reads to the primary after a write. */
export interface ContextMode {
  readOnly?: boolean;
  onWrite?: () => void;
}

/** The read session of a request scope: reads within the scope are pinned to the replica chosen by the first read (monotonic reads across calls);
 * if the replica drops with a connection error the pin is released and the next read picks again. */
export interface ReadSession {
  handle?: ReplicaHandle;
}

/** A single immutable context per request; the transaction is optional, tenant routing state never is. */
export function createWithTenant(pools: Pick<Pools, "node">, placements: { get(id: string): Placement | Promise<Placement> }) {
  function forPlacement<T>(placement: Placement, work: (db: TenantContext) => Promise<T>, onWrite?: () => void): Promise<T> {
    let db: Database;
    try {
      // The schema/tenant match is validated when the placement is read; bind() checks the identifier.
      requireActive(placement);
      db = pools.node(placement.databaseId);
    } catch (error) {
      return Promise.reject(error);
    }
    return runContext(db, db, placement.schemaName, "tenant", work, placement.tenantId, { onWrite });
  }
  // A cached placement arrives synchronously: no extra `await` turn is added.
  const withTenant = <T>(id: string, work: (db: TenantContext) => Promise<T>, onWrite?: () => void): Promise<T> => {
    let placement: Placement | Promise<Placement>;
    try {
      placement = placements.get(id);
    } catch (error) {
      return Promise.reject(error);
    }
    return placement instanceof Promise ? placement.then((read) => forPlacement(read, work, onWrite)) : forPlacement(placement, work, onWrite);
  };
  return Object.assign(withTenant, { forPlacement });
}

/** Without `transactionDatabase`, `connection` is already a transaction (a nested transaction is rejected); seeds use this too.
 * `tenantId` marks the tenant only in the `onSpan` span (see `Connection.query`, `TransactionOptions.tenantId`). */
export async function runContext<T>(
  connection: Connection,
  transactionDatabase: Database | undefined,
  schema: string,
  scope: QueryScope,
  work: (db: TenantContext) => Promise<T>,
  tenantId?: string,
  mode: ContextMode = {},
) {
  const insideTransaction = !transactionDatabase && !mode.readOnly;
  let isOpen = true;
  let failure: { error: unknown } | undefined;
  // Unfinished queries; created on the first query. The reaction runs when the query settles, before the caller's continuation, so an awaited query does not remain in the set.
  let running: Set<Promise<unknown>> | undefined;

  function track<R>(operation: Promise<R>): Promise<R> {
    const pending = (running ??= new Set());
    pending.add(operation);
    operation.then(
      () => void pending.delete(operation),
      (error: unknown) => {
        // An error caught inside a transaction also aborts the transaction; in autocommit the caller can recover.
        if (insideTransaction) failure = { error };
        pending.delete(operation);
      },
    );
    return operation;
  }

  function assertOpen() {
    if (!isOpen) throw new AppError("TRANSACTION_CLOSED", "Tenant database context is closed");
  }

  function assertRunnable(query: PreparedQuery) {
    if (!isPreparedQuery(query)) throw new AppError("INVALID_QUERY", "Use a prepared tenant query");
    if (query.scope !== scope) throw new AppError("QUERY_SCOPE", `A ${query.scope} query cannot run in a ${scope} context`);
    if (mode.readOnly && !query.readOnly) throw new AppError("QUERY_NOT_READ_ONLY", "Read contexts run read-only queries only");
    if (query.requiresTransaction && !insideTransaction) throw new AppError("TRANSACTION_REQUIRED", "Row locks require db.transaction");
  }

  const context: TenantContext = Object.freeze({
    query<R extends unknown[] = Row[]>(query: PreparedQuery, values: readonly unknown[] = []): Promise<R> {
      assertOpen();
      assertRunnable(query);
      if (!query.readOnly) mode.onWrite?.();
      return track(connection.query(query.bind(schema), values, tenantId) as Promise<R>);
    },
    transaction<R>(callback: (tx: TenantContext) => Promise<R>): Promise<R> {
      assertOpen();
      if (!transactionDatabase) throw new AppError("NESTED_TRANSACTION", "Nested transactions are not supported");
      return track(transactionDatabase.transaction((tx) => runContext(tx, undefined, schema, scope, callback, tenantId, { onWrite: mode.onWrite }), { tenantId }));
    },
  });

  let result: T;
  try {
    result = await work(context);
  } finally {
    isOpen = false;
    // The transaction cannot be committed/rolled back while un-awaited queries are still running.
    if (running?.size) await Promise.allSettled(running);
  }
  if (failure) throw failure.error;
  return result;
}

const NOT_READ_ONLY = () => Promise.reject(new AppError("QUERY_NOT_READ_ONLY", "Read contexts run prepared read-only queries only"));

/** Reads on the primary: every query runs in a `READ ONLY` transaction (a second safeguard against functions with side effects). */
const primaryReads = (db: Database): Connection => ({
  query: ((text: string, params?: readonly unknown[], tenantId?: string) =>
    db.transaction((tx) => tx.query(text, params), { mode: " READ ONLY", tenantId })) as Connection["query"],
  exec: NOT_READ_ONLY,
});

/** Reads on a replica: a connection error marks the replica `up = false` (a SQL error does not); the error surfaces either way. */
const replicaReads = ({ db, markDown }: { db: Database; markDown(): void }): Connection => ({
  query: (async (text: string, params?: readonly unknown[], tenantId?: string) => {
    try {
      return await db.query(text, params, tenantId);
    } catch (error) {
      if (databaseUnavailable(error)) markDown();
      throw error;
    }
  }) as Connection["query"],
  exec: NOT_READ_ONLY,
});

/** Each call is pinned to a replica. If there is no healthy replica (or none is configured), `onUnavailable`: `READ ONLY` on the primary
 * or `REPLICA_UNAVAILABLE`. `afterWrite`: a write happened in the same request, so reads stay on the primary regardless of the policy. */
export function createWithTenantRead(
  pools: Pick<Pools, "node">,
  placements: { get(id: string): Placement | Promise<Placement> },
  router: Pick<ReplicaRouter, "pick">,
  onUnavailable: ReplicaPolicy,
) {
  async function forPlacement<T>(placement: Placement, work: (db: ReadContext) => Promise<T>, afterWrite = false, session?: ReadSession): Promise<T> {
    requireActive(placement);
    const primary = pools.node(placement.databaseId);
    let handle = afterWrite ? undefined : (session?.handle ?? (await router.pick(placement.databaseId)));
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
    else if (afterWrite || onUnavailable === "primary") connection = primaryReads(primary);
    else throw new AppError("REPLICA_UNAVAILABLE", `No usable replica for database ${placement.databaseId}`);
    return runContext(connection, undefined, placement.schemaName, "tenant", work, placement.tenantId, { readOnly: true });
  }
  const withTenantRead = async <T>(id: string, work: (db: ReadContext) => Promise<T>): Promise<T> => forPlacement(await placements.get(id), work);
  return Object.assign(withTenantRead, { forPlacement });
}
