import { expect } from "bun:test";
import type { Database } from "../../core/database";
import { copySchema, fingerprint } from "../../core/tools/copy";
import { integration, q, raw } from "./helpers";

/** Source db0 and target db1 fixture databases plus a fresh tenant-shaped schema name. */
async function withPair(work: (source: Database, target: Database, schema: string) => Promise<void>, drop: string[] = []) {
  const [source, target] = [raw(0), raw(1)];
  const schema = `tenant_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await work(source, target, schema);
  } finally {
    for (const db of [source, target])
      for (const name of [...drop, schema]) await db.exec(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`);
    await Promise.all([source.close(), target.close()]);
  }
}
const present = async (db: Database, schema: string) =>
  (await db.query<{ present: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present", [schema]))[0]
    ?.present;

integration("qualified copy preserves identity, sequence options, defaults, keys and data", () =>
  withPair(async (source, target, schema) => {
    const records = q(schema, "records");
    await source.exec(`CREATE SCHEMA ${q(schema)};
      CREATE SEQUENCE ${q(schema, "descending")} AS bigint INCREMENT -2 MINVALUE -100 MAXVALUE -1 START -3 CACHE 1 CYCLE;
      CREATE TABLE ${records} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code bigint DEFAULT nextval('${schema}.descending'::regclass), name text DEFAULT 'unnamed', payload bytea, doubled bigint GENERATED ALWAYS AS (code*2) STORED, happened timestamptz, tags text[], doc jsonb, amount numeric(12,4), span interval);
      ALTER SEQUENCE ${q(schema, "records_id_seq")} RENAME TO renamed_identity;
      ALTER SEQUENCE ${q(schema, "descending")} OWNED BY ${records}.code;
      CREATE TABLE ${q(schema, "children")} (id integer PRIMARY KEY, parent bigint REFERENCES ${records} (id));
      CREATE INDEX records_name_idx ON ${records} (name)`);
    await source.query(
      `INSERT INTO ${records} (payload, happened, tags, doc, amount, span) VALUES ($1, '2026-01-02 03:04:05.123456+00', ARRAY['a','b "c"',NULL], '{"k": [1, 2]}', 12.3456, '1 day 00:00:00.000001'), (NULL, NULL, NULL, NULL, NULL, NULL)`,
      [new Uint8Array([0, 1, 255])],
    );
    await source.exec(`INSERT INTO ${q(schema, "children")} VALUES (1,1)`);
    const before = await fingerprint(source, schema);
    await copySchema(source, target, schema, 10000);
    expect(await fingerprint(target, schema)).toBe(before);
    expect(await fingerprint(source, schema)).toBe(before);
    expect(await target.query(`INSERT INTO ${records} DEFAULT VALUES RETURNING id::text,code::text,doubled::text`)).toEqual([
      { id: "3", code: "-7", doubled: "-14" },
    ]);
    await expect(copySchema(source, target, schema, 10000)).rejects.toThrow();
    expect(await target.query(`SELECT count(*)::integer AS count FROM ${records}`)).toEqual([{ count: 3 }]);
  }),
);

integration("move rejects inbound foreign keys and external or late-bound sequence defaults", () => {
  const other = `outside_${crypto.randomUUID().replaceAll("-", "")}`;
  return withPair(
    async (source, target, schema) => {
      for (const db of [source, target]) await db.exec(`CREATE SCHEMA ${q(other)}; CREATE SEQUENCE ${q(other, "ids")}`);
      const records = q(schema, "records");
      await source.exec(
        `CREATE SCHEMA ${q(schema)}; CREATE TABLE ${records} (id bigint PRIMARY KEY); CREATE TABLE ${q(other, "children")} (id bigint REFERENCES ${records} (id))`,
      );
      const refused = () => expect(copySchema(source, target, schema)).rejects.toMatchObject({ code: "UNSUPPORTED_MOVE" });
      await refused();
      await source.exec(
        `DROP TABLE ${q(other, "children")}; ALTER TABLE ${records} ALTER COLUMN id SET DEFAULT nextval('${other}.ids'::regclass)`,
      );
      await refused();
      await source.exec(`ALTER TABLE ${records} ALTER COLUMN id SET DEFAULT nextval('${other}.ids'::text)`);
      await refused();
      await source.exec(
        `ALTER TABLE ${records} ALTER COLUMN id DROP DEFAULT; ALTER TABLE ${records} ADD CONSTRAINT forbidden_sequence CHECK (id < nextval('${other}.ids'::regclass)) NOT VALID`,
      );
      await refused();
      expect(await present(target, schema)).toBe(false);
    },
    [other],
  );
});

integration("late target DDL failure rolls back copied tables and permits a clean retry", async () => {
  const hook = `copy_fault_${crypto.randomUUID().replaceAll("-", "")}`;
  let target: Database | undefined;
  try {
    await withPair(async (source, pairTarget, schema) => {
      target = pairTarget;
      await source.exec(
        `CREATE SCHEMA ${q(schema)}; CREATE TABLE ${q(schema, "records")} (id integer, name text); INSERT INTO ${q(schema, "records")} VALUES (1,'keep'); CREATE INDEX names ON ${q(schema, "records")} (name)`,
      );
      const before = await fingerprint(source, schema);
      // Generated test identifiers only; inject a failure after table data was copied.
      await pairTarget.exec(
        `CREATE FUNCTION public.${hook}() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_catalog.current_query() LIKE '%${schema}%' THEN RAISE EXCEPTION 'injected late copy failure'; END IF; END $$; CREATE EVENT TRIGGER ${hook} ON ddl_command_start WHEN TAG IN ('CREATE INDEX') EXECUTE FUNCTION public.${hook}()`,
      );
      await expect(copySchema(source, pairTarget, schema)).rejects.toThrow("injected late copy failure");
      expect(await present(pairTarget, schema)).toBe(false);
      expect(await fingerprint(source, schema)).toBe(before);
      await pairTarget.exec(`DROP EVENT TRIGGER ${hook}`);
      await copySchema(source, pairTarget, schema);
      expect(await fingerprint(pairTarget, schema)).toBe(before);
    });
  } finally {
    const cleanup = raw(1);
    await cleanup.exec(`DROP EVENT TRIGGER IF EXISTS ${hook}; DROP FUNCTION IF EXISTS public.${hook}()`);
    await cleanup.close();
    void target;
  }
});

integration("cancelling an active copy rolls back the target and retains source rows", () =>
  withPair(async (source, target, schema) => {
    const records = q(schema, "records");
    await source.exec(
      `CREATE SCHEMA ${q(schema)}; CREATE TABLE ${records} (id integer, payload text); INSERT INTO ${records} SELECT id, repeat('x',4096) FROM generate_series(1,20000) id`,
    );
    const aborter = new AbortController();
    let finished = false;
    const copying = copySchema(source, target, schema, 15000, aborter.signal)
      .then(
        () => ({ failed: false }),
        () => ({ failed: true }),
      )
      .finally(() => {
        finished = true;
      });
    const deadline = Date.now() + 10000;
    let observed = false;
    while (!finished && Date.now() < deadline) {
      const active = await target.query(
        "SELECT 1 FROM pg_catalog.pg_stat_activity WHERE state='active' AND query LIKE $1",
        [`INSERT INTO "${schema}".%`],
      );
      if (active.length) {
        observed = true;
        aborter.abort();
        break;
      }
      await Bun.sleep(2);
    }
    if (!observed) aborter.abort();
    const result = await copying;
    expect(observed).toBe(true);
    expect(result.failed).toBe(true);
    expect(await present(target, schema)).toBe(false);
    expect(await source.query(`SELECT count(*)::integer AS count FROM ${records}`)).toEqual([{ count: 20000 }]);
    await copySchema(source, target, schema, 15000);
    expect(await target.query(`SELECT count(*)::integer AS count FROM ${records}`)).toEqual([{ count: 20000 }]);
  }),
);
