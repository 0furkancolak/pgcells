import { expect } from "bun:test";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { dropSchema, failure, inSchema, integration, q, raw, testSchema } from "./helpers";

integration("upserts stay inside their own schema and windows retain PostgreSQL default frames", async () => {
  const db = raw();
  const a = testSchema(),
    b = testSchema();
  const insert = prepareQuery(
    "INSERT INTO samples AS target (id,name,grp) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET name=excluded.name WHERE target.grp=excluded.grp RETURNING name",
  );
  const select = prepareQuery("SELECT id,name FROM samples ORDER BY id");
  try {
    for (const schema of [a, b]) {
      await db.exec(`CREATE SCHEMA ${q(schema)}`);
      for (const sql of prepareMigration("CREATE TABLE samples(id integer PRIMARY KEY, name text, grp integer)").bind(schema))
        await db.exec(sql);
      await inSchema(db, schema)((ctx) => ctx.query(insert, [1, schema === a ? "alpha" : "neighbor", 1]));
    }
    await inSchema(db, a)(async (ctx) => {
      expect(await ctx.query(insert, [1, "changed", 1])).toEqual([{ name: "changed" }]);
      expect(await ctx.query(insert, [1, "must not update", 2])).toHaveLength(0);
      await ctx.query(
        prepareQuery("INSERT INTO samples VALUES (1,'ignored',1) ON CONFLICT ON CONSTRAINT samples_pkey DO NOTHING"),
      );
      await ctx.query(prepareQuery("INSERT INTO samples VALUES (2,'beta',1),(3,'gamma',2)"));
      const rows = await ctx.query(
        prepareQuery(
          "SELECT id, row_number() OVER (ORDER BY id)::int AS position, rank() OVER (ORDER BY grp)::int AS ranking, sum(id) OVER (ORDER BY grp)::int AS running, lag(id) OVER (ORDER BY id) AS previous, last_value(id) OVER (ORDER BY id) AS last FROM samples ORDER BY id",
        ),
      );
      expect(rows).toEqual([
        { id: 1, position: 1, ranking: 1, running: 3, previous: null, last: 1 },
        { id: 2, position: 2, ranking: 1, running: 3, previous: 1, last: 2 },
        { id: 3, position: 3, ranking: 3, running: 6, previous: 2, last: 3 },
      ]);
      expect(await ctx.query(select)).toEqual([
        { id: 1, name: "changed" },
        { id: 2, name: "beta" },
        { id: 3, name: "gamma" },
      ]);
    });
    expect(await inSchema(db, b)((ctx) => ctx.query(select))).toEqual([
      { id: 1, name: "neighbor" },
    ]);
  } finally {
    for (const schema of [a, b]) await dropSchema(db, schema);
    await db.close();
  }
});

integration("NOWAIT and SKIP LOCKED contend across two live transactions", async () => {
  const owner = raw(),
    contender = raw();
  const schema = testSchema();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  let holding: Promise<unknown> | undefined;
  try {
    await owner.exec(
      `CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "samples")} (id integer PRIMARY KEY); INSERT INTO ${q(schema, "samples")} VALUES (1),(2)`,
    );
    holding = inSchema(owner, schema)((ctx) =>
      ctx.transaction(async (tx) => {
        await tx.query(prepareQuery("SELECT id FROM samples WHERE id=1 FOR UPDATE"));
        markReady();
        await held;
      }),
    );
    // A setup failure must reject the preparation instead of leaving the test hanging.
    await Promise.race([ready, holding]);
    await inSchema(contender, schema)(async (ctx) => {
      // `samples` is not a migration table: `*` is rejected at compile time (the columns must be known for camelCase output names), so the columns are written out.
      expect(() => ctx.query(prepareQuery("SELECT id FROM samples FOR UPDATE"))).toThrow("transaction");
      expect(
        await failure(
          ctx.transaction((tx) => tx.query(prepareQuery("SELECT id FROM samples WHERE id=1 FOR UPDATE NOWAIT"))),
        ),
      ).toBe("55P03");
      const skipped = await ctx.transaction((tx) =>
        tx.query(prepareQuery("SELECT id FROM samples ORDER BY id FOR UPDATE SKIP LOCKED")),
      );
      expect(skipped).toEqual([{ id: 2 }]);
    });
    release();
    await holding;
    const all = await inSchema(contender, schema)((ctx) =>
      ctx.transaction((tx) => tx.query(prepareQuery("SELECT id FROM samples ORDER BY id FOR KEY SHARE NOWAIT"))),
    );
    expect(all).toHaveLength(2);
  } finally {
    release();
    await holding?.catch(() => {});
    await owner.exec(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await Promise.all([owner.close(), contender.close()]);
  }
});

integration("expanded migration DDL rolls back and RESTRICT preserves neighboring dependencies", async () => {
  const db = raw();
  const a = testSchema(),
    b = testSchema();
  const rollback = new Error("intentional DDL rollback");
  try {
    await db.exec(
      `CREATE SCHEMA ${q(a)}; CREATE SCHEMA ${q(b)}; CREATE TABLE ${q(a, "samples")} (id integer PRIMARY KEY, name text NOT NULL); INSERT INTO ${q(a, "samples")} VALUES (1,'original')`,
    );
    const ddl = prepareMigration(`
      ALTER TABLE samples ADD COLUMN email text;
      ALTER TABLE samples RENAME COLUMN email TO contact_email;
      ALTER TABLE samples ALTER COLUMN name SET DEFAULT lower('DEFAULT');
      ALTER TABLE samples ALTER COLUMN name DROP DEFAULT;
      ALTER TABLE samples ALTER COLUMN name DROP NOT NULL;
      ALTER TABLE samples ALTER COLUMN name SET NOT NULL;
      ALTER TABLE samples ALTER COLUMN id TYPE bigint;
      ALTER TABLE samples ADD CONSTRAINT positive CHECK (id > 0);
      ALTER TABLE samples RENAME CONSTRAINT positive TO positive_id;
      ALTER TABLE samples DROP CONSTRAINT positive_id RESTRICT;
      ALTER TABLE samples DROP COLUMN contact_email RESTRICT;
      ALTER TABLE samples RENAME TO renamed;
      CREATE INDEX name_idx ON renamed(name);
      ALTER INDEX name_idx RENAME TO renamed_idx;
      DROP INDEX IF EXISTS renamed_idx RESTRICT;
      DROP TABLE renamed RESTRICT;
    `);
    await expect(
      db.transaction(async (tx) => {
        for (const sql of ddl.bind(a)) await tx.exec(sql);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await db.query(`SELECT id,name FROM ${q(a, "samples")}`)).toEqual([{ id: 1, name: "original" }]);
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='samples' ORDER BY ordinal_position",
      [a],
    );
    expect(columns.map((row) => row.column_name)).toEqual(["id", "name"]);
    await db.exec(
      `CREATE TABLE ${q(b, "neighbor")} (id integer REFERENCES ${q(a, "samples")}(id)); INSERT INTO ${q(b, "neighbor")} VALUES (1)`,
    );
    expect(
      await failure(
        db.transaction(async (tx) => {
          for (const sql of prepareMigration("DROP TABLE samples RESTRICT").bind(a)) await tx.exec(sql);
        }),
      ),
    ).toBe("2BP01");
    expect(await db.query(`SELECT id FROM ${q(b, "neighbor")}`)).toEqual([{ id: 1 }]);
    expect(await db.query(`SELECT id FROM ${q(a, "samples")}`)).toEqual([{ id: 1 }]);
  } finally {
    for (const schema of [b, a]) await dropSchema(db, schema);
    await db.close();
  }
});
