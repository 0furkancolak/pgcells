import { expect, test } from "bun:test";
import { AppError, DeadlineError } from "../../core/errors";
import { failoverClass, retryable } from "../../core/failover";

/** Error shapes as the drivers produce them: Bun carries the SQLSTATE in `errno`, postgres.js and pg in `code`, sockets in `code`. */
const sqlstate = (code: string) => Object.assign(new Error(`server error ${code}`), { errno: code, code: "ERR_POSTGRES_SERVER_ERROR" });
const socket = (code: string) => Object.assign(new Error(code), { code });

test.each([
  ["ECONNRESET", socket("ECONNRESET"), "connection-reset"],
  ["EPIPE", socket("EPIPE"), "connection-reset"],
  ["Bun connection closed", socket("ERR_POSTGRES_CONNECTION_CLOSED"), "connection-reset"],
  ["pg 'Connection terminated'", new Error("Connection terminated unexpectedly"), "connection-reset"],
  ["08006 connection_failure", sqlstate("08006"), "connection-reset"],
  ["08003 connection_does_not_exist", sqlstate("08003"), "connection-reset"],
  ["ECONNREFUSED", socket("ECONNREFUSED"), "unreachable"],
  ["ETIMEDOUT", socket("ETIMEDOUT"), "unreachable"],
  ["ENOTFOUND", socket("ENOTFOUND"), "unreachable"],
  ["08001 unable to establish", sqlstate("08001"), "unreachable"],
  ["57P01 admin_shutdown", sqlstate("57P01"), "admin-shutdown"],
  ["57P02 crash_shutdown", sqlstate("57P02"), "admin-shutdown"],
  ["57P03 cannot_connect_now", sqlstate("57P03"), "admin-shutdown"],
  ["25006 read_only_sql_transaction (writing to a demoted primary)", sqlstate("25006"), "read-only"],
  ["08P01 protocol_violation (PgBouncer dropped the server)", sqlstate("08P01"), "pooler-reset"],
  ["DATABASE_TIMEOUT while the statement was running", new DeadlineError(true), "timeout"],
  ["DATABASE_TIMEOUT before the statement was sent (no connection in time)", new DeadlineError(false), "unreachable"],
  ["DATABASE_TIMEOUT of unknown origin", new AppError("DATABASE_TIMEOUT", "deadline"), "timeout"],
  ["57014 query_canceled", sqlstate("57014"), "timeout"],
  ["DATABASE_BUSY", new AppError("DATABASE_BUSY", "saturated"), "busy"],
  ["53300 too_many_connections", sqlstate("53300"), "busy"],
])("%s is classified as %s", (_name, error, expected) => {
  expect(failoverClass(error)).toBe(expected as never);
});

test.each([
  ["a unique violation (23505)", sqlstate("23505")],
  ["a syntax error (42601)", sqlstate("42601")],
  ["a missing table (42P01)", sqlstate("42P01")],
  ["an AppError that is the caller's mistake", new AppError("TENANT_NOT_FOUND", "no")],
  ["a non-error value", "boom"],
  ["null", null],
])("%s is not a failover error", (_name, error) => {
  expect(failoverClass(error)).toBeUndefined();
  expect(retryable(error)).toBe(false);
});

test("everything except a timeout may be retried by the caller, because a timed-out statement may have committed", () => {
  for (const error of [socket("ECONNRESET"), socket("ECONNREFUSED"), sqlstate("57P01"), sqlstate("25006"), sqlstate("08P01"), new AppError("DATABASE_BUSY", "x")])
    expect(retryable(error)).toBe(true);
  expect(retryable(new AppError("DATABASE_TIMEOUT", "x"))).toBe(false);
  expect(retryable(new DeadlineError(true))).toBe(false);
  expect(retryable(new DeadlineError(false))).toBe(true); // nothing was sent, so nothing can be repeated
  expect(retryable(sqlstate("57014"))).toBe(false);
});
