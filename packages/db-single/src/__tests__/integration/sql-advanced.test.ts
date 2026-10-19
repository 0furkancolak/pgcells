import { expect } from "bun:test";
import { createRunner } from "../../core/migrations/runner";
import { compileMigrations } from "../../core/migrations/source";
import { prepareMigration, prepareQuery } from "../../core/sql/compiler";
import { functions } from "../../core/sql/grammar";
import { createTestManagement, dropSchema, failure, inSchema, integration, q, raw, roundTrip, testSchema } from "./helpers";

/** Each test sets up and drops its own schema; `setup`: the migration SQL that runs in this schema. */
async function withSchema(setup: string, work: (run: ReturnType<typeof inSchema>) => Promise<void>) {
  const db = raw();
  const schema = testSchema();
  try {
    await db.exec(`CREATE SCHEMA ${q(schema)}`);
    for (const sql of prepareMigration(setup).bind(schema)) await db.exec(sql);
    await work(inSchema(db, schema));
  } finally {
    await dropSchema(db, schema);
    await db.close();
  }
}

const EVENTS = "CREATE TABLE events (id integer PRIMARY KEY, name text NOT NULL, data jsonb NOT NULL, tags text[] NOT NULL)";
const seed = prepareQuery(
  `INSERT INTO events (id, name, data, tags) VALUES
   (1, 'Ada', '{"a":1,"b":{"c":"x"},"list":[1,2]}', '{x,y}'),
   (2, 'Bob', '{"z":2}', '{}')`,
);

