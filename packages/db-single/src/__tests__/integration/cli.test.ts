import { expect } from "bun:test";
import { schemaExists } from "../../core/catalog";
import { dropSchema, integration, packageCopy, q, raw, testSchema } from "./helpers";

integration("authoring through the CLI: create, codegen, migrate (dry run first), status, seed, roll back", async () => {
  const copy = await packageCopy("cli");
  const schema = testSchema();
  const admin = raw();
  try {
    const created = (await copy.cli("migration", "create", "add_notes")) as { id: string; path: string };
    expect(created.path).toMatch(/^src\/migrations\/\d{14}_add_notes\.sql$/);
    await copy.write(created.path, "--up\nCREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL);\n--down\nDROP TABLE notes;\n");
    const seed = (await copy.cli("seed", "create", "first_note")) as { id: string; path: string };
    await copy.write(seed.path, "INSERT INTO notes (id, body) VALUES (1, 'hello');\n");
    await copy.codegen();

    expect(await copy.cli("migration-status", "--schema", schema)).toMatchObject({ schema, applied: 0, pending: [{ id: created.id, transactional: true }] });
    expect(await copy.cli("migrate", "--schema", schema, "--dry-run")).toEqual({ dryRun: true, migrations: [created.id] });
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [created.id] });
    expect(await copy.cli("seed", "--schema", schema)).toEqual({ dryRun: false, seeds: [seed.id] });
    expect(await admin.query(`SELECT body FROM ${q(schema, "notes")}`)).toEqual([{ body: "hello" }]);
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [] });
    expect(await copy.cli("migrate-down", "--schema", schema)).toEqual({ dryRun: false, migrations: [created.id] });
    const [gone] = await admin.query<{ ok: boolean }>("SELECT to_regclass($1) IS NULL AS ok", [`${q(schema)}.notes`]);
    expect(gone?.ok).toBe(true);
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});

integration("migration baseline marks a hand-built schema applied through the CLI", async () => {
  const copy = await packageCopy("baseline");
  const schema = testSchema();
  const admin = raw();
  try {
    const created = (await copy.cli("migration", "create", "add_notes")) as { id: string; path: string };
    await copy.write(created.path, "--up\nCREATE TABLE notes (id integer PRIMARY KEY);\n--down\nDROP TABLE notes;\n");
    await copy.codegen();
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "notes")} (id integer PRIMARY KEY)`);
    expect(await copy.cli("migration", "baseline", created.id, "--schema", schema)).toEqual({ migrations: [created.id] });
    expect(await copy.cli("migrate", "--schema", schema)).toEqual({ dryRun: false, migrations: [] });
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});

integration("migrate --safety-point stops before migrating when the safety point cannot be taken", async () => {
  const copy = await packageCopy("safety");
  const schema = testSchema();
  const admin = raw();
  try {
    const created = (await copy.cli("migration", "create", "add_notes")) as { id: string; path: string };
    await copy.write(created.path, "--up\nCREATE TABLE notes (id integer PRIMARY KEY);\n--down\nDROP TABLE notes;\n");
    await copy.codegen();
    // Gizli giriş boş: API anahtarı yok → nokta alınamaz → migrate hiç çalışmaz.
    const failed = await copy.cliRaw("migrate", "--schema", schema, "--safety-point", "neon");
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({ error: "USAGE" });
    expect(await schemaExists(admin, schema)).toBe(false);
    expect((await copy.cliRaw("migrate", "--schema", schema, "--org", "org-1")).code).toBe(1); // --org yalnızca neon ile
    // --dry-run nokta almaz: Neon anahtarı sorulmaz, Supabase noktası yazdırılmaz (stdout'ta yalnızca sonuç belgesi).
    for (const provider of ["neon", "supabase"]) {
      const run = await copy.cliRaw("migrate", "--schema", schema, "--dry-run", "--safety-point", provider);
      expect(run.code, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ dryRun: true, migrations: [created.id] });
    }
  } finally {
    await dropSchema(admin, schema);
    await admin.close();
    await copy.remove();
  }
});
