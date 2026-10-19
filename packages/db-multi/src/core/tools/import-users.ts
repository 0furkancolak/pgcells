/** User transfer from another application or database: source (a JSON Lines file, a read-only SQL query on another PostgreSQL, or
 * any async iterable) → the tenant's Better Auth tables (`user`, `account`) and the `user_imports` mapping.
 *
 * - Re-running is safe: the `(source, externalId)` mapping does not create the same person twice; it updates if the record changed.
 * - When moving related data, the old ID → new user is found through `user_imports`.
 * - If the email belongs to another user in the tenant, `onConflict`: `skip` (default, reported), `link` (the mapping and accounts are added to the
 *   existing user, name/password unchanged) or `fail` (that batch is rolled back, the transfer stops).
 * - The password hash is written as-is to the `credential` account; for bcrypt/argon2 give Better Auth `importedPasswords` (`@0furkancolak/pgcells/auth`).
 * - Each batch is one transaction; invalid rows are skipped and reported through `report`. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { boundedInteger } from "../config";
import type { Connection, Driver } from "../driver";
import { AppError } from "../errors";
import type { Management } from "../management";
import { type MigrationReport, noReport } from "../migrations/batch";
import { qualified, requireActive } from "../tenants/model";
import { SNAPSHOT_MODE, streamCursor } from "./copy";
import { readLines } from "./jsonl";

export const importedUserSchema = z.object({
  externalId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1).max(255)),
  email: z.email().max(320).transform((value) => value.toLowerCase()),
  name: z
    .string()
    .max(500)
    .nullish()
    .transform((value) => value ?? ""),
  emailVerified: z.boolean().default(false),
  image: z.string().max(2000).nullish(),
  createdAt: z.coerce.date().optional(),
  /** Password hash in the source (Better Auth scrypt, bcrypt or argon2); if absent the user signs in through a password reset or a social account. */
  passwordHash: z.string().min(1).max(1000).nullish(),
  /** Social/OAuth accounts (`providerId`: `google`, `github` …); not added if the same account already exists in the tenant. */
  accounts: z.array(z.object({ providerId: z.string().min(1).max(100), accountId: z.string().min(1).max(255) })).default([]),
});
export type ImportedUser = z.input<typeof importedUserSchema>;
type User = z.output<typeof importedUserSchema>;

const SOURCE_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10000;
/** Rows read at a time from the `sqlSource` cursor. */
const CURSOR_FETCH_ROWS = 500;

type OnConflict = "skip" | "link" | "fail";
type AuthRuntime = "bun" | "workers";
export type ImportUsersOptions = {
  /** Source name (`legacy-app`, `wordpress` …): part of the mapping key, keep it constant for the same source. */
  source: string;
  onConflict?: OnConflict;
  /** Runtime that will verify sign-in: `bun` (default; bcrypt and argon2) or `workers` (argon2 cannot be verified, not written). */
  authRuntime?: AuthRuntime;
  dryRun?: boolean;
  batchSize?: number;
  signal?: AbortSignal;
  report?: MigrationReport;
};

/** Password hash kind: Better Auth scrypt, bcrypt, argon2; a hash that cannot be verified is `unsupported` (not written, reported; the user signs in
 * through a password reset). */
export function passwordHashKind(hash: string, authRuntime: AuthRuntime = "bun") {
  if (/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash)) return "scrypt";
  if (/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return "bcrypt";
  if (/^\$argon2(?:id|i|d)\$/.test(hash) && authRuntime === "bun") return "argon2";
  return "unsupported";
}
type PasswordKind = ReturnType<typeof passwordHashKind>;

const checksum = (user: User) => createHash("sha256").update(JSON.stringify(user)).digest("hex");

