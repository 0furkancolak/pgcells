/** Classification of errors that appear when the database layer fails or fails over. Nothing here retries: the package never retries a statement on its own,
 * because it cannot know whether the work is idempotent. `retryable` tells the caller which failures are worth a deliberate retry of idempotent work. */
import { DeadlineError, errorCode } from "./errors";

/** What happened, in the terms an operator or a retry policy needs.
 * - `connection-reset`: the connection broke mid-flight (reset, closed, `08006`/`08003`); the statement may or may not have run.
 * - `unreachable`: no connection could be made (refused, timed out, unknown host, `08001`), or none could be acquired before the deadline, so the statement was never
 *   sent (`DATABASE_TIMEOUT` with `workStarted === false`): typical while a primary or pooler is down.
 * - `admin-shutdown`: the server is stopping or restarting (`57P01`, `57P02`, `57P03`).
 * - `read-only`: a write reached a replica or a demoted primary (`25006`): the cluster is failing over.
 * - `pooler-reset`: the pooler dropped the server connection under the client (`08P01`).
 * - `busy`: refused before any work started (`DATABASE_BUSY`, `53300`).
 * - `timeout`: a deadline expired while the statement was running (`DATABASE_TIMEOUT`, `57014`); it may have committed. */
export type FailoverClass = "connection-reset" | "unreachable" | "admin-shutdown" | "read-only" | "pooler-reset" | "busy" | "timeout";

const CLASSES: readonly (readonly [FailoverClass, RegExp])[] = [
  ["pooler-reset", /^08P01$/],
  ["unreachable", /^(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|CONNECT_TIMEOUT|ERR_POSTGRES_CONNECTION_TIMEOUT|CONNECTION_TIMEOUT|DATABASE_UNAVAILABLE|08001|08004)$/],
  ["connection-reset", /^(ECONNRESET|EPIPE|ECONNABORTED|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|ERR_POSTGRES_CONNECTION_CLOSED|08000|08003|08006)$/],
  ["admin-shutdown", /^57P0[123]$/],
  ["read-only", /^25006$/],
  ["busy", /^(DATABASE_BUSY|53300)$/],
  ["timeout", /^(DATABASE_TIMEOUT|57014)$/],
];

/** The class of a failover-type error, or `undefined` for anything else (a constraint violation, a bad query, an unknown tenant …). */
export function failoverClass(error: unknown): FailoverClass | undefined {
  if (error instanceof DeadlineError && !error.workStarted) return "unreachable";
  const code = errorCode(error);
  return CLASSES.find(([, pattern]) => pattern.test(code))?.[0];
}

/** `true` for failover errors that are safe to retry **if the work is idempotent**: everything except a timeout, which may have committed. */
export function retryable(error: unknown): boolean {
  const kind = failoverClass(error);
  return kind !== undefined && kind !== "timeout";
}
