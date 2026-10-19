/** `test:integration` preload: the suite leaves no trace in the shared DB. At the start a snapshot of schema, database and `public` relation names
 * is taken; at the end every newly remaining name is listed and the run fails. */
import { afterAll, beforeAll } from "bun:test";
import { createTestManagement, enabled } from "./helpers";

type Snapshot = Record<string, string[]>;
let before: Snapshot | undefined;

async function snapshot(): Promise<Snapshot> {
  const m = createTestManagement();
  try {
    const names = async (sql: string) => (await m.db.query<{ name: string }>(sql)).map((row) => row.name);
    return {
      schemas: await names("SELECT nspname AS name FROM pg_catalog.pg_namespace"),
      databases: await names("SELECT datname AS name FROM pg_catalog.pg_database"),
      "public relations": await names("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"),
    };
  } finally {
    await m.close();
  }
}

beforeAll(async () => {
  if (enabled) before = await snapshot();
});

afterAll(async () => {
  if (!before) return;
  const after = await snapshot();
  const leaks = Object.entries(after).flatMap(([what, names]) => {
    const known = new Set(before?.[what]);
    const added = names.filter((name) => !known.has(name)).sort();
    return added.length ? [`${what}: ${added.join(", ")}`] : [];
  });
  if (leaks.length) throw new Error(`Integration tests left objects behind in the shared database:\n${leaks.join("\n")}`);
});
