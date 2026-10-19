/** Carries a stable error code and message; mapping it to an HTTP status is the consuming application's job. */
import type { z } from "zod";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Driver-independent code: an AppError code, SQLSTATE or connection code. Bun carries SQLSTATE in `errno`; pg gives no code on disconnects. */
export function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (typeof error !== "object" || error === null) return "OPERATION_FAILED";
  const { errno, code, message } = error as Record<string, unknown>;
  if (typeof errno === "string" && /^[0-9A-Z]{5}$/.test(errno)) return errno;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  if (typeof message === "string" && /^Connection terminated|not queryable/.test(message)) return "CONNECTION_CLOSED";
  return "OPERATION_FAILED";
}

/** SQLSTATE connection/resource/shutdown classes or a driver/socket connection error. */
const UNAVAILABLE =
  /^(08|53|57P0)|^((ERR_POSTGRES_)?CONNECTION_(CLOSED|DESTROYED|ENDED|TIMEOUT)|CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/;
export const databaseUnavailable = (error: unknown) => UNAVAILABLE.test(errorCode(error));

/** Invalid stored state is a server error, not invalid client input. */
export function parseDatabaseValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError("INVALID_DATABASE_STATE", "Stored database state is invalid");
  return parsed.data;
}