type PendingUser = { index: number; user: User };
type Mapping = { external_id: string; user_id: string; checksum: string };
type TableName = (name: string) => string;
type Writes = {
  creates: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  passwords: { userId: string; password: string }[];
  accounts: { userId: string; providerId: string; accountId: string }[];
  mappings: { externalId: string; userId: string; checksum: string }[];
};
const COUNTED_OUTCOMES = ["created", "updated", "unchanged", "linked", "skipped"] as const;
type BatchCounts = Record<(typeof COUNTED_OUTCOMES)[number], number> & { passwords: Record<PasswordKind, number> };
/** `conflict`: the external ID of the conflicting row when `onConflict: "fail"`; planning stops there. */
type BatchPlan = { writes: Writes; counts: BatchCounts; events: Record<string, unknown>[]; conflict?: string };

function validateImportOptions(options: ImportUsersOptions) {
  if (!SOURCE_NAME.test(options.source)) throw new AppError("USAGE", "source must match [a-z0-9][a-z0-9_.-]{0,62}");
  if (!["skip", "link", "fail"].includes(options.onConflict ?? "skip")) throw new AppError("USAGE", "onConflict must be skip, link or fail");
  if (options.authRuntime !== undefined && !["bun", "workers"].includes(options.authRuntime)) throw new AppError("USAGE", "authRuntime must be bun or workers");
}

/** Existing mappings in this source for the batch's external IDs (external ID → mapping). */
async function loadMappings(tx: Connection, table: TableName, source: string, payload: string) {
  const rows = await tx.query<Mapping>(
    `SELECT external_id,user_id,checksum FROM ${table("user_imports")} WHERE source=$1 AND external_id IN (SELECT x->>'externalId' FROM pg_catalog.jsonb_array_elements($2::text::jsonb) x)`,
    [source, payload],
  );
  return new Map(rows.map((row) => [row.external_id, row]));
}

/** Owners in the tenant of the batch's emails (email → user ID). */
async function loadEmailOwners(tx: Connection, table: TableName, payload: string) {
  const rows = await tx.query<{ id: string; email: string }>(
    `SELECT id::text AS id,email FROM ${table("users")} WHERE email IN (SELECT x->>'email' FROM pg_catalog.jsonb_array_elements($1::text::jsonb) x)`,
    [payload],
  );
  return new Map(rows.map((row) => [row.email, row.id]));
}

/** Computes the writes, counts and report events for a batch (does not touch the DB). */
function planBatch(batch: PendingUser[], mapped: Map<string, Mapping>, owners: Map<string, string>, onConflict: OnConflict, authRuntime?: AuthRuntime): BatchPlan {
  const writes: Writes = { creates: [], updates: [], passwords: [], accounts: [], mappings: [] };
  const counts: BatchCounts = { created: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, passwords: { scrypt: 0, bcrypt: 0, argon2: 0, unsupported: 0 } };
  const events: Record<string, unknown>[] = [];
  const claimed = new Set<string>();
  const addPassword = (userId: string, user: User, event: Record<string, unknown>) => {
    if (!user.passwordHash) return;
    const kind = passwordHashKind(user.passwordHash, authRuntime);
    counts.passwords[kind]++;
    if (kind === "unsupported") events.push({ ...event, status: "password-unsupported" });
    else writes.passwords.push({ userId, password: user.passwordHash });
  };
  const addAccountsAndMapping = (userId: string, user: User, sum: string) => {
    for (const account of user.accounts) writes.accounts.push({ userId, ...account });
    writes.mappings.push({ externalId: user.externalId, userId, checksum: sum });
  };

  for (const { index, user } of batch) {
    const sum = checksum(user);
    const event = { externalId: user.externalId, index };
    const mapping = mapped.get(user.externalId);
    const owner = owners.get(user.email);
    // The email belongs to someone other than the mapping's user (whether or not there is a mapping).
    const ownedByAnother = owner !== undefined && owner !== mapping?.user_id;
    // If the same email comes a second time in the same batch, the first record wins.
    if (claimed.has(user.email) || (ownedByAnother && onConflict !== "link")) {
      if (onConflict === "fail") return { writes, counts, events, conflict: user.externalId };
      counts.skipped++;
      events.push({ ...event, status: "skipped", reason: "email-conflict" });
      continue;
    }
    claimed.add(user.email);
    if (ownedByAnother) {
      // `link`: the mapping (taken over from the previous user if any) and accounts are attached to the email's owner; neither user's record changes.
      addAccountsAndMapping(owner, user, sum);
      counts.linked++;
    } else if (mapping) {
      if (mapping.checksum === sum) {
        counts.unchanged++;
        continue;
      }
      writes.updates.push({ id: mapping.user_id, name: user.name, email: user.email, emailVerified: user.emailVerified, image: user.image ?? null });
      addPassword(mapping.user_id, user, event);
      addAccountsAndMapping(mapping.user_id, user, sum);
      counts.updated++;
    } else {
      const id = crypto.randomUUID();
      const createdAt = (user.createdAt ?? new Date()).toISOString();
      writes.creates.push({ id, name: user.name, email: user.email, emailVerified: user.emailVerified, image: user.image ?? null, createdAt });
      addPassword(id, user, event);
      addAccountsAndMapping(id, user, sum);
      counts.created++;
    }
  }
  return { writes, counts, events };
}

