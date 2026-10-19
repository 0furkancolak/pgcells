import { expect } from "bun:test";
import type { Driver } from "../../core/driver";
import { createDb } from "../../core/runtime";
import { prepareQuery } from "../../core/sql/compiler";
import { createDbScope, dbMiddleware, type MiddlewareContext, type RequestDb } from "../../middleware";
import { driver, failure, integration, pooledConfig, withNotes } from "./helpers";

const insert = prepareQuery("INSERT INTO notes (id, body) VALUES ($1::integer, $2::text)");
const list = prepareQuery("SELECT id, body FROM notes ORDER BY id");

/** Fake context covering just the surface Hono uses. */
function context() {
  const vars: { db?: RequestDb } = {};
  const c: MiddlewareContext = { set: (_key, value) => (vars.db = value) };
  return { c, vars };
}

/** Wraps the driver: counts opened and closed pools (to observe `perRequest` closing versus the shared pool). */
function tracking() {
  const opened: unknown[] = [];
  const closed: unknown[] = [];
  const tracked: Driver = (url, options) => {
    const pool = driver(url, options);
    opened.push(pool);
    return { ...pool, close: (ms) => (closed.push(pool), pool.close(ms)) };
  };
  return { opened, closed, driver: tracked, closeAll: () => Promise.all(opened.map((pool) => (pool as ReturnType<Driver>).close(1000))) };
}

for (const perRequest of [false, true])
  integration(`middleware (${perRequest ? "per request" : "shared pool"}) gives a request scope over real queries, transactions and reads`, () =>
    withNotes(async (schema) => {
      const pools = tracking();
      const middleware = dbMiddleware({ driver: pools.driver, config: pooledConfig(), schema, perRequest });
      try {
        for (const id of [1, 2]) {
          const { c, vars } = context();
          await middleware(c, async () => {
            const db = vars.db as RequestDb;
            await db.query(insert, [id * 10, "q"]);
            await db.transaction(async (tx) => void (await tx.query(insert, [id * 10 + 1, "tx"])));
            // A rolled-back transaction leaves no rows.
            await failure(
              db.transaction(async (tx) => {
                await tx.query(insert, [id * 10 + 2, "abort"]);
                throw new Error("abort");
              }),
            );
            expect(await db.query(list)).toHaveLength(id * 2);
            // No replica: the read runs on the primary as a single statement, and a writing query is rejected.
            expect(await db.read.query(list)).toHaveLength(id * 2);
            expect(await failure(db.read.query(insert as never, [99, "x"]))).toBe("QUERY_NOT_READ_ONLY");
          });
        }
        // The shared pool is opened once and stays open; the per-request pool closes after every response.
        expect(pools.opened).toHaveLength(perRequest ? 2 : 1);
        expect(pools.closed).toHaveLength(perRequest ? 2 : 0);
      } finally {
        if (!perRequest) await pools.closeAll();
      }
    }),
  );

integration("createDbScope gives cron and queue jobs the same scope without HTTP, and an application-opened database is shared with the middleware", () =>
  withNotes(async (schema) => {
    const db = createDb(pooledConfig(), { driver, schema });
    try {
      const job = createDbScope(db);
      await job.transaction(async (tx) => void (await tx.query(insert, [1, "cron"])));
      expect(await job.read.query(list)).toEqual([{ id: 1, body: "cron" }]);
      const { c, vars } = context();
      await dbMiddleware({ database: db })(c, async () => {
        expect(await (vars.db as RequestDb).query(list)).toEqual([{ id: 1, body: "cron" }]);
      });
      // The middleware does not close the database it is given.
      expect(await db.query(list)).toHaveLength(1);
      expect(() => dbMiddleware({ database: db, perRequest: true })).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    } finally {
      await db.close();
    }
  }),
);
