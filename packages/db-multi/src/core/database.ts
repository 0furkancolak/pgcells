/** Adapts the driver pool to the engine's query path and keeps the pools per DB. Connection acquisition has a client-side deadline and a limit
 * on pending work. At runtime the server-side timeout is a DB default (`bootstrap`: `ALTER DATABASE … SET statement_timeout/
 * lock_timeout/client_connection_check_interval`; it also applies under PgBouncer transaction pooling and Hyperdrive): a single query is a single
 * round trip, and a transaction costs only `BEGIN`. Pools given `timeouts` (management) run every job in a transaction with `SET LOCAL`.
 *
 * Every statement (`BEGIN`, transaction statements, `COMMIT`/`ROLLBACK`, `exec`) runs on a reserved connection with an answer deadline. The connection of a
 * statement that expires is cancelled (if the driver supports it), the answer is awaited briefly, and the connection never returns to the pool (see `deadlineSession`). */
import { type Config, type DatabaseNode, PLATFORM_DATABASE_ID } from "./config";
import { type Connection, type Driver, type Pool, type PoolOptions, type Reserved, runInTransaction } from "./driver";
import { AppError, DeadlineError, errorCode } from "./errors";

export interface Timeouts {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}
export interface TransactionOptions extends Partial<Timeouts> {
  /** Appended after `BEGIN`, e.g. `" ISOLATION LEVEL REPEATABLE READ READ ONLY"` (fixed text, not input). */
  mode?: string;
  /** Only marks the tenant in the `onSpan` span; not sent to the driver. */
  tenantId?: string;
}
/** Pool counters of one database client (`db.stats()`); plain numbers, no tracing backend needed. */
export interface PoolStats {
  /** Connections reserved right now by statements or transactions. */
  inUse: number;
  /** Jobs accepted but still waiting for a connection. */
  waiting: number;
  /** The limit on accepted jobs (`DATABASE_BUSY` beyond it). */
  maxPending: number;
  /** Time to obtain a connection over the last 256 acquisitions (ms); `null` before the first one. */
  acquireP50Ms: number | null;
  acquireP99Ms: number | null;
  /** Connections thrown away because a statement outlived its deadline. */
  expiredDiscarded: number;
  /** Jobs refused with `DATABASE_BUSY` since the client was opened. */
  busyRejected: number;
}
export interface Database extends Connection {
  transaction<T>(work: (tx: Connection) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** The raw pool with no deadline or wait limit: for special jobs such as `pg_cancel_backend` and `CREATE DATABASE`. */
  readonly pool: Pool;
  stats(): PoolStats;
  close(): Promise<void>;
}
/** Measurement point: `db.acquire` (waiting for a connection), `db.query`, `db.transaction` (BEGIN…COMMIT), `placement.read`/`placement.cache`,
 * and in management the operation steps (`provision.*`, `migration`, `seed`, `move.*`, `backup.tenant`). */
export interface Span {
  name: string;
  /** Start (Unix epoch, ms). */
  startTime: number;
  ms: number;
  /** The stable error code (`errorCode`) if the work failed. */
  error?: string;
  databaseId?: string;
  tenantId?: string;
  detail?: string;
}
export type SpanHandler = (span: Span) => void;
/** A span reported by management steps: if `startTime` is not given, it is computed from the end time. */
export type SpanInput = Omit<Span, "startTime"> & { startTime?: number };

export interface DatabaseSettings {
  /** Connection-acquisition deadline (the statement timeout in a transaction with timeouts); the statement's answer deadline is `ANSWER_MARGIN_MS` longer than this. */
  deadlineMs: number;
  maxPending: number;
  timeouts?: Timeouts;
  databaseId?: string;
  onSpan?: SpanHandler;
}

/** SQLSTATE `query_canceled`: the server's statement timeout or a cancel. */
const QUERY_CANCELED = "57014";
/** A statement's answer time is this much longer than the server timeout; the server's statement_timeout normally fires first. */
const ANSWER_MARGIN_MS = 1000;
/** The longest the answer (a result or 57014) is awaited after an expired statement has been cancelled. */
const CANCEL_WAIT_MS = 500;
const POOL_CLOSE_TIMEOUT_MS = 5000;
/** Connection-acquisition times kept for the percentiles of `stats()`. */
const ACQUIRE_SAMPLES = 256;
const CONNECT_TIMEOUT_SECONDS = 10;

/** `workStarted`: whether the statement had been sent when the deadline expired (default yes: the safe assumption for callers deciding on a retry). */
export const deadlineExceeded = (workStarted = true) => new DeadlineError(workStarted);

/** The server's statement timeout (57014) becomes `DATABASE_TIMEOUT`; other errors stay as they are. */
const mapServerTimeout = (error: unknown) => (errorCode(error) === QUERY_CANCELED ? deadlineExceeded() : error);

/** A function that returns the time elapsed (ms) since it was started. */
export function stopwatch() {
  const start = performance.now();
  return () => performance.now() - start;
}

/** Returns the work as it is if there is no `onSpan` (no extra await on the hot path). */
/** A telemetry adapter's error never fails the database work. */
export function reportSpan(onSpan: SpanHandler, span: Span) {
  try {
    onSpan(span);
  } catch {
    // A telemetry error is ignored.
  }
}

export function spanner(onSpan: SpanHandler | undefined, base: Omit<Span, "name" | "ms" | "startTime"> = {}) {
  return <T>(name: string, work: () => Promise<T>, extra?: Omit<Span, "name" | "ms" | "startTime">): Promise<T> => {
    if (!onSpan) return work();
    const startTime = Date.now();
    const start = performance.now();
    const finish = (error?: unknown) =>
      reportSpan(onSpan, { name, startTime, ms: performance.now() - start, ...base, ...extra, ...(error === undefined ? {} : { error: errorCode(error) }) });
    return work().then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish(error);
        throw error;
      },
    );
  };
}

