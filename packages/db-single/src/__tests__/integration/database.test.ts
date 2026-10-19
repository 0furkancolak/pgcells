import { expect } from "bun:test";
import { schemaExists } from "../../core/catalog";
import { createDb } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { directConfig, driver, failure, integration, pooledConfig, raw, testSchema, withNotes } from "./helpers";

const insert = prepareQuery("INSERT INTO notes (id, body) VALUES ($1::integer, $2::text)");
const list = prepareQuery("SELECT id, body FROM notes ORDER BY id");

integration("createDb runs prepared queries, transactions and reads through the pooler", async () => {
  await withNotes(async (schema) => {
    const db = createDb(pooledConfig(), { driver, schema });
    try {
      await db.ready();
      await db.query(insert, [1, "a"]);
      await db.transaction(async (tx) => void (await tx.query(insert, [2, "b"])));
      expect(await db.query(list)).toEqual([{ id: 1, body: "a" }, { id: 2, body: "b" }]);
      await failure(
        db.transaction(async (tx) => {
          await tx.query(insert, [3, "c"]);
          throw new Error("abort");
        }),
      );
      expect(await db.query(list)).toHaveLength(2);
      // No replica configured: the read runs on the primary as a single statement.
      expect(await db.read.query(list)).toHaveLength(2);
      expect(await failure(db.read.query(insert as never, [9, "x"]))).toBe("QUERY_NOT_READ_ONLY");
    } finally {
      await db.close();
    }
  });
});

integration("ready() refuses a direct URL with POOLER_REQUIRED unless the pooler is assumed", async () => {
  const strict = createDb(directConfig(), { driver });
  try {
    expect(await failure(strict.ready())).toBe("POOLER_REQUIRED");
  } finally {
    await strict.close();
  }
  const assumed = createDb(directConfig(), { driver, pooler: "assumed" });
  try {
    await assumed.ready();
  } finally {
    await assumed.close();
  }
});

integration("the default schema is public and a public table the package did not create stays untouched", async () => {
  const admin = raw();
  const table = `single_default_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const select = prepareQuery(`SELECT count(*)::integer AS n FROM ${table}`);
  try {
    await admin.exec(`CREATE TABLE public.${table} (id integer)`);
    await admin.exec(`INSERT INTO public.${table} VALUES (1), (2)`);
    const db = createDb(pooledConfig(), { driver });
    try {
      expect(await db.query(select)).toEqual([{ n: 2 }]);
      expect(db.schema).toBe("public");
    } finally {
      await db.close();
    }
  } finally {
    await admin.exec(`DROP TABLE IF EXISTS public.${table}`);
    await admin.close();
  }
});

integration("schemaExists tells a missing schema from an existing one", async () => {
  const admin = raw();
  try {
    expect(await schemaExists(admin, "public")).toBe(true);
    expect(await schemaExists(admin, testSchema())).toBe(false);
  } finally {
    await admin.close();
  }
});
