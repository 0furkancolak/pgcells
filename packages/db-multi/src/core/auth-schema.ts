/** Better Auth mapping of the tenant auth tables (multi-type layout, `20260915155444_auth.sql`): separate tables per auth type,
 * snake_case columns. Spread into the options: `betterAuth({ ...tenant.options, ...authTables("student"), plugins: [twoFactor({ schema:
 * twoFactorTables("student") })] })`. For extra fields use `user: { ...authTables("student").user, additionalFields }`. Database rate
 * limit: `rateLimit: { enabled: true, storage: "database", ...rateLimitTable("student") }`. The panel uses the same `user` layout in the
 * `platform` schema. */
import { AppError } from "./errors";

export type AuthType = "user" | "student" | "teacher";

const TABLES = {
  user: {
    user: "users",
    session: "session",
    account: "account",
    verification: "verification",
    twoFactor: "two_factor",
    rateLimit: "rate_limit",
    emailVerified: "email_verified",
  },
  student: {
    user: "students",
    session: "student_sessions",
    account: "student_accounts",
    verification: "student_verifications",
    twoFactor: "student_two_factors",
    rateLimit: "student_rate_limits",
    emailVerified: "is_email_verified",
  },
  teacher: {
    user: "teachers",
    session: "teacher_sessions",
    account: "teacher_accounts",
    verification: "teacher_verifications",
    twoFactor: "teacher_two_factors",
    rateLimit: "teacher_rate_limits",
    emailVerified: "is_email_verified",
  },
} as const;

const tablesOf = (authType: AuthType) => {
  if (!Object.hasOwn(TABLES, authType)) throw new AppError("INVALID_CONFIG", "authType tables exist for user, student and teacher");
  return TABLES[authType];
};
const stamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

/** Better Auth `user`, `session`, `account`, `verification` options. */
export function authTables(authType: AuthType) {
  const t = tablesOf(authType);
  return {
    user: { modelName: t.user, fields: { emailVerified: t.emailVerified, ...stamps } },
    session: { modelName: t.session, fields: { expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id", ...stamps } },
    account: {
      modelName: t.account,
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        ...stamps,
      },
    },
    verification: { modelName: t.verification, fields: { expiresAt: "expires_at", ...stamps } },
  };
}

/** Mapping for the `twoFactor({ schema })` plugin. */
export function twoFactorTables(authType: AuthType) {
  const t = tablesOf(authType);
  return {
    user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
    twoFactor: {
      modelName: t.twoFactor,
      fields: { backupCodes: "backup_codes", userId: "user_id", failedVerificationCount: "failed_verification_count", lockedUntil: "locked_until" },
    },
  };
}

/** Table mapping for the Better Auth `rateLimit` option (`storage: "database"`). The rate limit key is IP + path and does not include the auth type:
 * each auth type uses its own table, so counters are not shared. */
export function rateLimitTable(authType: AuthType) {
  return { modelName: tablesOf(authType).rateLimit, fields: { lastRequest: "last_request" } };
}
