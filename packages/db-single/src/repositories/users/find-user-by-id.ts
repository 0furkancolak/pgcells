import type { Queryable } from "../../core/context";
import { findUserById as findUserByIdQuery } from "../../queries/users.gen";
import type { UserRow } from "../../tables/users.gen";

export async function findUserById(db: Pick<Queryable, "query">, id: string) {
  const [row] = await db.query<UserRow[]>(findUserByIdQuery, [id]);
  return row ?? null;
}
