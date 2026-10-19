/** Kullanıcı aktarımı: JSONL/SQL kaynağı, tekrar çalıştırma, e-posta çakışması ve aktarılmış parola hash'leri (gerçek PostgreSQL). */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importedPasswords } from "../../core/auth";
import { importUsers, jsonLinesSource, sqlSource } from "../../core/tools/import-users";
import type { Placement } from "../../core/tenants/model";
import { bootstrap, provisionTenant } from "../../management";
import { createTestManagement, directConfig, driver, enabled, failure, integration, q, removeTenants } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
let dir: string;
const base = `imp-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
  dir = await mkdtemp(join(tmpdir(), "db-import-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  if (!app) return;
  try {
    await removeTenants(app, base);
  } finally {
    await app.close();
  }
});

const rows = <T>(p: Placement, sql: string, values: unknown[] = []) => app.pools.node(p.databaseId).query<T>(sql.replaceAll("$schema", q(p.schemaName)), values);

integration("imports users idempotently with mappings, updates changed records and verifies bcrypt/argon2 password hashes", async () => {
  const p = await provisionTenant(app, `${base}-app`, "db1");
  const legacy = [
    { externalId: 1, email: "Ada@Example.com", name: "Ada", emailVerified: true, passwordHash: await Bun.password.hash("ada-pass", "bcrypt") },
    { externalId: "2", email: "grace@example.com", name: "Grace", passwordHash: await Bun.password.hash("grace-pass", "argon2id") },
    { externalId: "3", email: "linus@example.com", name: "Linus", accounts: [{ providerId: "github", accountId: "gh-3" }] },
    { externalId: "4", email: "not-an-email" },
  ];
  const file = join(dir, "users.jsonl");
  await writeFile(file, `${legacy.map((u) => JSON.stringify(u)).join("\n")}\n{broken json\n`);

  expect(await importUsers(app, p.tenantId, jsonLinesSource(file), { source: "legacy", dryRun: true })).toMatchObject({ created: 3, invalid: 2, dryRun: true });
  expect(await rows(p, `SELECT id FROM $schema.users`)).toEqual([]);
  const events: Record<string, unknown>[] = [];
  const first = await importUsers(app, p.tenantId, jsonLinesSource(file), { source: "legacy", report: (e) => void events.push(e as never) });
  expect(first).toMatchObject({ read: 5, invalid: 2, created: 3, updated: 0, unchanged: 0 , passwords: { bcrypt: 1, argon2: 1, scrypt: 0, unsupported: 0 } });
  expect(events.filter((e) => e.status === "invalid").map((e) => e.index)).toEqual([3, 4]);
  // Same source again: nothing new.
  expect(await importUsers(app, p.tenantId, jsonLinesSource(file), { source: "legacy" })).toMatchObject({ created: 0, unchanged: 3 });
  // A changed record updates the mapped user instead of creating one.
  expect(await importUsers(app, p.tenantId, [{ ...legacy[0], name: "Ada Lovelace" }], { source: "legacy" })).toMatchObject({ updated: 1 });

  const users = await rows<{ email: string; name: string; verified: boolean; password: string | null; providers: string }>(
    p,
    `SELECT u.email,u.name,u.email_verified AS verified,max(a.password) AS password,string_agg(a.provider_id,',' ORDER BY a.provider_id) AS providers
     FROM $schema.users u JOIN $schema.user_imports i ON i.user_id=u.id LEFT JOIN $schema.account a ON a.user_id=u.id
     GROUP BY u.email,u.name,u.email_verified ORDER BY u.email`,
  );
  expect(users.map((u) => [u.email, u.name, u.verified, u.providers])).toEqual([
    ["ada@example.com", "Ada Lovelace", true, "credential"],
    ["grace@example.com", "Grace", false, "credential"],
    ["linus@example.com", "Linus", false, "github"],
  ]);
  expect(await importedPasswords.verify({ hash: users[0]?.password as string, password: "ada-pass" })).toBe(true);
  expect(await importedPasswords.verify({ hash: users[0]?.password as string, password: "wrong" })).toBe(false);
  expect(await importedPasswords.verify({ hash: users[1]?.password as string, password: "grace-pass" })).toBe(true);
  const native = await importedPasswords.hash("better-auth-pass");
  expect(await importedPasswords.verify({ hash: native, password: "better-auth-pass" })).toBe(true);
});

integration("an email owned by an existing user is skipped, linked or fails the batch; SQL sources read another database", async () => {
  const p = await provisionTenant(app, `${base}-conflict`, "db0");
  const existing = "00000000-0000-4000-8000-000000000001";
  await rows(p, `INSERT INTO $schema.users (id,name,email,email_verified) VALUES ($1,'Existing','taken@example.com',true)`, [existing]);
  const incoming = [{ externalId: "u1", email: "taken@example.com", name: "Imported", accounts: [{ providerId: "google", accountId: "g-1" }] }];

  expect(await importUsers(app, p.tenantId, incoming, { source: "crm" })).toMatchObject({ skipped: 1, created: 0 });
  expect(await failure(importUsers(app, p.tenantId, incoming, { source: "crm", onConflict: "fail" }))).toBe("IMPORT_CONFLICT");
  expect(await importUsers(app, p.tenantId, incoming, { source: "crm", onConflict: "link" })).toMatchObject({ linked: 1 });
  expect(await rows(p, `SELECT user_id::text AS user_id FROM $schema.user_imports WHERE source='crm' AND external_id='u1'`)).toEqual([{ user_id: existing }]);
  expect(await rows(p, `SELECT name FROM $schema.users WHERE id=$1`, [existing])).toEqual([{ name: "Existing" }]);
  expect(await failure(importUsers(app, p.tenantId, incoming, { source: "Bad Source" }))).toBe("USAGE");
  // Auth on Workers cannot verify argon2: those hashes and unknown formats are counted and not written.
  const hashes = [
    { externalId: "h1", email: "argon@example.com", passwordHash: await Bun.password.hash("x", "argon2id") },
    { externalId: "h2", email: "md5@example.com", passwordHash: "5f4dcc3b5aa765d61d8327deb882cf99" },
  ];
  expect(await importUsers(app, p.tenantId, hashes, { source: "hashes", authRuntime: "workers" })).toMatchObject({ created: 2, passwords: { unsupported: 2 } });
  expect(await rows(p, `SELECT 1 FROM $schema.account a JOIN $schema.user_imports i ON i.user_id=a.user_id WHERE i.source='hashes'`)).toEqual([]);

  // Another application's database: a read-only query whose columns are ImportedUser fields.
  const url = directConfig().nodes[1]?.url as string;
  const query = `SELECT * FROM (VALUES ('s1','sql-one@example.com','From SQL'),('s2','sql-two@example.com','Also SQL')) AS v("externalId",email,name)`;
  expect(await importUsers(app, p.tenantId, sqlSource(driver, url, query), { source: "old-db" })).toMatchObject({ read: 2, created: 2 });
});

integration("a mapped record whose new email belongs to another user: skip and fail change nothing, link moves the mapping without touching either user", async () => {
  const p = await provisionTenant(app, `${base}-relink`, "db1");
  const owner = "00000000-0000-4000-8000-0000000000b0";
  await rows(p, `INSERT INTO $schema.users (id,name,email) VALUES ($1,'Owner B','b@example.com')`, [owner]);
  expect(await importUsers(app, p.tenantId, [{ externalId: "x1", email: "a@example.com", name: "Mapped A" }], { source: "crm" })).toMatchObject({ created: 1 });
  const [mapped] = await rows<{ user_id: string }>(p, `SELECT user_id::text AS user_id FROM $schema.user_imports WHERE source='crm' AND external_id='x1'`);
  const moved = [{ externalId: "x1", email: "b@example.com", name: "Renamed", accounts: [{ providerId: "github", accountId: "gh-x1" }] }];
  const state = async () => ({
    mapping: await rows(p, `SELECT user_id::text AS user_id FROM $schema.user_imports WHERE source='crm' AND external_id='x1'`),
    users: await rows(p, `SELECT id::text AS id,name,email FROM $schema.users WHERE id IN ($1,$2) ORDER BY email`, [mapped?.user_id, owner]),
    accounts: await rows(p, `SELECT user_id::text AS user_id FROM $schema.account WHERE provider_id='github' AND account_id='gh-x1'`),
  });
  const before = await state();
  expect(before.users).toEqual([
    { id: mapped?.user_id, name: "Mapped A", email: "a@example.com" },
    { id: owner, name: "Owner B", email: "b@example.com" },
  ]);

  expect(await importUsers(app, p.tenantId, moved, { source: "crm" })).toMatchObject({ skipped: 1, updated: 0, linked: 0 });
  expect(await state()).toEqual(before);
  expect(await failure(importUsers(app, p.tenantId, moved, { source: "crm", onConflict: "fail" }))).toBe("IMPORT_CONFLICT");
  expect(await state()).toEqual(before);

  expect(await importUsers(app, p.tenantId, moved, { source: "crm", onConflict: "link" })).toMatchObject({ linked: 1, updated: 0, skipped: 0 });
  const after = await state();
  expect(after.mapping).toEqual([{ user_id: owner }]); // eşleme B'ye taşındı
  expect(after.users).toEqual(before.users); // A'nın e-postası B'ninkine güncellenmedi, B'nin adı değişmedi
  expect(after.accounts).toEqual([{ user_id: owner }]);
  // Tekrar çalıştırmak aynı sonucu verir.
  expect(await importUsers(app, p.tenantId, moved, { source: "crm", onConflict: "link" })).toMatchObject({ unchanged: 1 });
});