/** Connection-acquisition and answer deadlines. There is no timer per statement: a single timer is set for the entry that expires earliest;
 * when it fires, the `expire` of those that have expired is called and the timer is re-armed for the next earliest entry (it does not keep the process alive). Under heavy traffic
 * entries are removed before they expire; the timer fires at most once per deadline. */
interface Deadline {
  due: number;
  expire: () => void;
}
function createDeadlines() {
  const inflight = new Set<Deadline>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDue = Number.POSITIVE_INFINITY;

  function arm(due: number) {
    if (due >= timerDue) return;
    clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(fire, Math.max(0, due - performance.now()));
    (timer as { unref?: () => void }).unref?.();
  }

  function fire() {
    timer = undefined;
    timerDue = Number.POSITIVE_INFINITY;
    const now = performance.now();
    let next = Number.POSITIVE_INFINITY;
    for (const entry of inflight)
      if (entry.due <= now) {
        inflight.delete(entry);
        entry.expire();
      } else if (entry.due < next) next = entry.due;
    if (next !== Number.POSITIVE_INFINITY) arm(next);
  }

  /** `expire` after `ms`; `unwatch(entry)` removes the entry. */
  function watch(ms: number, expire: () => void): Deadline {
    const entry = { due: performance.now() + ms, expire };
    inflight.add(entry);
    arm(entry.due);
    return entry;
  }

  return { watch, unwatch: (entry: Deadline) => void inflight.delete(entry), close: () => clearTimeout(timer) };
}
type Deadlines = ReturnType<typeof createDeadlines>;

/**
 * Statements with deadlines on a reserved connection. When a statement's deadline expires, the connection becomes "expired": no other statement runs on it and
 * it does not return to the pool (`release(true)`). If the driver supports it, the statement is cancelled on the server and the answer is awaited for `CANCEL_WAIT_MS`: an
 * answer that arrives within that time is returned as it is (if the statement committed, the caller sees that), otherwise `DATABASE_TIMEOUT`. The server stops the still-running statement of the
 * discarded connection via `client_connection_check_interval`; an uncommitted transaction is rolled back, and a statement waiting in the PgBouncer queue never goes through.
 */
