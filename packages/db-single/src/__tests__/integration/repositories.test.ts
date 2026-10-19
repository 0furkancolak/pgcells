/** User functions on real PostgreSQL: the package's `auth` migration → create/read/page/delete. */
import { expect } from "bun:test";
import { createUser, deleteUser, findUserByEmail, findUserById, findUsers } from "@0furkancolak/pgcells-single/repositories/users";
import { migrations, seeds } from "../../core/migrations/registry";
import { createRunner } from "../../core/migrations/runner";
import { createDb } from "../../core/runtime";
import { createTestManagement, directConfig, driver, dropSchema, integration, q, raw, testSchema } from "./helpers";

const email = () => `user-${crypto.randomUUID()}@example.com`;
const [LAST, FIRST] = ["ffffffff-ffff-ffff-ffff-ffffffffffff", "00000000-0000-0000-0000-000000000000"];

integration("users: create, find, page in created_at, id order, cascade delete", async () => {
  const [admin, schema] = [raw(), testSchema()];
  const m = createTestManagement({ schema });
  const db = createDb(directConfig(), { driver, schema, pooler: "assumed" });
  try {
    await createRunner({ migrations, seeds }).migrate(m);
    const ada = await createUser(db, { name: "Ada", email: email() });
    expect(ada).toMatchObject({ name: "Ada", emailVerified: false, image: null, twoFactorEnabled: false });
    expect(await findUserById(db, ada.id)).toEqual(ada);
    expect(await findUserByEmail(db.read, ada.email)).toEqual(ada);

    // Two rows inserted in one statement with the same `now()`, in reverse id order: only `, id` decides the order.
    await admin.query(`INSERT INTO ${q(schema, "users")} (id, name, email) VALUES ($1, 'B', $2), ($3, 'C', $4)`, [LAST, email(), FIRST, email()]);
    const ids = [ada.id, FIRST, LAST];
    expect((await findUsers(db)).map((u) => u.id)).toEqual(ids);
    expect([(await findUsers(db, 2)).map((u) => u.id), (await findUsers(db, 2, 2)).map((u) => u.id)]).toEqual([ids.slice(0, 2), ids.slice(2)]);

    await admin.query(`INSERT INTO ${q(schema, "session")} (expires_at, token, user_id) VALUES (now() + interval '1 day', $1, $2)`, [crypto.randomUUID(), ada.id]);
    expect([await deleteUser(db, ada.id), await deleteUser(db, ada.id)]).toEqual([true, false]);
    expect(await admin.query(`SELECT 1 FROM ${q(schema, "session")}`)).toEqual([]);
  } finally {
    await db.close();
    await m.close();
    await dropSchema(admin, schema);
    await admin.close();
  }
});
