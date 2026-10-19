/** Management sessions: a reserved direct connection, death detection, server-side cancellation and advisory lock ownership.
 * Session advisory locks do not work behind a transaction pooler; when a session opens, the connection is verified to be direct. */
import { PLATFORM_DATABASE_ID } from "../config";
import { type Connection, type Driver, type Pool, type Reserved, runInTransaction } from "../driver";
import { AppError, databaseUnavailable } from "../errors";
import type { Management } from "../management";

/** Watchdog: if the server still has not answered this long after statement_timeout, the connection is considered dead. */
const WATCHDOG_GRACE_MS = 5000;

/** Platform database key: at most one migration runner cluster-wide. */
export const RUNNER_KEY = "migration-runner";
/** Platform database key: one management operation per tenant (migrate, provision, move). */
export const tenantOperationKey = (tenantId: string) => `tenant-operation:${tenantId}`;
/** Node database key: held by the session that runs the tenant's DDL. */
export const tenantManagementKey = (tenantId: string) => `tenant-management:${tenantId}`;

const SESSION_SETTINGS_SQL =
  "SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false),set_config('application_name',$3,false)";
const TRY_LOCK_SQL = "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked";
const LOCK_HELD_SQL =
  "SELECT pg_backend_pid() AS pid,EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1) AS held";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked";

const lockLost = (message = "Management connection closed") => new AppError("LOCK_LOST", message);
export const cancelled = () => new AppError("MIGRATION_CANCELLED", "Operation interrupted; inspect ledger before resuming");
const busyErrorFor = (key: string) =>
  key === RUNNER_KEY
    ? new AppError("MIGRATION_RUNNER_BUSY", "Another migration runner is active; retry when it finishes")
    : new AppError("TENANT_BUSY", "Another operation owns this tenant");

/** One ownership check before every write: every held lock is alive and the work has not been cancelled. */
export function ownershipCheck(signal: AbortSignal, ...checks: (() => void | Promise<void>)[]) {
  return async () => {
    for (const check of checks) await check();
    if (signal.aborted) throw cancelled();
  };
}

/** Runs `expire` once `graceMs` after `signal` aborts; returns a cleanup function. */
export function afterGrace(signal: AbortSignal | undefined, graceMs: number, expire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = () => {
    timer ??= setTimeout(expire, graceMs);
  };
  signal?.addEventListener("abort", start, { once: true });
  if (signal?.aborted) start();
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", start);
  };
}

const backendPid = async (db: Connection) => Number((await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]?.pid);

/** URLs proven direct in this process; probing costs one extra connection per URL. */
const direct = new Set<string>();

/** Early failure: behind a transaction pooler an independent connection lands on the same backend (LIFO reuse), or the reserved
 * session moves between backends. Best effort: a busy pooler can hide itself from a single probe. */
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
  } finally {
    await probe.close(1000);
  }
}

/** Session liveness: the lost (abort) signal, the closing flag and a watchdog wrapping every query. */
function createLiveness(pool: Pool, watchdogMs: number) {
  const aborter = new AbortController();
  const { signal } = aborter;
  const lost = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(lockLost()), { once: true }));
  lost.catch(() => {});
  let closed = false;

  function markLost() {
    if (signal.aborted) return;
    aborter.abort();
    void pool.close(0);
  }
  function assertAlive() {
    if (signal.aborted || closed) throw lockLost();
  }
  /** The work ends with whichever comes first: session loss, a connection error or the watchdog period. */
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
    /** Marks the close; false if already closed. */
    beginClose() {
      if (closed) return false;
      closed = true;
      return true;
    },
  };
}
type Liveness = ReturnType<typeof createLiveness>;

/** A connection that checks liveness before every query and wraps the query in the watchdog; transactions use the session's own timeouts. */
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

/** Session internal state needed to acquire locks. */
interface LockHost {
  db: Connection;
  pid: number;
  /** Keys held in this session. */
  keys: Set<string>;
  assertAlive(): void;
  markLost(): void;
}

/** Acquires a session advisory lock (never waits); since advisory locks are reentrant on a single connection, a second local
 * owner of the same key also counts as busy. */
