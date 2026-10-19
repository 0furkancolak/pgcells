import { expect, test } from "bun:test";
import { type Queryable, runContext } from "../../core/context";
import { prepareQuery } from "../../core/sql/compiler";

const SCHEMA = "app_test";
const statement = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");

function fixture(execute: (text: string, params: readonly unknown[]) => Promise<unknown> = async () => []) {
  let transactions = 0;
  const commands: { text: string; params: readonly unknown[] }[] = [];
  const raw = {
    query: async (text: string, params: readonly unknown[] = []) => {
      commands.push({ text, params });
      return execute(text, params);
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      return work(raw);
    },
  };
  const run = <T>(work: (db: Queryable) => Promise<T>, onWrite?: () => void) => runContext(raw as never, raw as never, SCHEMA, work, { onWrite });
  return {
    run,
    commands,
    get transactions() {
      return transactions;
    },
  };
}

test("a single query is autocommit, bound to the schema, with its own parameters", async () => {
  const f = fixture();
  await f.run((db) => db.query(statement, ["value"]));
  expect(f.transactions).toBe(0);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]?.text).toContain(`"${SCHEMA}"`);
  expect(f.commands[0]?.params).toEqual(["value"]);
});

test("an explicit transaction context expires when its callback ends", async () => {
  const f = fixture();
  let escaped!: Queryable;
  await f.run(async (db) => {
    await db.transaction(async (tx) => {
      escaped = tx;
      await tx.query(statement);
    });
    expect(() => escaped.query(statement)).toThrow("closed");
    await db.query(statement);
  });
  expect(f.transactions).toBe(1);
  expect(f.commands).toHaveLength(2);
});

test("raw objects cannot bypass SQL qualification", async () => {
  const f = fixture();
  await f.run(async (db) => {
    expect(() => db.query({ bind: () => "SELECT * FROM public.students" } as never)).toThrow(expect.objectContaining({ code: "INVALID_QUERY" }));
  });
  expect(f.commands).toHaveLength(0);
});

test("caught autocommit query errors can recover within the context", async () => {
  const failure = new Error("duplicate key");
  const f = fixture(async (_text, values) => {
    if (values[0] === "duplicate") throw failure;
    return [{ id: values[0] }];
  });
  const result = await f.run(async (db) => {
    await expect(db.query(statement, ["duplicate"])).rejects.toBe(failure);
    return db.query<{ id: string }[]>(statement, ["recovered"]);
  });
  expect(result).toEqual([{ id: "recovered" }]);
});

test("caught transaction query errors still fail the transaction", async () => {
  const failure = new Error("duplicate key");
  const f = fixture(async () => {
    throw failure;
  });
  await expect(
    f.run((db) =>
      db.transaction(async (tx) => {
        await expect(tx.query(statement)).rejects.toBe(failure);
        return "must not commit";
      }),
    ),
  ).rejects.toBe(failure);
});

test("uncaught autocommit errors propagate", async () => {
  const failure = new Error("query failed");
  const f = fixture(async () => {
    throw failure;
  });
  await expect(f.run((db) => db.query(statement))).rejects.toBe(failure);
});

test("contexts close and drain unfinished queries before settling", async () => {
  for (const transactional of [false, true]) {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const f = fixture(async () => {
      started();
      await waiting;
      return [];
    });
    let escaped!: Queryable;
    let settled = false;
    const work = async (db: Queryable) => {
      escaped = db;
      void db.query(statement);
    };
    const result = f.run((db) => (transactional ? db.transaction(work) : work(db))).finally(() => (settled = true));
    await ready;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(() => escaped.query(statement)).toThrow("closed");
    release();
    await result;
    expect(settled).toBe(true);
  }
});

test("bound adversarial payloads never become SQL source", async () => {
  const f = fixture();
  const payload = "'); SELECT * FROM public.students; /* ' */ --";
  await f.run((db) => db.query(statement, [payload]));
  expect(f.commands[0]?.params).toEqual([payload]);
  expect(f.commands[0]?.text).not.toContain(payload);
});

test("row locks reject autocommit before dispatch but execute inside a transaction", async () => {
  const f = fixture();
  const locked = prepareQuery("SELECT id FROM students FOR UPDATE SKIP LOCKED");
  await f.run(async (db) => {
    expect(() => db.query(locked)).toThrow(expect.objectContaining({ code: "TRANSACTION_REQUIRED" }));
    expect(f.commands).toHaveLength(0);
    await db.transaction((tx) => tx.query(locked));
  });
  expect(f.commands).toHaveLength(1);
  expect(f.transactions).toBe(1);
});

test("nested transactions are refused", async () => {
  const f = fixture();
  await expect(f.run((db) => db.transaction((tx) => tx.transaction(async () => 1)))).rejects.toMatchObject({ code: "NESTED_TRANSACTION" });
});