/** Imports the users; returns the counts. The tenant must be `active`. */
export async function importUsers(m: Management, tenantId: string, rows: AsyncIterable<unknown> | Iterable<unknown>, options: ImportUsersOptions) {
  validateImportOptions(options);
  const onConflict = options.onConflict ?? "skip";
  const batchSize = boundedInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize", MAX_BATCH_SIZE);
  const report = options.report ?? noReport;
  const placement = requireActive(await m.platform.get(tenantId), "Tenant must be active to import users");
  const table = (name: string) => qualified(placement.schemaName, name);
  const summary = { read: 0, invalid: 0, created: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, passwords: { scrypt: 0, bcrypt: 0, argon2: 0, unsupported: 0 }, dryRun: !!options.dryRun };

  const flush = async (batch: PendingUser[]) => {
    if (!batch.length) return;
    options.signal?.throwIfAborted();
    await m.pools.node(placement.databaseId).transaction(async (tx) => {
      const payload = JSON.stringify(batch.map(({ user }) => ({ externalId: user.externalId, email: user.email })));
      const mapped = await loadMappings(tx, table, options.source, payload);
      const owners = await loadEmailOwners(tx, table, payload);
      const plan = planBatch(batch, mapped, owners, onConflict, options.authRuntime);
      for (const outcome of COUNTED_OUTCOMES) summary[outcome] += plan.counts[outcome];
      for (const kind of Object.keys(plan.counts.passwords) as PasswordKind[]) summary.passwords[kind] += plan.counts.passwords[kind];
      for (const event of plan.events) report({ tenantId, source: options.source, ...event });
      if (plan.conflict !== undefined) throw new AppError("IMPORT_CONFLICT", `Email of external id ${plan.conflict} belongs to another user`);
      if (!options.dryRun) await write(tx, table, options.source, plan.writes);
    });
  };

  let batch: PendingUser[] = [];
  for await (const row of rows) {
    const index = summary.read++;
    const parsed = importedUserSchema.safeParse(row);
    if (!parsed.success) {
      summary.invalid++;
      report({ tenantId, source: options.source, index, status: "invalid", fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))] });
      continue;
    }
    batch.push({ index, user: parsed.data });
    if (batch.length === batchSize) {
      await flush(batch);
      batch = [];
    }
  }
  await flush(batch);
  return summary;
}