integration("JSON, regex and containment operators evaluate in PostgreSQL on every driver", async () => {
  await withSchema(EVENTS, (run) =>
    run(async (ctx) => {
      await ctx.query(seed);
      const ids = (sql: string, values: unknown[] = []) => ctx.query(prepareQuery(`${sql} ORDER BY events.id`), values);
      expect(await ids("SELECT id FROM events WHERE data ? 'a'")).toEqual([{ id: 1 }]);
      // `?` is not counted as a placeholder: it also works with a parameter.
      expect(await ids("SELECT id FROM events WHERE data ? $1", ["z"])).toEqual([{ id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE data ?| ARRAY['a', 'z']")).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE data ?& ARRAY['a', 'b']")).toEqual([{ id: 1 }]);
      expect(await ids(`SELECT id FROM events WHERE data @> '{"a":1}'`)).toEqual([{ id: 1 }]);
      expect(await ids(`SELECT id FROM events WHERE data <@ '{"a":1,"b":{"c":"x"},"list":[1,2],"extra":true}'`)).toEqual([{ id: 1 }]);
      expect(await ids("SELECT id FROM events WHERE name ~ '^A'")).toEqual([{ id: 1 }]);
      expect(await ids("SELECT id FROM events WHERE name ~* '^b'")).toEqual([{ id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE name !~ '^A'")).toEqual([{ id: 2 }]);
      expect(await ids("SELECT id FROM events WHERE name !~* '^b'")).toEqual([{ id: 1 }]);
      expect(
        await ctx.query(
          prepareQuery(
            "SELECT data->'a' AS a, data->>'a' AS a_text, data->'b'->>'c' AS c, data#>>'{b,c}' AS deep, jsonb_extract_path(data, 'b') AS sub FROM events WHERE id = 1",
          ),
        ),
      ).toEqual([{ a: 1, aText: "1", c: "x", deep: "x", sub: { c: "x" } }]);
    }),
  );
});

integration("JSON, array, text and regex functions evaluate in PostgreSQL", async () => {
  await withSchema(EVENTS, (run) =>
    run(async (ctx) => {
      await ctx.query(seed);
      const [row] = await ctx.query(
        prepareQuery(
          `SELECT jsonb_set(data, '{a}', '5') AS d, concat(name, '!') AS c, replace(name, 'Ada', 'Eve') AS r, btrim('  x ') AS t1, trim('  y ') AS t2,
                  array_length(tags, 1) AS n, regexp_replace(name, '[aeiou]', '_', 'g') AS rr, array_length(regexp_match(name, '^(A)(d)'), 1) AS m,
                  jsonb_extract_path_text(data, 'b', 'c') AS x, jsonb_extract_path_text(data, $1, $2) AS y
           FROM events WHERE id = 1`,
        ),
        ["b", "c"],
      );
      expect(row).toEqual({ d: { a: 5, b: { c: "x" }, list: [1, 2] }, c: "Ada!", r: "Eve", t1: "x", t2: "y", n: 2, rr: "Ad_", m: 2, x: "x", y: "x" });
    }),
  );
});

integration("table-returning functions work in FROM and in the select list", async () => {
  await withSchema(EVENTS, (run) =>
    run(async (ctx) => {
      await ctx.query(seed);
      expect(await ctx.query(prepareQuery("SELECT g FROM generate_series(1, 3) AS g ORDER BY g"))).toEqual([{ g: 1 }, { g: 2 }, { g: 3 }]);
      expect(
        await ctx.query(prepareQuery("SELECT e.key, e.value FROM events, jsonb_each(events.data) AS e WHERE events.id = 2")),
      ).toEqual([{ key: "z", value: 2 }]);
      expect(await ctx.query(prepareQuery("SELECT unnest(tags) AS tag FROM events WHERE id = 1 ORDER BY tag"))).toEqual([{ tag: "x" }, { tag: "y" }]);
      expect(
        await ctx.query(
          prepareQuery(
            "SELECT events.id, e.elem FROM events CROSS JOIN LATERAL jsonb_array_elements(events.data->'list') AS e(elem) WHERE events.id = 1 ORDER BY e.elem",
          ),
        ),
      ).toEqual([{ id: 1, elem: 1 }, { id: 1, elem: 2 }]);
      expect(
        await ctx.query(prepareQuery("SELECT e.* FROM events, jsonb_each(events.data) AS e(key_name, val) WHERE events.id = 2")),
      ).toEqual([{ keyName: "z", val: 2 }]);
    }),
  );
});

// `readOnly` (the replica read context) relies on the allowlist being side-effect free: the only `volatile` exception in the catalog is `gen_random_uuid`.
integration("allowlisted functions are not volatile in the catalog (except gen_random_uuid)", async () => {
  const db = raw();
  try {
    const rows = (await db.query(
      `SELECT DISTINCT proname AS name FROM pg_catalog.pg_proc
       WHERE pronamespace = 'pg_catalog'::regnamespace AND provolatile = 'v'
         AND proname IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY 1`,
      [JSON.stringify([...functions])],
    )) as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(["gen_random_uuid"]);
  } finally {
    await db.close();
  }
});

const NODES = "CREATE TABLE nodes (id integer PRIMARY KEY, parent_id integer)";
const IDS = "CREATE TABLE left_ids (id integer); CREATE TABLE right_ids (id integer)";
const SALES = "CREATE TABLE sales (id integer PRIMARY KEY, region text NOT NULL, product text NOT NULL, amount integer NOT NULL, note text)";

integration("WITH RECURSIVE walks a tree", async () => {
  await withSchema(NODES, (run) =>
    run(async (ctx) => {
      await ctx.query(prepareQuery("INSERT INTO nodes (id, parent_id) VALUES (1, NULL), (2, 1), (3, 1), (4, 2), (5, NULL)"));
      const rows = await ctx.query(
        prepareQuery(
          `WITH RECURSIVE tree AS (SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = $1::integer
             UNION ALL SELECT n.id, n.parent_id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id)
           SELECT id, depth FROM tree ORDER BY depth, id`,
        ),
        [1],
      );
      expect(rows).toEqual([{ id: 1, depth: 0 }, { id: 2, depth: 1 }, { id: 3, depth: 1 }, { id: 4, depth: 2 }]);
    }),
  );
});

integration("INTERSECT, EXCEPT and their ALL forms follow PostgreSQL precedence", async () => {
  await withSchema(IDS, (run) =>
    run(async (ctx) => {
      await ctx.query(prepareQuery("INSERT INTO left_ids (id) VALUES (1), (2), (3), (3)"));
      await ctx.query(prepareQuery("INSERT INTO right_ids (id) VALUES (2), (3), (4)"));
      const ids = async (sql: string) => (await ctx.query(prepareQuery(sql))).map((row) => (row as { id: number }).id);
      expect(await ids("SELECT id FROM left_ids INTERSECT SELECT id FROM right_ids ORDER BY id")).toEqual([2, 3]);
      expect(await ids("SELECT id FROM left_ids EXCEPT SELECT id FROM right_ids ORDER BY id")).toEqual([1]);
      expect(await ids("SELECT id FROM left_ids INTERSECT ALL SELECT id FROM right_ids ORDER BY id")).toEqual([2, 3]);
      expect(await ids("SELECT id FROM left_ids EXCEPT ALL SELECT id FROM right_ids ORDER BY id")).toEqual([1, 3]);
      // INTERSECT binds tighter than UNION: left ∪ (right ∩ {4}); had it been read left-associatively, the result would be just [4].
      expect(
        await ids("SELECT id FROM left_ids UNION SELECT id FROM right_ids INTERSECT SELECT id FROM right_ids WHERE id > 3 ORDER BY id"),
      ).toEqual([1, 2, 3, 4]);
    }),
  );
});

integration("IS DISTINCT FROM compares NULLs, window frames and grouping sets evaluate", async () => {
  await withSchema(SALES, (run) =>
    run(async (ctx) => {
      await ctx.query(
        prepareQuery(
          "INSERT INTO sales (id, region, product, amount, note) VALUES (1, 'eu', 'a', 10, NULL), (2, 'eu', 'b', 20, 'x'), (3, 'us', 'a', 30, NULL), (4, 'us', 'b', 40, 'y')",
        ),
      );
      expect(await ctx.query(prepareQuery("SELECT id FROM sales WHERE note IS DISTINCT FROM 'x' ORDER BY id"))).toEqual([{ id: 1 }, { id: 3 }, { id: 4 }]);
      expect(await ctx.query(prepareQuery("SELECT id FROM sales WHERE note IS NOT DISTINCT FROM $1::text ORDER BY id"), [null])).toEqual([{ id: 1 }, { id: 3 }]);

      const frame = async (clause: string) =>
        (await ctx.query(prepareQuery(`SELECT sum(amount) OVER (ORDER BY id ${clause})::integer AS s FROM sales ORDER BY id`))).map((row) => (row as { s: number }).s);
      expect(await frame("ROWS BETWEEN 1 PRECEDING AND CURRENT ROW")).toEqual([10, 30, 50, 70]);
      expect(await frame("ROWS UNBOUNDED PRECEDING")).toEqual([10, 30, 60, 100]);
      expect(await frame("RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING")).toEqual([100, 100, 100, 100]);

      expect(
        await ctx.query(
          prepareQuery(
            "SELECT region, sum(amount)::integer AS total, grouping(region)::integer AS g FROM sales GROUP BY ROLLUP (region) ORDER BY g, region",
          ),
        ),
      ).toEqual([{ region: "eu", total: 30, g: 0 }, { region: "us", total: 70, g: 0 }, { region: null, total: 100, g: 1 }]);
      expect(
        await ctx.query(
          prepareQuery(
            "SELECT region, product, sum(amount)::integer AS total FROM sales GROUP BY GROUPING SETS ((region), (product)) ORDER BY region, product",
          ),
        ),
      ).toEqual([
        { region: "eu", product: null, total: 30 },
        { region: "us", product: null, total: 70 },
        { region: null, product: "a", total: 40 },
        { region: null, product: "b", total: 60 },
      ]);
      const cube = await ctx.query(prepareQuery("SELECT region, product, sum(amount)::integer AS total FROM sales GROUP BY CUBE (region, product)"));
      expect(cube).toHaveLength(9);
      expect(cube).toContainEqual({ region: null, product: null, total: 100 });
    }),
  );
});

// There is no new mechanism for runaway recursion: the server-side statement_timeout stops it, and the backend does not keep running in the background.
integration("a runaway recursive CTE is ended by the server statement timeout", async () => {
  const db = raw();
  const runaway = prepareQuery("WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r) SELECT count(*) AS runaway_marker FROM r").bind(testSchema());
  try {
    const started = performance.now();
    expect(await failure(db.transaction((tx) => tx.query(runaway, []), { statementTimeoutMs: 500 }))).toBe("DATABASE_TIMEOUT");
    expect(performance.now() - started).toBeLessThan(10_000);
    let active = 1;
    for (let attempt = 0; attempt < 20 && active > 0; attempt++) {
      const [row] = (await db.query(
        "SELECT count(*)::integer AS n FROM pg_catalog.pg_stat_activity WHERE state = 'active' AND query LIKE '%runaway_marker%' AND pid <> pg_catalog.pg_backend_pid()",
        [],
      )) as { n: number }[];
      active = row?.n ?? 0;
      if (active > 0) await Bun.sleep(100);
    }
    expect(active).toBe(0);
  } finally {
    await db.close();
  }
});

const HOSTS = `CREATE TABLE hosts (id serial PRIMARY KEY, label text NOT NULL, ip inet NOT NULL, net cidr, mac macaddr, doc tsvector, topic tsquery,
  span int4range, big int8range, price numrange, local_span tsrange, valid tstzrange, day daterange)`;
const seedHosts = prepareQuery(
  `INSERT INTO hosts (label, ip, net, mac, doc, topic, span, big, price, local_span, valid, day) VALUES
   ('a', '10.0.0.1/24', '10.0.0.0/8', '08:00:2b:01:02:03', to_tsvector('simple', 'quick brown fox'), to_tsquery('simple', 'fox'), '[1,5)', '[1,5)', '[1.5,2.5)',
    '[2026-01-01 00:00:00,2026-02-01 00:00:00)', '[2026-01-01 00:00:00+00,2026-02-01 00:00:00+00)', '[2026-01-01,2026-02-01)'),
   ('b', '192.168.0.1', NULL, NULL, to_tsvector('simple', 'lazy dog'), NULL, '[10,20)', NULL, NULL, NULL, NULL, NULL)`,
);

integration("network, text-search and range types round-trip as strings on every driver", async () => {
  await withSchema(HOSTS, (run) =>
    run(async (ctx) => {
      await ctx.query(seedHosts);
      expect(
        await ctx.query(prepareQuery("SELECT id, ip, net, mac, doc, topic, span, big, price, local_span, valid, day FROM hosts WHERE label = 'a'")),
      ).toEqual([
        {
          id: 1,
          ip: "10.0.0.1/24",
          net: "10.0.0.0/8",
          mac: "08:00:2b:01:02:03",
          doc: "'brown':2 'fox':3 'quick':1",
          topic: "'fox'",
          span: "[1,5)",
          big: "[1,5)",
          price: "[1.5,2.5)",
          localSpan: '["2026-01-01 00:00:00","2026-02-01 00:00:00")',
          valid: '["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")',
          day: "[2026-01-01,2026-02-01)",
        },
      ]);
      // Writing and reading with a parameter: the value type is string, the cast is on the parameter.
      await ctx.query(prepareQuery("INSERT INTO hosts (label, ip, span, valid) VALUES ($1, $2::inet, $3::int4range, $4::tstzrange)"), [
        "c",
        "172.16.0.1",
        "[10,20)",
        "[2026-03-01 00:00:00+00,2026-04-01 00:00:00+00)",
      ]);
      expect(await ctx.query(prepareQuery("SELECT ip, span, valid FROM hosts WHERE label = $1"), ["c"])).toEqual([
        { ip: "172.16.0.1", span: "[10,20)", valid: '["2026-03-01 00:00:00+00","2026-04-01 00:00:00+00")' },
      ]);
    }),
  );
});

integration("tsvector, network and range operators evaluate", async () => {
  await withSchema(HOSTS, (run) =>
    run(async (ctx) => {
      await ctx.query(seedHosts);
      const labels = async (where: string, values: unknown[] = []) =>
        (await ctx.query(prepareQuery(`SELECT label FROM hosts WHERE ${where} ORDER BY label`), values)).map((row) => (row as { label: string }).label);
      expect(await labels("doc @@ to_tsquery('simple', $1)", ["fox"])).toEqual(["a"]);
      expect(await labels("doc @@ plainto_tsquery('simple', 'quick fox')")).toEqual(["a"]);
      expect(await labels(`doc @@ websearch_to_tsquery('simple', '"quick brown"')`)).toEqual(["a"]);
      expect(await labels("ip << '10.0.0.0/8'::inet")).toEqual(["a"]);
      expect(await labels("ip >> '10.0.0.1'::inet")).toEqual(["a"]);
      expect(await labels("span && '[4,10)'::int4range")).toEqual(["a"]);
      expect(await labels("span @> $1::integer", [3])).toEqual(["a"]);
      expect(await ctx.query(prepareQuery("SELECT ts_rank(doc, to_tsquery('simple', 'fox')) > 0 AS ranked, ARRAY[1, 2] && ARRAY[2, 3] AS overlap FROM hosts WHERE label = 'a'"))).toEqual([
        { ranked: true, overlap: true },
      ]);
    }),
  );
});

/** `up`/`table`: the DDL of a single migration and its rollback; the schema is set up with `migrate`, and rows and definitions must stay the same after coming back from a backup
 * (`ignore`: definition lines PostgreSQL rewrites, changing only their spelling). */
async function surviveBackup(table: string, up: string, rows: string, afterwards?: (admin: ReturnType<typeof raw>, schema: string) => Promise<void>, ignore?: RegExp) {
  const registry = { migrations: compileMigrations([["20260101000001_setup", `--up\n${up}\n--down\nDROP TABLE ${table};\n`]]), seeds: [] };
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  try {
    await createRunner(registry).migrate(m);
    await admin.exec(rows.replaceAll("<schema>", q(schema)));
    const { before, after } = await roundTrip(m, m, registry);
    const kept = (view: typeof before) => ({ ...view, definitions: view.definitions.filter((line) => !ignore?.test(line)) });
    expect(kept(after)).toEqual(kept(before));
    await afterwards?.(admin, schema);
  } finally {
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
}

// After export/restore, serial sequences continue where they left off.
integration("serial columns survive a backup restore and keep counting", () =>
  surviveBackup(
    "tickets",
    "CREATE TABLE tickets (id serial PRIMARY KEY, label text NOT NULL, big bigserial);",
    "INSERT INTO <schema>.tickets (label) VALUES ('a'), ('b')",
    async (admin, schema) => {
      expect(await admin.query(`INSERT INTO ${q(schema, "tickets")} (label) VALUES ('c') RETURNING id, big::text AS big`)).toEqual([{ id: 3, big: "3" }]);
    },
  ),
);

// The backup tool must be able to carry every type the compiler accepts (SHAPE_RULES allowlist).
integration("a schema with every extra type survives a backup restore with identical contents", () =>
  surviveBackup(
    "hosts",
    `${HOSTS};`,
    `INSERT INTO <schema>.hosts (label, ip, net, mac, doc, topic, span, big, price, local_span, valid, day) VALUES
       ('a', '10.0.0.1/24', '10.0.0.0/8', '08:00:2b:01:02:03', to_tsvector('simple', 'quick brown fox'), to_tsquery('simple', 'fox'), '[1,5)', '[1,5)', '[1.5,2.5)',
        '[2026-01-01 00:00:00,2026-02-01 00:00:00)', '[2026-01-01 00:00:00+00,2026-02-01 00:00:00+00)', '[2026-01-01,2026-02-01)')`,
  ),
);

// The catalog spells long type names (`character varying`, `timestamp with time zone`, …): defaults and CHECK expressions can still be backed up.
integration("defaults the catalog spells with long type names survive a backup restore", () =>
  surviveBackup(
    "orders",
    `CREATE TABLE orders (id serial PRIMARY KEY, status varchar(20) NOT NULL DEFAULT 'pending',
       placed timestamptz NOT NULL DEFAULT '2026-01-01 00:00:00+00'::timestamptz, local_at timestamp NOT NULL DEFAULT '2026-01-01 00:00:00'::timestamp,
       opens time NOT NULL DEFAULT '10:00:00'::time);`,
    "INSERT INTO <schema>.orders (id) VALUES (1); INSERT INTO <schema>.orders (id, status) VALUES (2, 'done')",
    async (admin, schema) => {
      expect(await admin.query(`INSERT INTO ${q(schema, "orders")} (id) VALUES (3) RETURNING status, local_at::text AS local_at, opens::text AS opens`)).toEqual([
        { status: "pending", local_at: "2026-01-01 00:00:00", opens: "10:00:00" },
      ]);
    },
  ),
);

// PostgreSQL spells `IN` as `= ANY ((ARRAY['a'::character varying, …])::text[])`; on restore the array is converted per element (spelling difference, same meaning).
integration("a varchar CHECK the catalog spells with ANY(ARRAY[…]) survives a backup restore and is still enforced", () =>
  surviveBackup(
    "tickets",
    "CREATE TABLE tickets (id integer PRIMARY KEY, status varchar(20) NOT NULL CHECK (status IN ('pending', 'done')));",
    "INSERT INTO <schema>.tickets VALUES (1, 'pending')",
    async (admin, schema) => {
      expect(await failure(admin.exec(`INSERT INTO ${q(schema, "tickets")} VALUES (2, 'bogus')`))).toBe("23514");
      await admin.exec(`INSERT INTO ${q(schema, "tickets")} VALUES (3, 'done')`);
    },
    /^CHECK/,
  ),
);
