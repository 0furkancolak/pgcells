import type { Queryable } from "../../core/context";
import { findUserByEmail as findUserByEmailQuery } from "../../queries/users.gen";
import type { UserRow } from "../../tables/users.gen";

export async function findUserByEmail(db: Pick<Queryable, "query">, email: string) {
  const [row] = await db.query<UserRow[]>(findUserByEmailQuery, [email]);
  return row ?? null;
}
