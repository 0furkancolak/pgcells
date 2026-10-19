import { expect } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { createWithTenant } from "../../core/tenants/context";
import { failure, integration, q, raw } from "./helpers";

const schemaName = () => `tenant_${crypto.randomUUID().replaceAll("-", "")}`;

integration("compiled intervals retain PostgreSQL precision and field semantics", async () => {
  const db = raw();
  const schema = schemaName();
  try {
    await db.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const [source, values] of [
      ["SELECT $1::interval(3) AS value", ["1.123456 seconds"]],
      ["SELECT CAST($1 AS INTERVAL(3)) AS value", ["1.123456 seconds"]],
      ["SELECT INTERVAL '1 year 2 months' YEAR", []],
    ] as const) {
      const original = await db.query(source, [...values]);
      const compiled = await db.query(prepareQuery(source).bind(schema), [...values]);
      expect(compiled).toEqual(original);
      if (values.length) expect(original[0]?.value).toBe("00:00:01.123");
    }
    await db.exec(`CREATE TABLE ${q(schema, "original")} (duration interval(3))`);
    for (const source of prepareMigration("CREATE TABLE compiled (duration interval(3))").bind(schema)) await db.exec(source);
    await db.exec(
      `INSERT INTO ${q(schema, "original")} VALUES ('1.123456 seconds'); INSERT INTO ${q(schema, "compiled")} VALUES ('1.123456 seconds')`,
    );
    const original = await db.query(`SELECT duration::text AS value FROM ${q(schema, "original")}`);
    expect(await db.query(`SELECT duration::text AS value FROM ${q(schema, "compiled")}`)).toEqual(original);
    expect(original[0]?.value).toBe("00:00:01.123");
    const modifiers = await db.query(
      "SELECT a.atttypmod FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND a.attname = 'duration' ORDER BY c.relname",
      [schema],
    );
    expect(modifiers).toHaveLength(2);
    expect(modifiers[0]?.atttypmod).toBe(modifiers[1]?.atttypmod);
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await db.close();
  }
});

integration("comment projection and bound payloads agree with PostgreSQL", async () => {
  const db = raw();
  const schema = schemaName();
  const payload = "'); SELECT * FROM public.users; /* ' */ --";
  try {
    expect(await db.query("SHOW standard_conforming_strings")).toEqual([{ standard_conforming_strings: "on" }]);
    for (const source of [
      "WITH items AS (SELECT $1::text AS value /* ' -- $$ */) SELECT value FROM items",
      "SELECT $1::text AS value /* outer /* ' */ nested */",
      "SELECT $1::text AS value -- ' /* $$\r\n",
      "SELECT $1::text AS value -- ' /* $$\r",
      String.raw`SELECT $1::text AS value, 'backslash\' AS plain, E'line\n/* string */' AS escaped`,
      "SELECT $1::text AS value, 1::numeric /* type ' */ (10,2) AS amount, pg_catalog /* function ' */ .lower('ABC') AS lowered",
      "SELECT $1::text AS value, 1::numeric -- type ' \r\n (10,2) AS amount",
    ]) {
      const original = await db.query(source, [payload]);
      const compiled = await db.query(prepareQuery(source).bind(schema), [payload]);
      expect(compiled).toEqual(original);
      expect(compiled[0]?.value).toBe(payload);
    }
    for (const source of [
      "SELECT 1 /* ' */; SELECT * FROM public.users; -- '",
      "SELECT 1 /* -- */; SELECT * FROM public.users; /*\n */",
      "SELECT 1 /* $$ */; SELECT * FROM public.users; -- $$ */",
    ])
      expect(() => prepareQuery(source)).toThrow(/SQL_UNSUPPORTED/);
  } finally {
    await db.close();
  }
});

integration("caught autocommit errors recover while caught transaction errors roll back", async () => {
  const db = raw();
  const schema = schemaName();
  const withTenant = createWithTenant({ node: () => db } as never, {
    get: async () => ({
      tenantId: "regression",
      kind: "tenant" as const,
      databaseId: "one",
      schemaName: schema,
      status: "active" as const,
      schemaVersion: 0,
      placementVersion: 1,
    }),
  });
  const insert = prepareQuery("INSERT INTO samples (id) VALUES ($1) RETURNING id");
  try {
    await db.exec(`CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "samples")} (id integer PRIMARY KEY)`);
    await withTenant("regression", async (tenant) => {
      await tenant.query(insert, [1]);
      expect(await failure(tenant.query(insert, [1]))).toBe("23505");
      expect(await tenant.query(insert, [2])).toEqual([{ id: 2 }]);
    });
    expect(
      await failure(
        withTenant("regression", (tenant) =>
          tenant.transaction(async (tx) => {
            await tx.query(insert, [3]);
            expect(await failure(tx.query(insert, [1]))).toBe("23505");
          }),
        ),
      ),
    ).toBe("23505");
    const rows = await withTenant("regression", (tenant) => tenant.query(prepareQuery("SELECT id FROM samples ORDER BY id")));
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  } finally {
    await db.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await db.close();
  }
});
