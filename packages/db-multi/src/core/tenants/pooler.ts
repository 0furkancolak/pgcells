/** Proof that a runtime URL goes to a transaction-mode pooler (PgBouncer, Supavisor, Neon pooler, Hyperdrive). The pooler name
 * cannot be read reliably from SQL; so behavior is checked: if two separate clients see the same server session in consecutive statements
 * (`pg_backend_pid`), the pooler is certain, because on a direct connection two clients cannot see the same backend. Never seeing it means "direct"
 * or "a very busy / round-robin pooler" (a false negative is possible; `pooler: "assumed"` is the explicit escape hatch).
 * Advisory locks are not used: in transaction mode a lock can leak on the server connection. */
import { deadlineExceeded } from "../database";
import type { Connection, Driver } from "../driver";

const PROBE_ROUNDS = 10;

const backendPid = async (db: Connection) => Number((await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))[0]?.pid);

/** `true`: the same server session was seen on two separate connections. `false`: not seen in `rounds` rounds. The whole probe is
 * bounded by `deadlineMs` (`DATABASE_TIMEOUT`); connection errors are passed through as they are. The probe opens and closes its own temporary pool (`max: 2`):
 * `poolMax: 1` (Workers) and the running pool are not affected. */
export async function usesTransactionPooler(
  driver: Driver,
  url: string,
  { deadlineMs, rounds = PROBE_ROUNDS }: { deadlineMs: number; rounds?: number },
): Promise<boolean> {
  const pool = driver(url, { max: 2, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0, connectTimeoutSeconds: 10 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(deadlineExceeded()), deadlineMs);
  });
  const probe = async () => {
    for (let round = 0; round < rounds; round++) {
      const first = await pool.reserve();
      const second = await pool.reserve().catch((error: unknown) => {
        first.release();
        throw error;
      });
      try {
        if ((await backendPid(first)) === (await backendPid(second))) return true;
      } finally {
        first.release();
        second.release();
      }
    }
    return false;
  };
  const work = probe();
  // When the time runs out the pool closes and the half-finished probe is rejected; nobody awaits it, so there must be no unhandled rejection.
  work.catch(() => {});
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
    await pool.close(1000);
  }
}
