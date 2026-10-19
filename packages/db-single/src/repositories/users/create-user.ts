import type { Queryable } from "../../core/context";
import { createUser as createUserQuery } from "../../queries/users.gen";
import type { UserRow } from "../../tables/users.gen";

export async function createUser(db: Pick<Queryable, "query">, { name, email }: { name: string; email: string }) {
  const [row] = await db.query<UserRow[]>(createUserQuery, [name, email]);
  return row as UserRow;
}