async function acquireAdvisoryLock(host: LockHost, key: string) {
  host.assertAlive();
  if (host.keys.has(key)) throw busyErrorFor(key);
  host.keys.add(key);
  let locked = false;
  try {
    const [row] = await host.db.query<{ locked: boolean }>(TRY_LOCK_SQL, [key]);
    locked = row?.locked === true;
    if (!locked) throw busyErrorFor(key);
    const lock = heldLock(host, key);
    await lock.assertOwned();
    return lock;
  } catch (error) {
    host.keys.delete(key);
    if (locked) host.markLost();
    throw error;
  }
}

/** Checks and release of an acquired lock; if release fails, the session is considered lost. */
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

export type SessionOptions = { applicationName?: string; signal?: AbortSignal };
export type Session = Awaited<ReturnType<typeof openSession>>;

/**
 * The single reserved connection (its own max:1 pool) with management timeouts, never reconnecting. It is lost when the driver reports a close,
 * when a query fails with a connection error or when it exceeds the watchdog; every pending and later query is rejected.
 */
export async function openSession(m: Management, databaseId: string, options: SessionOptions = {}) {
  const { url } = m.pools.nodeConfig(databaseId);
  const pool = m.driver(url, { max: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10, onClose: () => liveness.onPoolClose() });
  const liveness = createLiveness(pool, m.config.migrationStatementTimeoutMs + WATCHDOG_GRACE_MS);
  const keys = new Set<string>();
  let reserved: Reserved | undefined;
  let pid = 0;

  /** Stops the running statement from another connection (Bun's native cancel is ineffective), then drops the session. */
  function cancel() {
    if (pid && !liveness.signal.aborted)
      void m.pools.node(databaseId).pool.query("SELECT pg_cancel_backend($1)", [pid]).catch(() => {});
    liveness.markLost();
  }
  async function close() {
    options.signal?.removeEventListener("abort", cancel);
    if (!liveness.beginClose()) return;
    keys.clear();
    reserved?.release();
    await pool.close(1000);
  }

  let db: ReturnType<typeof guardedConnection>;
  try {
    reserved = await liveness.guard(pool.reserve());
    db = guardedConnection(reserved, liveness);
    pid = await backendPid(db);
    await liveness.guard(assertDirect(m.driver, url, db, pid));
    // Session-level settings are safe only after the connection has been proven direct.
    await db.query(SESSION_SETTINGS_SQL, [
      `${m.config.migrationStatementTimeoutMs}ms`,
      `${m.config.migrationLockTimeoutMs}ms`,
      options.applicationName ?? "tenant-management",
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

/** A reserved lock session for standalone management commands and recovery. */
export async function openManagementSession(m: Management, databaseId: string, key: string, options: SessionOptions = {}) {
  const session = await openSession(m, databaseId, options);
  try {
    return { ...session, ...(await session.acquire(key)) };
  } catch (error) {
    await session.close();
    throw error;
  }
}

type LockedWork<T> = (assertOwned: () => Promise<void>, signal: AbortSignal) => Promise<T>;

/** The platform `tenant-operation` lock for the duration of `work`. */
export async function withTenantLock<T>(m: Management, tenantId: string, work: LockedWork<T>, options: SessionOptions = {}) {
  const session = await openManagementSession(m, PLATFORM_DATABASE_ID, tenantOperationKey(tenantId), options);
  try {
    return await work(session.assertOwned, session.signal);
  } finally {
    await session.close();
  }
}

/** Holds the node `tenant-management` lock on every database in sorted order; owners cannot lock each other (no deadlock). */
export async function withNodeLocks<T>(m: Management, tenantId: string, databaseIds: string[], work: LockedWork<T>): Promise<T> {
  const sessions: Awaited<ReturnType<typeof openManagementSession>>[] = [];
  try {
    for (const id of [...new Set(databaseIds)].sort()) sessions.push(await openManagementSession(m, id, tenantManagementKey(tenantId)));
    const assertOwned = async () => {
      for (const session of sessions) await session.assertOwned();
    };
    return await work(assertOwned, AbortSignal.any(sessions.map((s) => s.signal)));
  } finally {
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
}