/** A fixed number of bulk statements per batch (no per-row queries). */
async function write(tx: Connection, table: TableName, source: string, writes: Writes) {
  const json = (value: unknown) => JSON.stringify(value);
  if (writes.creates.length)
    await tx.query(
      `INSERT INTO ${table("users")} (id,name,email,email_verified,image,created_at,updated_at)
       SELECT x.id,x.name,x.email,x."emailVerified",x.image,x."createdAt",now()
       FROM pg_catalog.jsonb_to_recordset($1::text::jsonb) AS x(id uuid,name text,email text,"emailVerified" boolean,image text,"createdAt" timestamptz)`,
      [json(writes.creates)],
    );
  if (writes.updates.length)
    await tx.query(
      `UPDATE ${table("users")} AS u SET name=x.name,email=x.email,email_verified=x."emailVerified",image=x.image,updated_at=now()
       FROM pg_catalog.jsonb_to_recordset($1::text::jsonb) AS x(id uuid,name text,email text,"emailVerified" boolean,image text) WHERE u.id=x.id`,
      [json(writes.updates)],
    );
  if (writes.passwords.length) {
    await tx.query(
      `UPDATE ${table("account")} AS a SET password=x.password,updated_at=now()
       FROM pg_catalog.jsonb_to_recordset($1::text::jsonb) AS x("userId" uuid,password text) WHERE a.user_id=x."userId" AND a.provider_id='credential'`,
      [json(writes.passwords)],
    );
    await tx.query(
      `INSERT INTO ${table("account")} (account_id,provider_id,user_id,password)
       SELECT x."userId"::text,'credential',x."userId",x.password
       FROM pg_catalog.jsonb_to_recordset($1::text::jsonb) AS x("userId" uuid,password text)
       WHERE NOT EXISTS (SELECT 1 FROM ${table("account")} a WHERE a.user_id=x."userId" AND a.provider_id='credential')`,
      [json(writes.passwords)],
    );
  }
  if (writes.accounts.length)
    await tx.query(
      `INSERT INTO ${table("account")} (account_id,provider_id,user_id)
       SELECT x."accountId",x."providerId",x."userId"
       FROM (SELECT DISTINCT * FROM pg_catalog.jsonb_to_recordset($1::text::jsonb) AS r("userId" uuid,"providerId" text,"accountId" text)) x
       WHERE NOT EXISTS (SELECT 1 FROM ${table("account")} a WHERE a.provider_id=x."providerId" AND a.account_id=x."accountId")`,
      [json(writes.accounts)],
    );
  if (writes.mappings.length)
    await tx.query(
      `INSERT INTO ${table("user_imports")} (source,external_id,user_id,checksum)
       SELECT $1,x."externalId",x."userId",x.checksum FROM pg_catalog.jsonb_to_recordset($2::text::jsonb) AS x("externalId" text,"userId" uuid,checksum text)
       ON CONFLICT (source,external_id) DO UPDATE SET user_id=EXCLUDED.user_id,checksum=EXCLUDED.checksum,updated_at=now()`,
      [source, json(writes.mappings)],
    );
}

/** JSON Lines (`.gz` also works): one `ImportedUser` per line; blank lines are skipped, a malformed JSON line counts as `null` (invalid). */
export async function* jsonLinesSource(path: string): AsyncGenerator<unknown> {
  for await (const line of readLines(path)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      yield null;
    }
  }
}

/** A query read with a cursor in a read-only transaction, in a single snapshot, on another PostgreSQL. Columns must be aliased to the `ImportedUser` fields
 * (`SELECT id AS "externalId", email, full_name AS name, password AS "passwordHash" FROM users`). The query text is the operator's own and
 * runs as is: give the source DB a user with read-only privileges. */
export async function* sqlSource(driver: Driver, url: string, query: string): AsyncGenerator<unknown> {
  const pool = driver(url, { max: 1, idleTimeoutSeconds: 5, maxLifetimeSeconds: 3600, connectTimeoutSeconds: 10 });
  const connection = await pool.reserve();
  // Because rows are yielded to the consumer while the transaction is open, a `runInTransaction` callback cannot be used; even if the consumer
  // leaves early, `finally` rolls the transaction back and releases the connection.
  try {
    await connection.exec(`BEGIN${SNAPSHOT_MODE}`);
    for await (const rows of streamCursor(connection, "user_import_rows", query, CURSOR_FETCH_ROWS)) yield* rows;
    await connection.exec("COMMIT");
  } finally {
    await connection.exec("ROLLBACK").catch(() => {});
    connection.release();
    await pool.close(1000);
  }
}
