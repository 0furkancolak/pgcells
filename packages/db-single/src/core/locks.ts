/** Management sessions: a reserved direct connection, death detection, server-side cancellation and advisory lock ownership.
 * Session advisory locks do not work behind a transaction pooler; when a session is opened, the connection is verified to be direct. */
import { reserveGuarded } from "./database";
import { type Connection, type Driver, type Pool, type Reserved, runInTransaction } from "./driver";
import { AppError, databaseUnavailable, driverError } from "./errors";
import type { Management } from "./management";

/** Watchdog: if there is still no answer this long after the server statement_timeout (or `watchdogMs`), the connection is considered dead. */
export const WATCHDOG_GRACE_MS = 5000;

/** A single advisory lock key: at most one migration/seed/baseline run at a time. */
export const MIGRATION_KEY = "migration";

const SESSION_SETTINGS_SQL =
  "SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),set_config('application_name',$3,false)";
const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked";
const LOCK_HELD_SQL =
  "SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1) AS held";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked";

const lockLost = (message = "Management connection closed") => new AppError("LOCK_LOST", message);
export const cancelled = () => new AppError("MIGRATION_CANCELLED", "Operation interrupted; inspect ledger before resuming");
const busy = () => new AppError("MIGRATION_RUNNER_BUSY", "Another migration run is active; retry when it finishes");

/** A single ownership check before every write: every held lock is alive and the job has not been cancelled. */
export function ownershipCheck(signal: AbortSignal, ...checks: (() => void | Promise<void>)[]) {
  return async () => {
    for (const check of checks) await check();
    if (signal.aborted) throw cancelled();
  };
}

/** A close error of the reserved pool is ignored: it does not change the actual result (error or success), and the raw message does not surface either. */
const closePool = (pool: Pool) => pool.close(1000).catch(() => {});

const backendPid = async (db: Connection) => Number((await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]?.pid);

/** URLs proven to be direct in this process; the probe costs one extra connection per URL. */
const direct = new Set<string>();

/** Early failure: behind a transaction pooler an independent connection lands on the same backend (LIFO reuse) or the reserved
 * session is moved between backends. Best effort: a busy pooler can hide itself in a single probe. */
async function assertDirect(driver: Driver, url: string, session: Connection, pid: number) {
  if (direct.has(url)) return;
  const probe = driver(url, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  try {
    if ((await backendPid(probe)) === pid || (await backendPid(session)) !== pid)
      throw new AppError(
        "DIRECT_CONNECTION_REQUIRED",
        "Management needs direct or session-pooled PostgreSQL URLs in DATABASE_URLS; transaction poolers (PgBouncer transaction mode, Hyperdrive) drop session advisory locks",
      );
    direct.add(url);
  } catch (error) {
    // The probe pool raises a raw driver error (the message may contain the host): it surfaces by its code only.
    throw driverError(error);
  } finally {
    await closePool(probe);
  }
}

/** Liveness state of the session: the loss (abort) signal, the closing flag and the watchdog that wraps every query. */
function createLiveness(pool: Pool, watchdogMs: number) {
  const aborter = new AbortController();
  const { signal } = aborter;
  const lost = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(lockLost()), { once: true }));
  lost.catch(() => {});
  let closed = false;

  function markLost() {
    if (signal.aborted) return;
    aborter.abort();
    void pool.close(0).catch(() => {});
  }
  function assertAlive() {
    if (signal.aborted || closed) throw lockLost();
  }
  /** The work ends with whichever comes first: session loss, a connection error or the watchdog timeout. */
  function guard<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        markLost();
        reject(lockLost());
      }, watchdogMs);
    });
    return Promise.race([work, lost, watchdog])
      .catch((error: unknown) => {
        if (databaseUnavailable(error)) markLost();
        throw error;
      })
      .finally(() => clearTimeout(timer));
  }
  return {
    signal,
    markLost,
    assertAlive,
    guard,
    /** Driver close notification: if it arrives before our own `close` call, the session has been lost. */
    onPoolClose: () => closed || markLost(),
    /** Marks the session as closing; false if it is already closed. */
    beginClose() {
      if (closed) return false;
      closed = true;
      return true;
    },
  };
}
type Liveness = ReturnType<typeof createLiveness>;

/** A connection that checks liveness before each query and wraps the query with the watchdog; transactions use the session's own timeouts. */
function guardedConnection(reserved: Reserved, { assertAlive, guard }: Liveness) {
  const db = {
    async query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<R[]> {
      assertAlive();
      return guard(reserved.query<R>(text, params));
    },
    async exec(text: string) {
      assertAlive();
      await guard(reserved.exec(text));
    },
    transaction: <T>(work: (tx: Connection) => Promise<T>): Promise<T> => runInTransaction(db, "BEGIN", work),
  };
  return db;
}