class DeadlineSession {
  private expired = false;
  /** Whether a deadline expired on this connection (it is then discarded on release). */
  get wasExpired() {
    return this.expired;
  }
  constructor(
    readonly reserved: Reserved,
    private readonly deadlines: Deadlines,
  ) {}

  /** A statement whose answer deadline is `ms` (`undefined`: server timeout only). */
  bounded<T>(ms: number | undefined, answer: () => Promise<T>): Promise<T> {
    if (this.expired) return Promise.reject(deadlineExceeded(false));
    const pending = answer();
    if (ms === undefined) return pending;
    return new Promise<T>((resolve, reject) => {
      let wait: ReturnType<typeof setTimeout> | undefined;
      const entry = this.deadlines.watch(ms, () => {
        this.expired = true;
        this.reserved.cancel?.();
        wait = setTimeout(() => reject(deadlineExceeded()), CANCEL_WAIT_MS);
      });
      pending.then(
        (value) => {
          this.deadlines.unwatch(entry);
          if (wait !== undefined) clearTimeout(wait);
          resolve(value);
        },
        (error: unknown) => {
          this.deadlines.unwatch(entry);
          if (wait !== undefined) clearTimeout(wait);
          reject(error);
        },
      );
    });
  }

  /** A view whose answer deadline is `ms`. */
  connection(ms: number | undefined): Connection {
    return {
      query: (text, params) => this.bounded(ms, () => this.reserved.query(text, params)),
      exec: (text) => this.bounded(ms, () => this.reserved.exec(text)),
    };
  }

  release() {
    this.reserved.release(this.expired);
  }
}

/** If the deadline expires, the work never starts; a connection that arrives late is returned unused. */
function acquireWithin(pool: Pool, ms: number, deadlines: Deadlines): Promise<Reserved> {
  return new Promise<Reserved>((resolve, reject) => {
    let late = false;
    const entry = deadlines.watch(ms, () => {
      late = true;
      reject(deadlineExceeded(false));
    });
    pool.reserve().then(
      (connection) => {
        if (late) return connection.release();
        deadlines.unwatch(entry);
        resolve(connection);
      },
      (error: unknown) => {
        if (late) return;
        deadlines.unwatch(entry);
        reject(error);
      },
    );
  });
}

