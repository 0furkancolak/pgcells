/** Carries a stable error code and message; mapping it to an HTTP status is up to the consuming application. */
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

/** Safe form of a driver error: the code is taken from the raw error; the message carries only the code (a driver message may contain the host, user, DB name or row
 * value). `detail` and the raw error (`cause`) are not carried; the constraint name (an identifier, not a secret) is: pg/Bun/Neon `constraint`,
 * postgres.js `constraint_name`. */
export class DriverError extends AppError {
  readonly constraint?: string;
  constructor(raw: unknown) {
    const code = errorCode(raw);
    super(code, `Database operation failed (${code})`);
    const fields = raw as { constraint?: unknown; constraint_name?: unknown } | null;
    const constraint = fields?.constraint ?? fields?.constraint_name;
    if (typeof constraint === "string") this.constraint = constraint;
  }
}
/** `AppError` (the engine's own error) stays as it is; every other driver error becomes a `DriverError`. */
export const driverError = (raw: unknown) => (raw instanceof AppError ? raw : new DriverError(raw));

/** SQLSTATE connection/resource/shutdown classes or a driver/socket connection error. */
const UNAVAILABLE =
  /^(08|53|57P0)|^((ERR_POSTGRES_)?CONNECTION_(CLOSED|DESTROYED|ENDED|TIMEOUT)|CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/;
export const databaseUnavailable = (error: unknown) => UNAVAILABLE.test(errorCode(error));