/** Internal session state needed for acquiring locks. */
interface LockHost {
  db: Connection;
  pid: number;
  /** Keys held in this session. */
  keys: Set<string>;
  assertAlive(): void;
  markLost(): void;
}

/** Takes a session advisory lock (never waits); since advisory locks are reentrant on a single connection, a second local
 * owner of the same key also counts as busy. */
async function acquireAdvisoryLock(host: LockHost, key: string) {
  host.assertAlive();
  if (host.keys.has(key)) throw busy();
  host.keys.add(key);
  let locked = false;
  try {
    const [row] = await host.db.query<{ locked: boolean }>(TRY_LOCK_SQL, [key]);
    locked = row?.locked === true;
    if (!locked) throw busy();
    const lock = heldLock(host, key);
    await lock.assertOwned();
    return lock;
  } catch (error) {
    host.keys.delete(key);
    if (locked) host.markLost();
    throw error;
  }
}

/** Checks and release of an acquired lock; if the release fails, the session is considered lost. */
function heldLock(host: LockHost, key: string) {
  let released = false;
  const assertAlive = () => {
    if (released) throw lockLost("Management lock released");
    host.assertAlive();
  };
  const assertOwned = async () => {
    assertAlive();
    const [row] = await host.db.query<{ pid: number; held: boolean }>(LOCK_HELD_SQL, [key]);
    if (row?.pid !== host.pid || !row.held) {
      host.markLost();
      throw lockLost("Management session lost its lock");
    }
  };
  const release = async () => {
    try {
      await assertOwned();
      const [row] = await host.db.query<{ unlocked: boolean }>(UNLOCK_SQL, [key]);
      if (!row?.unlocked) throw lockLost("Management session lost its lock");
      host.keys.delete(key);
      released = true;
    } catch (error) {
      host.markLost();
      throw error;
    }
  };
  return { pid: host.pid, assertOwned, assertAlive, release };
}

/** `watchdogMs`: the limit for waiting on the answer to a single statement; if omitted, the management statement timeout + 5 s (restore adapts this to hour-long statements). */
export type SessionOptions = { applicationName?: string; signal?: AbortSignal; watchdogMs?: number };
export type Session = Awaited<ReturnType<typeof openSession>>;

/**
 * A single reserved connection (its own max:1 pool) with management timeouts that never reconnects. It is lost when the driver reports a close,
 * when a query fails with a connection error or when the watchdog is exceeded; every pending and subsequent query is rejected.
 */
export async function openSession(m: Management, options: SessionOptions = {}) {
  const { url } = m.config;
  // If the connection cannot be established, Bun reports `onclose` before the `reserve` rejection: a close while reserve is in progress is not counted as a loss, and the rejection's code surfaces.
  const pool = m.driver(url, { max: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10, onClose: () => reserved && liveness.onPoolClose() });
  const liveness = createLiveness(pool, options.watchdogMs ?? m.config.migrationStatementTimeoutMs + WATCHDOG_GRACE_MS);
  const keys = new Set<string>();
  let reserved: Reserved | undefined;
  let pid = 0;

  /** Stops the running statement from another connection (Bun's native cancel is ineffective), then drops the session. */
  function cancel() {
    if (pid && !liveness.signal.aborted)
      void m.pools.primary.pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});
    liveness.markLost();
  }
  async function close() {
    options.signal?.removeEventListener("abort", cancel);
    if (!liveness.beginClose()) return;
    keys.clear();
    reserved?.release();
    await closePool(pool);
  }

  let db: ReturnType<typeof guardedConnection>;
  try {
    // The driver message (host, user) does not reach the management caller either: only the code (`DriverError`).
    reserved = await liveness.guard(reserveGuarded(pool));
    db = guardedConnection(reserved, liveness);
    pid = await backendPid(db);
    await liveness.guard(assertDirect(m.driver, url, db, pid));
    // Session-level settings are safe only after the connection has been proven to be direct.
    await db.query(SESSION_SETTINGS_SQL, [
      `${m.config.migrationStatementTimeoutMs}ms`,
      `${m.config.migrationLockTimeoutMs}ms`,
      options.applicationName ?? "migration",
    ]);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  } catch (error) {
    await close();
    throw error;
  }

  const host: LockHost = { db, pid, keys, assertAlive: liveness.assertAlive, markLost: liveness.markLost };
  const acquire = (key: string) => acquireAdvisoryLock(host, key);
  return { db, pid, acquire, assertAlive: liveness.assertAlive, signal: liveness.signal, close, cancel };
}

/** Lock session reserved for standalone management commands and recovery. */
export async function openManagementSession(m: Management, key: string, options: SessionOptions = {}) {
  const session = await openSession(m, options);
  try {
    return { ...session, ...(await session.acquire(key)) };
  } catch (error) {
    await session.close();
    throw error;
  }
}
