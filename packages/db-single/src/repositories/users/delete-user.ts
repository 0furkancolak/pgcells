import type { Queryable } from "../../core/context";
import { deleteUser as deleteUserQuery } from "../../queries/users.gen";

export async function deleteUser(db: Pick<Queryable, "query">, id: string) {
  return (await db.query(deleteUserQuery, [id])).length > 0;
}