/** The `BEGIN` and `SET LOCAL` text; a timeout not given in the options comes from the pool's `timeouts` value. */
function beginSql(options: TransactionOptions, timeouts: Timeouts | undefined) {
  const statementTimeoutMs = options.statementTimeoutMs ?? timeouts?.statementTimeoutMs;
  const lockTimeoutMs = options.lockTimeoutMs ?? timeouts?.lockTimeoutMs;
  const statements = [`BEGIN${options.mode ?? ""}`];
  if (statementTimeoutMs !== undefined) statements.push(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
  if (lockTimeoutMs !== undefined) statements.push(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
  return { begin: statements.join("; "), statementTimeoutMs };
}

export function connect(pool: Pool, { deadlineMs, maxPending, timeouts, databaseId, onSpan }: DatabaseSettings): Database {
  let pending = 0;
  // Counters for `stats()`: a few integer operations per statement, no allocation.
  let inUse = 0;
  let busyRejected = 0;
  let expiredDiscarded = 0;
  let sampled = 0;
  const samples = new Float64Array(ACQUIRE_SAMPLES);
  const sample = (ms: number) => void (samples[sampled++ % ACQUIRE_SAMPLES] = ms);
  const percentile = (sorted: Float64Array, fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? null;
  function stats(): PoolStats {
    const sorted = samples.slice(0, Math.min(sampled, ACQUIRE_SAMPLES)).sort();
    return {
      inUse,
      waiting: Math.max(0, pending - inUse),
      maxPending,
      acquireP50Ms: sorted.length ? percentile(sorted, 0.5) : null,
      acquireP99Ms: sorted.length ? percentile(sorted, 0.99) : null,
      expiredDiscarded,
      busyRejected,
    };
  }
  const timed = spanner(onSpan, { databaseId });
  // If PgBouncer is left without a server (DB down), the answer does not arrive until `query_wait_timeout`; the server timeout has no effect.
  const deadlines = createDeadlines();
  const answerMs = deadlineMs + ANSWER_MARGIN_MS;
  const acquire = (ms: number) => acquireWithin(pool, ms, deadlines);

  /** Work on a reserved connection; `DATABASE_BUSY` if the pending-work limit is reached. */
  async function withReserved<T>(acquireMs: number, work: (session: DeadlineSession) => Promise<T>, tenantId?: string): Promise<T> {
    if (pending >= maxPending) {
      busyRejected++;
      throw new AppError("DATABASE_BUSY", "Database client is saturated");
    }
    pending++;
    try {
      const acquireStart = performance.now();
      const reserved = await (onSpan ? timed("db.acquire", () => acquire(acquireMs), { tenantId }) : acquire(acquireMs));
      sample(performance.now() - acquireStart);
      inUse++;
      const session = new DeadlineSession(reserved, deadlines);
      try {
        return await work(session);
      } finally {
        inUse--;
        if (session.wasExpired) expiredDiscarded++;
        session.release();
      }
    } catch (error) {
      throw mapServerTimeout(error);
    } finally {
      pending--;
    }
  }

  function transaction<T>(work: (tx: Connection) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const { begin, statementTimeoutMs } = beginSql(options, timeouts);
    // `statement_timeout = 0` leaves statements unbounded; BEGIN (waiting for a server under PgBouncer) always has a deadline.
    const statementMs = statementTimeoutMs === 0 ? undefined : (statementTimeoutMs ?? deadlineMs) + ANSWER_MARGIN_MS;
    return withReserved(
      statementTimeoutMs || deadlineMs,
      (session) =>
        timed("db.transaction", () => runInTransaction(session.connection(statementMs), begin, work, session.connection(answerMs)), {
          tenantId: options.tenantId,
        }),
      options.tenantId,
    );
  }

  /** A single statement (the runtime's hot path): connection acquisition and the answer share a single deadline entry; once the connection arrives, the entry is
   * extended to the answer deadline. Behavior is the same as `withReserved` + `DeadlineSession`: if acquisition expires, the statement never goes through and a late
   * connection is released unused; if the answer time expires, the statement is cancelled, an answer arriving within `CANCEL_WAIT_MS` is returned, and the connection is discarded. */
  function single<T>(statement: (connection: Reserved) => Promise<T>, detail?: string, tenantId?: string): Promise<T> {
    if (pending >= maxPending) {
      busyRejected++;
      return Promise.reject(new AppError("DATABASE_BUSY", "Database client is saturated"));
    }
    pending++;
    const acquireStart = performance.now();
    const acquireTime = onSpan ? Date.now() : 0;
    let queryStart = 0;
    let queryTime = 0;
    return new Promise<T>((resolve, reject) => {
      let reserved: Reserved | undefined;
      let expired = false;
      let settled = false;
      let wait: ReturnType<typeof setTimeout> | undefined;
      const span = (name: string, startTime: number, start: number, error: unknown, failed: boolean, spanDetail?: string) =>
        reportSpan(onSpan as SpanHandler, {
          name,
          startTime,
          ms: performance.now() - start,
          databaseId,
          ...(tenantId ? { tenantId } : {}),
          ...(spanDetail ? { detail: spanDetail } : {}),
          ...(failed ? { error: errorCode(error) } : {}),
        });
      const settle = (failed: boolean, outcome: unknown) => {
        if (settled) return;
        settled = true;
        deadlines.unwatch(entry);
        if (wait !== undefined) clearTimeout(wait);
        if (onSpan) {
          if (reserved) span("db.query", queryTime, queryStart, outcome, failed, detail);
          else span("db.acquire", acquireTime, acquireStart, outcome, failed);
        }
        if (reserved) {
          inUse--;
          if (expired) expiredDiscarded++;
          reserved.release(expired);
        }
        pending--;
        if (failed) reject(mapServerTimeout(outcome));
        else resolve(outcome as T);
      };
      const entry = deadlines.watch(deadlineMs, () => {
        if (!reserved) return settle(true, deadlineExceeded(false));
        expired = true;
        reserved.cancel?.();
        wait = setTimeout(() => settle(true, deadlineExceeded()), CANCEL_WAIT_MS);
      });
      pool.reserve().then(
        (connection) => {
          if (settled) return connection.release();
          reserved = connection;
          inUse++;
          sample(performance.now() - acquireStart);
          if (onSpan) {
            span("db.acquire", acquireTime, acquireStart, undefined, false);
            queryStart = performance.now();
            queryTime = Date.now();
          }
          // Answer deadline: the timer stays armed for the earlier time and, when it fires, is re-armed for this entry.
          entry.due = performance.now() + answerMs;
          let answer: Promise<T>;
          try {
            answer = statement(connection);
          } catch (error) {
            return settle(true, error);
          }
          answer.then(
            (value) => settle(false, value),
            (error: unknown) => settle(true, error),
          );
        },
        (error: unknown) => settle(true, error),
      );
    });
  }

  function query(text: string, params?: readonly unknown[], tenantId?: string) {
    if (timeouts) return transaction((tx) => tx.query(text, params), { tenantId });
    return single((connection) => connection.query(text, params), text, tenantId);
  }

  const exec = (text: string) => (timeouts ? transaction((tx) => tx.exec(text)) : single((connection) => connection.exec(text), text));

  return {
    pool,
    transaction,
    query: query as Database["query"],
    exec,
    stats,
    close: () => {
      deadlines.close();
      return pool.close(POOL_CLOSE_TIMEOUT_MS);
    },
  };
}

type PoolConfig = Config & Pick<PoolOptions, "idleTimeoutSeconds" | "maxLifetimeSeconds">;
export type Pools = ReturnType<typeof createPools>;

/** One bounded pool per configured DB (not per tenant); db0's is the platform pool. */
export function createPools(config: PoolConfig, driver: Driver, max: number, settings: DatabaseSettings) {
  const { idleTimeoutSeconds, maxLifetimeSeconds } = config;
  const databases = new Map<string, Database>();
  const replicaDatabases = new Map<string, Database[]>();
  let closed = false;

  function nodeConfig(id: string): DatabaseNode {
    const node = config.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new AppError("DATABASE_NOT_FOUND", `Database ${id} is not configured`);
    return node;
  }

  function open(id: string): Database {
    const pool = driver(nodeConfig(id).url, { max, idleTimeoutSeconds, maxLifetimeSeconds, connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS });
    return connect(pool, { ...settings, databaseId: id });
  }

  function node(id: string): Database {
    if (closed) throw new AppError("DATABASE_CLOSED", "Database clients are closed");
    let db = databases.get(id);
    if (!db) {
      db = open(id);
      databases.set(id, db);
    }
    return db;
  }

  /** The node's replica pools (in config order); opened lazily, each gets `max` connections. */
  function replicas(id: string): readonly Database[] {
    if (closed) throw new AppError("DATABASE_CLOSED", "Database clients are closed");
    const urls = nodeConfig(id).replicas;
    let list = replicaDatabases.get(id);
    if (!list) {
      list = urls.map((url) =>
        connect(driver(url, { max, idleTimeoutSeconds, maxLifetimeSeconds, connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS }), { ...settings, databaseId: id }),
      );
      replicaDatabases.set(id, list);
    }
    return list;
  }

  /** Counters of every pool opened so far: `db0`, `db1`, … and `db0#1` for a node's first replica. */
  function stats(): Record<string, PoolStats> {
    const result: Record<string, PoolStats> = {};
    for (const [id, db] of databases) result[id] = db.stats();
    for (const [id, list] of replicaDatabases) for (const [index, db] of list.entries()) result[`${id}#${index + 1}`] = db.stats();
    return result;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const outcomes = await Promise.allSettled([...databases.values(), ...[...replicaDatabases.values()].flat()].map((db) => db.close()));
    databases.clear();
    replicaDatabases.clear();
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  return { platform: node(PLATFORM_DATABASE_ID), node, replicas, nodeConfig, stats, close };
}
