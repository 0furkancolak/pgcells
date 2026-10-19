import type { Queryable } from "../../core/context";
import { findUsers as findUsersQuery } from "../../queries/users.gen";
import type { UserRow } from "../../tables/users.gen";

export function findUsers(db: Pick<Queryable, "query">, limit = 50, offset = 0) {
  return db.query<UserRow[]>(findUsersQuery, [limit, offset]);
}
