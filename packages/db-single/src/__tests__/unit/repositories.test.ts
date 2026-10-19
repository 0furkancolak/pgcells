import { expect, test } from "bun:test";
import * as sql from "@0furkancolak/pgcells-single/queries/users";
import { createUser, deleteUser, findUserByEmail, findUserById, findUsers } from "@0furkancolak/pgcells-single/repositories/users";
import type { Queryable } from "../../core/context";
import type { PreparedQuery } from "../../core/sql/query";

const ID = "0b7e9a52-6a43-4d6e-8f55-2a1f3c0d9e11";
const NOW = new Date("2026-10-05T10:00:00Z");
const row = { id: ID, name: "Ada", email: "ada@example.com", emailVerified: false, image: null, twoFactorEnabled: false, createdAt: NOW, updatedAt: NOW };

/** Fake `Queryable` that records calls; every call returns `rows`. */
function recorder(rows: unknown[] = [row]) {
  const calls: [PreparedQuery, readonly unknown[] | undefined][] = [];
  const db = { query: (async (query, values) => (calls.push([query, values]), rows)) as Queryable["query"] };
  return { calls, db };
}

test("each function runs its own query with positional values", async () => {
  const { calls, db } = recorder();
  expect(await findUserById(db, ID)).toEqual(row);
  expect(await findUserByEmail(db, row.email)).toEqual(row);
  expect(await findUsers(db)).toEqual([row]);
  expect(await findUsers(db, 10, 20)).toEqual([row]);
  expect(await createUser(db, { name: "Ada", email: row.email })).toEqual(row);
  expect(await deleteUser(db, ID)).toBe(true);
  expect(calls).toEqual([[sql.findUserById, [ID]], [sql.findUserByEmail, [row.email]], [sql.findUsers, [50, 0]], [sql.findUsers, [10, 20]], [sql.createUser, ["Ada", row.email]], [sql.deleteUser, [ID]]]);
});

test("not found is null, an empty page is [] and deleting nothing is false", async () => {
  const { db } = recorder([]);
  expect([await findUserById(db, ID), await findUserByEmail(db, row.email), await findUsers(db), await deleteUser(db, ID)]).toEqual([null, null, [], false]);
});
