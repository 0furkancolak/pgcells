import { expect, test } from "bun:test";
import { AppError } from "../../core/errors";
import { migrateBatch } from "../../core/migrations/batch";

const targets = (databaseId: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    tenantId: `${databaseId}_${String(i).padStart(4, "0")}`,
    databaseId,
    schemaName: `tenant_${databaseId}_${i}`,
    status: "active",
  }));
const options = { concurrency: 8, pageSize: 13, shutdownGraceMs: 20 };

test("1000 targets stay paginated, run concurrently and respect global and database budgets", async () => {
  const rows = [targets("a", 500), targets("b", 500)];
  let active = 0,
    peak = 0,
    acquired = 0,
    completed = 0,
    peakBuffer = 0;
  const byDb: Record<string, number> = { a: 0, b: 0 };
  const seen = new Set<string>();
  const summary = await migrateBatch(
    {
      databases: [
        { id: "a", concurrency: 3 },
        { id: "b", concurrency: 6 },
      ],
      listPage: async (id, after, limit) => {
        const page = (rows[id === "a" ? 0 : 1] ?? [])
          .filter((r) => r.tenantId > after)
          .slice(0, limit);
        acquired += page.length;
        peakBuffer = Math.max(peakBuffer, acquired - completed);
        return page;
      },
      run: async (target) => {
        expect(seen.has(target.tenantId)).toBe(false);
        seen.add(target.tenantId);
        active++;
        byDb[target.databaseId] = (byDb[target.databaseId] ?? 0) + 1;
        peak = Math.max(peak, active);
        expect(active).toBeLessThanOrEqual(8);
        expect(byDb[target.databaseId]).toBeLessThanOrEqual(
          target.databaseId === "a" ? 3 : 6,
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        byDb[target.databaseId] = (byDb[target.databaseId] ?? 0) - 1;
        completed++;
      },
    },
    options,
  );
  expect(summary).toMatchObject({
    succeeded: 1000,
    failed: 0,
    incomplete: false,
  });
  expect(peak).toBe(8);
  expect(peakBuffer).toBeLessThanOrEqual(
    2 * options.pageSize + options.concurrency,
  );
});

test("inactive tenants are reported as skipped without marking the run incomplete", async () => {
  const rows = targets("a", 3).map((row, i) =>
    i === 1 ? { ...row, status: "provisioning" } : row,
  );
  const events: unknown[] = [];
  const summary = await migrateBatch(
    {
      databases: [{ id: "a", concurrency: 1 }],
      listPage: async (_id, after, limit) =>
        rows.filter((r) => r.tenantId > after).slice(0, limit),
      run: async () => {},
    },
    options,
    (event) => events.push(event),
  );
  expect(summary).toEqual({
    succeeded: 2,
    failed: 0,
    skipped: 1,
    incomplete: false,
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      tenantId: "a_0001",
      reason: "tenant-not-active",
    }),
  );
});

test("a slow database page does not block a ready database", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  await migrateBatch(
    {
      databases: [
        { id: "a", concurrency: 1 },
        { id: "b", concurrency: 1 },
      ],
      listPage: async (id, after) => {
        if (id === "a") await slow;
        return after ? [] : targets(id, 1);
      },
      run: async (target) => {
        order.push(target.databaseId);
        if (target.databaseId === "b") release();
      },
    },
    { ...options, pageSize: 1 },
  );
  expect(order).toEqual(["b", "a"]);
});

test("fail-fast stops admission; continue-on-error completes independent schemas", async () => {
  for (const continueOnError of [false, true]) {
    const seen: string[] = [];
    const summary = await migrateBatch(
      {
        databases: [{ id: "a", concurrency: 1 }],
        listPage: async (_id, after, limit) =>
          targets("a", 10)
            .filter((r) => r.tenantId > after)
            .slice(0, limit),
        run: async (target) => {
          seen.push(target.tenantId);
          if (seen.length === 1) throw new AppError("DDL_FAILED", "fail");
        },
      },
      { ...options, continueOnError },
    );
    expect(summary.failed).toBe(1);
    expect(seen.length).toBe(continueOnError ? 10 : 1);
    expect(summary.incomplete).toBe(!continueOnError);
  }
});

test("cancellation stops new targets and aborts workers after the grace period", async () => {
  const aborter = new AbortController();
  let calls = 0;
  const summary = await migrateBatch(
    {
      databases: [{ id: "a", concurrency: 1 }],
      listPage: async () => targets("a", 10),
      run: async (_target, signal) => {
        calls++;
        aborter.abort();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
      },
    },
    { ...options, signal: aborter.signal },
  );
  expect(calls).toBe(1);
  expect(summary.incomplete).toBe(true);
});

test.each(["08006", "ECONNREFUSED"])(
  "native %s connection loss stops only that database in continue-on-error mode",
  async (code) => {
    const seen: string[] = [];
    const summary = await migrateBatch(
      {
        databases: [
          { id: "a", concurrency: 1 },
          { id: "b", concurrency: 1 },
        ],
        listPage: async (id, after, limit) =>
          targets(id, 5)
            .filter((r) => r.tenantId > after)
            .slice(0, limit),
        run: async (target) => {
          seen.push(target.databaseId);
          if (target.databaseId === "a")
            throw Object.assign(new Error("disconnected"), { code });
        },
      },
      { ...options, continueOnError: true },
    );
    expect(seen.filter((id) => id === "a")).toHaveLength(1);
    expect(seen.filter((id) => id === "b")).toHaveLength(5);
    expect(summary).toMatchObject({
      failed: 1,
      succeeded: 5,
      incomplete: true,
    });
  },
);

test("cancellation waits for a pending page and reports its unstarted targets", async () => {
  const aborter = new AbortController();
  let resolvePage!: (rows: ReturnType<typeof targets>) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const events: unknown[] = [];
  let completed = false;
  const work = migrateBatch(
    {
      databases: [{ id: "a", concurrency: 1 }],
      listPage: () => {
        started();
        return new Promise((resolve) => {
          resolvePage = resolve;
        });
      },
      run: async () => {
        throw new Error("must not start");
      },
    },
    { ...options, signal: aborter.signal },
    (event) => events.push(event),
  ).then((value) => {
    completed = true;
    return value;
  });
  await ready;
  aborter.abort();
  await new Promise((resolve) => setTimeout(resolve, 1));
  const returnedBeforePage = completed;
  resolvePage(targets("a", 1));
  const result = await work;
  expect(returnedBeforePage).toBe(false);
  expect(result.incomplete).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({ tenantId: "a_0000", status: "not-started" }),
  );
});
