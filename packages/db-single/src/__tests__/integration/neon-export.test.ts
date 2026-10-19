import { expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { exportAt, neonApi } from "../../core/tools/neon";
import { createTestManagement, directConfig, dropSchema, integration, q, raw, testSchema } from "./helpers";

/** A fake Neon API presents the local database as a "past branch"; the default dependencies (the real `createManagement` + `exportSchema`) run. */
integration("exportAt exports through the default dependencies: a temporary management on the branch URI, same schema, no URI in the result", async () => {
  const [admin, schema, url] = [raw(), testSchema(), directConfig().url];
  const m = createTestManagement({ schema });
  const dir = await mkdtemp(join(import.meta.dir, "../../../.tmp-neon-export-"));
  const target = join(dir, "out");
  const send = async (input: URL, init?: RequestInit) => {
    const path = input.pathname.replace(/^\/api\/v2/, "");
    const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path === "/projects") return body({ projects: [{ id: "p1" }] });
    if (path === "/projects/p1/endpoints") return body({ endpoints: [{ id: "ep1", host: new URL(url).hostname, branch_id: "br1" }] });
    if (init?.method === "POST") return body({ branch: { id: "br2" }, endpoints: [{ id: "ep2", host: "ep-new.example" }], operations: [{ id: "op1" }] });
    if (path === "/projects/p1/operations/op1") return body({ operation: { action: "create_branch", status: "finished" } });
    if (path === "/projects/p1/connection_uri") return body({ uri: url });
    return new Response("{}", { status: 404 });
  };
  try {
    await admin.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "notes")} (id integer PRIMARY KEY, body text NOT NULL); INSERT INTO ${q(schema, "notes")} VALUES (1, 'a'), (2, 'b')`);
    const result = await exportAt(m, neonApi("neon-secret-key", { fetch: send }), { dir: target, at: "2026-10-03T09:30:00.000Z", now: new Date("2026-10-03T10:15:00Z") });
    expect(result).toMatchObject({ dir: target, tables: 1, rows: 2, branch: { name: "pitr-20261003T101500Z", branchId: "br2" } });
    expect(JSON.stringify(result)).not.toContain(new URL(url).password);
    expect((await readdir(target)).sort()).toContain("backup.json");
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
    await rm(dir, { recursive: true, force: true });
  }
});
