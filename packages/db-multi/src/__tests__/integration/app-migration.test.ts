/** Başka uygulamanın SQL yedeğinden aktarım: dump → parçalar → defineAppMigration (kullanıcılar + tenant tabloları), tekrar çalıştırma.
 * Hedefler paketin auth tablolarıdır: `students`, `teachers` ve `students`'a yabancı anahtarlı `student_sessions`. */
import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAppMigration } from "../../core/tools/app-migration";
import { splitSqlDump } from "../../core/tools/sql-dump";
import type { Placement } from "../../core/tenants/model";
import { bootstrap, provisionTenant } from "../../management";
import { createTestManagement, enabled, failure, integration, q, removeTenants } from "./helpers";

let app: ReturnType<typeof createTestManagement>;
let dir: string;
const base = `app-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
beforeAll(async () => {
  if (!enabled) return;
  app = createTestManagement();
  await bootstrap(app);
  dir = await mkdtemp(join(tmpdir(), "db-app-migration-"));
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

const rows = <T>(p: Placement, sql: string) => app.pools.node(p.databaseId).query<T>(sql.replaceAll("$schema", q(p.schemaName)));

const DUMP = `-- PostgreSQL database dump
CREATE TABLE public.uyeler (id integer NOT NULL, email character varying(255), ad_soyad text, sifre text, created_at timestamp);
CREATE TABLE public.ogrenciler (id integer NOT NULL, uye_id integer, ad text, aktif boolean);
CREATE TABLE public.ogretmenler (id integer NOT NULL, ad text);
CREATE TABLE public.oturumlar (ogrenci_id integer, jeton text);
COPY public.uyeler (id, email, ad_soyad, sifre, created_at) FROM stdin;
1	veli@example.com	Veli Bir	\\N	2020-01-01 10:00:00
2	\\N	E-postasız	\\N	2020-01-02 10:00:00
\\.
COPY public.ogrenciler (id, uye_id, ad, aktif) FROM stdin;
10	1	Ali	t
11	2	Ayşe	f
12	\\N	Can	t
\\.
INSERT INTO public.ogretmenler VALUES (100, 'Kimya Hocası'), (101, 'Biyoloji Hocası');
INSERT INTO public.oturumlar VALUES (10, 'jeton-a'), (10, 'jeton-b'), (12, 'jeton-c');
`;

type Rows = {
  uyeler: { id: number; email: string | null; ad_soyad: string; sifre: string | null; created_at: string };
  ogrenciler: { id: number; uye_id: number | null; ad: string; aktif: boolean };
  ogretmenler: { id: number; ad: string };
  oturumlar: { ogrenci_id: number; jeton: string };
};
const session = (row: Rows["oturumlar"], ctx: { uuid(table: string, id: unknown): string }) => ({
  id: ctx.uuid("oturumlar", row.jeton),
  token: row.jeton,
  expires_at: "2030-01-01T00:00:00Z",
  user_id: ctx.uuid("ogrenciler", row.ogrenci_id),
});
const legacy2app = defineAppMigration<Rows>({
  source: "aristo",
  steps: [
    { table: "uyeler", users: (row) => (row.email ? { externalId: row.id, email: row.email, name: row.ad_soyad, createdAt: row.created_at } : null) },
    // Only students of imported members; unknown members are skipped.
    {
      table: "ogrenciler",
      into: "students",
      map: (row, ctx) =>
        row.uye_id !== null && ctx.userId(row.uye_id)
          ? { id: ctx.uuid("ogrenciler", row.id), name: row.ad, email: `ogrenci${row.id}@example.com`, is_email_verified: row.aktif }
          : null,
    },
    { table: "ogretmenler", into: "teachers", map: (row, ctx) => ({ id: ctx.uuid("ogretmenler", row.id), name: row.ad, email: `ogretmen${row.id}@example.com` }) },
    { table: "oturumlar", into: "student_sessions", map: session },
  ],
});

integration("migrates another application's SQL dump into a tenant idempotently with users, deterministic ids and relations", async () => {
  const p = await provisionTenant(app, `${base}-a`, "db1");
  const file = join(dir, "backup.sql");
  await writeFile(file, DUMP);
  const work = join(dir, "work");
  await splitSqlDump(file, work);

  const dry = await legacy2app(app, p.tenantId, work, { dryRun: true });
  expect(dry.steps.map((s) => [s.table, s.read, s.skipped, s.written])).toEqual([
    ["uyeler", 2, 1, 1],
    ["ogrenciler", 3, 3, 0],
    ["ogretmenler", 2, 0, 0],
    ["oturumlar", 3, 0, 0],
  ]);
  // A dry run writes nothing.
  expect(await rows(p, `SELECT 1 FROM $schema.teachers UNION ALL SELECT 1 FROM $schema.users`)).toEqual([]);

  // The session of student 12 (not imported) violates the foreign key, so the dump needs the student filter mirrored there.
  expect(await failure(legacy2app(app, p.tenantId, file))).toBe("23503");
  const fixed = defineAppMigration<Rows>({
    ...legacy2app.definition,
    steps: [
      ...(legacy2app.definition.steps.slice(0, 3) as never[]),
      { table: "oturumlar", into: "student_sessions", map: (row, ctx) => (row.ogrenci_id === 12 ? null : session(row, ctx)) },
    ],
  });
  const first = await fixed(app, p.tenantId, file);
  // Batches before the failing one were committed; rerunning only writes what is missing.
  expect(first.steps.map((s) => [s.table, s.read, s.skipped, s.written])).toEqual([
    ["uyeler", 2, 1, 0],
    ["ogrenciler", 3, 2, 0],
    ["ogretmenler", 2, 0, 0],
    ["oturumlar", 3, 1, 2],
  ]);
  expect(
    await rows(
      p,
      `SELECT s.name,s.is_email_verified AS verified,string_agg(o.token,',' ORDER BY o.token) AS tokens FROM $schema.students s JOIN $schema.student_sessions o ON o.user_id=s.id WHERE s.name IN ('Ali','Ayşe','Can') GROUP BY s.name,s.is_email_verified`,
    ),
  ).toEqual([{ name: "Ali", verified: true, tokens: "jeton-a,jeton-b" }]);
  expect(await rows(p, `SELECT name FROM $schema.teachers ORDER BY name`)).toEqual([{ name: "Biyoloji Hocası" }, { name: "Kimya Hocası" }]);
  expect(await rows(p, `SELECT u.email,u.name FROM $schema.users u JOIN $schema.user_imports i ON i.user_id=u.id WHERE i.source='aristo'`)).toEqual([
    { email: "veli@example.com", name: "Veli Bir" },
  ]);

  const again = await fixed(app, p.tenantId, work);
  expect(again.steps.map((s) => s.written)).toEqual([0, 0, 0, 0]);
  expect((again.steps[0]?.result as { unchanged: number }).unchanged).toBe(1);

  const wrong = defineAppMigration<Rows>({ source: "aristo", steps: [{ table: "ogretmenler", into: "teachers", map: (row) => ({ ad: row.ad }) }] });
  expect(await failure(wrong(app, p.tenantId, work))).toBe("IMPORT_INVALID");
  expect(await failure(defineAppMigration<Rows>({ source: "aristo", steps: [{ table: "ogretmenler", into: "yok", map: () => null }] })(app, p.tenantId, work))).toBe("IMPORT_INVALID");
});
