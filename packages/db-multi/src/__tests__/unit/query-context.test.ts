import { expect, test } from "bun:test";
import { prepareQuery } from "../../core/sql/compiler";
import { createWithTenant, type TenantContext } from "../../core/tenants/context";
import { tenantSchema } from "../../core/tenants/model";

const statement = prepareQuery("SELECT id FROM students WHERE id = $1::uuid");
const placement = {
  tenantId: "demo-tenant",
  kind: "tenant" as const,
  databaseId: "one",
  schemaName: tenantSchema("demo-tenant"),
  status: "active" as const,
  schemaVersion: 3,
  placementVersion: 1,
};
function fixture(
  execute: (
    text: string,
    params: readonly unknown[],
  ) => Promise<unknown> = async () => [],
) {
  let lookups = 0,
    transactions = 0;
  const commands: { text: string; params: readonly unknown[]; tenantId?: string }[] = [];
  const raw = {
    query: async (text: string, params: readonly unknown[] = [], tenantId?: string) => {
      commands.push({ text, params, tenantId });
      return execute(text, params);
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      return work(raw);
    },
  };
  const withTenant = createWithTenant({ node: () => raw } as never, {
    get: async () => {
      lookups++;
      return placement;
    },
  });
  return {
    withTenant,
    commands,
    get lookups() {
      return lookups;
    },
    get transactions() {
      return transactions;
    },
  };
}
test("single tenant query is autocommit and binds parameters independently", async () => {
  const f = fixture();
  await f.withTenant("demo-tenant", async (db) => {
    await db.query(statement, ["value"]);
  });
  expect(f.lookups).toBe(1);
  expect(f.transactions).toBe(0);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]?.text).toContain(`"${placement.schemaName}"`);
  expect(f.commands[0]?.params).toEqual(["value"]);
  expect(f.commands[0]?.tenantId).toBe(placement.tenantId);
});
test("middleware placement is reused and explicit transaction context expires", async () => {
  const f = fixture();
  let escaped!: TenantContext;
  await f.withTenant.forPlacement(placement, async (db) => {
    await db.transaction(async (tx) => {
      escaped = tx;
      await tx.query(statement);
    });
    expect(() => escaped.query(statement)).toThrow("closed");
    await db.query(statement);
  });
  expect(f.lookups).toBe(0);
  expect(f.transactions).toBe(1);
  expect(f.commands).toHaveLength(2);
});
test("raw objects cannot bypass tenant SQL qualification", async () => {
  const f = fixture();
  await f.withTenant("demo-tenant", async (db) => {
    expect(() =>
      db.query({ bind: () => "SELECT * FROM public.students" } as never),
    ).toThrow();
  });
  expect(f.commands).toHaveLength(0);
});

test("caught autocommit query errors can recover within the context", async () => {
  const failure = new Error("duplicate key");
  const f = fixture(async (_text, values) => {
    if (values[0] === "duplicate") throw failure;
    return [{ id: values[0] }];
  });
  const result = await f.withTenant("demo-tenant", async (db) => {
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
    f.withTenant("demo-tenant", (db) =>
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
  await expect(f.withTenant("demo-tenant", (db) => db.query(statement))).rejects.toBe(
    failure,
  );
});

test("contexts close and drain unfinished queries before settling", async () => {
  for (const transactional of [false, true]) {
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(async () => {
      started();
      await waiting;
      return [];
    });
    let escaped!: TenantContext;
    let settled = false;
    const work = async (db: TenantContext) => {
      escaped = db;
      void db.query(statement);
    };
    const result = f
      .withTenant("demo-tenant", (db) =>
        transactional ? db.transaction(work) : work(db),
      )
      .finally(() => {
        settled = true;
      });
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
  await f.withTenant("demo-tenant", (db) => db.query(statement, [payload]));
  expect(f.commands[0]?.params).toEqual([payload]);
  expect(f.commands[0]?.text).not.toContain(payload);
});

test("row locks reject autocommit before dispatch but execute inside a transaction", async () => {
  const f = fixture();
  const locked = prepareQuery("SELECT id FROM students FOR UPDATE SKIP LOCKED");
  await f.withTenant("demo-tenant", async (db) => {
    expect(() => db.query(locked)).toThrow("transaction");
    expect(f.commands).toHaveLength(0);
    await db.transaction((tx) => tx.query(locked));
  });
  expect(f.commands).toHaveLength(1);
  expect(f.transactions).toBe(1);
});
