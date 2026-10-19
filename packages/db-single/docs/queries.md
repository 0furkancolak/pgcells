# Queries

Application SQL is written in files, compiled with `bun run db:codegen` and imported from the generated modules. No SQL is parsed at runtime; the schema from `createDb` is added to table names, and values always go as separate parameters. The full grammar of the supported SQL, the rejected constructs and the output-name rules are in [`src/core/sql/README.md`](../src/core/sql/README.md); this document covers everyday use.

## Writing queries

Queries live in `src/queries/<area>.sql` files (a flat folder; all of them run against a single schema). A file contains one or more named blocks; `bun run db:codegen` produces one module per file (`users.sql` → `users.gen.ts`, import: `@0furkancolak/pgcells-single/queries/users`):

```sql
-- name: findUserByEmail
SELECT * FROM users WHERE email = $1::text
```

- The name must be unique across the package and camelCase (`^[a-z][A-Za-z0-9]*$`), and becomes the exported name.
- Write table names without a schema. Parameters are `$1`, `$2`…; if the type is ambiguous, use a cast (`$1::uuid`). For JSON, `$1::text::jsonb`; send JSON instead of an array.
- Never take the schema, a table name or a SQL fragment from the client; input validation (zod etc.) is the application’s job.
- Unsupported SQL is rejected in codegen with `SQL_UNSUPPORTED`; it is not left to runtime.
- **Result keys are camelCase** while columns stay snake_case (`created_at` → `createdAt`); the mapping is written into the SQL at compile time, with no runtime cost. Quote an alias name you want to keep as is (`AS "full_name"`).
- **`SELECT *` and `RETURNING *`** expand at compile time, if at least one of the columns is renamed, to an explicit column list derived from the migrations; when a migration adds a column, `codegen` updates the expansion. A source whose columns are unknown (a table not in the migrations, an unknown CTE) gives `SQL_UNSUPPORTED`.
- For `ORDER BY`, write a table-qualified column (`ORDER BY users.id`); sorting by the alias `id::text AS id` cannot use the primary key index.

## `bun run db:codegen`

```sh
bun run db:codegen          # one module per SQL file; a .gen.ts whose SQL was deleted is removed
bun run db:codegen --check  # rejects missing, stale, orphaned or hand-edited output (CI)
```

`db:codegen` is the same command; no DB is needed. It also produces the migration/seed lists and the zod table types. Do not edit generated files by hand; commit them with their SQL. A `readOnly` flag derived from the SQL is written onto every query: lock-free `SELECT`/`VALUES`/`UNION` and read-only CTEs are `readOnly`; writes and `FOR UPDATE/SHARE` are not; the replica read context runs only `readOnly` queries ([replicas.md](replicas.md)).

## Running queries

```ts
import { findUsers } from "@0furkancolak/pgcells-single/queries/users";

const users = await db.query<User[]>(findUsers, [20, 0]);       // primary, a single round trip
const rows = await db.read.query<User[]>(findUsers, [20, 0]);   // replica (readOnly queries only)
```

- `db.query(query, values?)` runs on the primary; only queries compiled by the package are accepted (anything else is `INVALID_QUERY`).
- `db.read.query` runs on a replica; if there is no healthy replica, the `replicaOnUnavailable` policy applies; a writing query becomes `QUERY_NOT_READ_ONLY` without going to the DB. There are no transactions on a replica ([replicas.md](replicas.md)).
- In a request scope (`dbMiddleware`, `createDbScope`) the same calls are on `c.get("db")`, and after a write `read.query` stays on the primary ([middleware-and-jobs.md](middleware-and-jobs.md)).

### Transaction

```ts
import { createUser } from "@0furkancolak/pgcells-single/queries/users";

await db.transaction(async (tx) => {
  await tx.query(createUser, ["Ada", "ada@example.com"]);
  await tx.query(createUser, ["Bob", "bob@example.com"]); // both commit together; on an error both are rolled back
});
```

A query that takes a row lock such as `FOR UPDATE` runs only inside a transaction (`TRANSACTION_REQUIRED`); transactions do not nest (`NESTED_TRANSACTION`); an error caught inside still fails the transaction; `tx` cannot be used outside `work` (`TRANSACTION_CLOSED`). Do not open a transaction for a single query.

## The queries and repositories layers

- **`src/queries/`** is where SQL lives: the `.sql` file + the generated `.gen.ts`. Queries go to the DB with a parameter array; the caller has to know the order and the types.
- **`src/repositories/<area>/`** is a thin, typed wrapper around a generated query: **one function per query, one file**, with an `index.ts` barrel. It has no SQL, validation, page limit or business rule of its own. The first argument is `Pick<Queryable, "query">`: `db`, the `tx` inside `db.transaction`, or `db.read` for a replica read. A row that is not found returns `null`, `deleteUser` returns a `boolean`; rows come back typed and are not validated at runtime. Validate input at the application’s edge with zod (such as `userInsert` in `@0furkancolak/pgcells-single/tables/users`).

The `users` pair that ships with the package: `findUserById(db, id)`, `findUserByEmail(db, email)`, `findUsers(db, limit = 50, offset = 0)`, `createUser(db, { name, email })`, `deleteUser(db, id)`. `limit`/`offset` go straight to PostgreSQL (a negative value becomes a `DriverError`).

```ts
import { createUser, findUserByEmail } from "@0furkancolak/pgcells-single/repositories/users"; // same names as the queries: alias the query when you import it

const ada = await createUser(db, { name: "Ada", email: "ada@example.com" });   // UserRow
await findUserByEmail(db.read, "ada@example.com");                             // UserRow | null (replica)
await db.transaction((tx) => createUser(tx, { name: "Bob", email: "bob@example.com" }));
```

**Adding a pair for a new table:**

1. `bun run db:generate create_notes` → write the table as `--up`/`--down`.
2. `src/queries/notes.sql`: `-- name: findNotes` / `SELECT * FROM notes WHERE user_id = $1::uuid ...`, `-- name: createNote` / `INSERT ... RETURNING *`.
3. `bun run db:codegen` → `queries/notes.gen.ts` ve `tables/notes.gen.ts` (`noteRow`, `noteInsert`).
4. Under `src/repositories/notes/`, copy `src/repositories/users/find-user-by-id.ts` and change the query and the `NoteRow` type (`db.query<NoteRow[]>`), then add `export * from "./find-notes";` to `index.ts`. Because the `./repositories/*` export points at `src/repositories/*/index.ts`, `@0furkancolak/pgcells-single/repositories/notes` works automatically.

## Compiling in code: `prepareQuery`

For a one-off query that is not in a generated file (a test, a CLI tool), `prepareQuery(source)` from `@0furkancolak/pgcells-single/management` compiles the same way as codegen (output names are camelCase, `*` is expanded from the package’s migration tables). Because it loads the SQL parser, prefer generated queries in the runtime bundle. `PreparedQuery = { bind(schema), readOnly, requiresTransaction }`; `bind` applies the validated schema, and values stay as `$n`.

## Table types (zod)

`bun run db:codegen` folds the `--up` sections of the migrations without a DB and writes `src/tables/<table>.gen.ts`: `userRow`, `userInsert`, `userColumns` (camelCase key → SQL column name) and the `UserRow`/`UserInsert` types (the names are the singular camelCase form of the table, and the keys are the same as in query results). DDL that cannot be folded stops codegen; nothing is guessed. For the supported SQL types and the rejected ones (`citext`, `inet`/range arrays …), see [`src/core/sql/README.md`](../src/core/sql/README.md).

## Common mistakes

- **`QUERY_NOT_READ_ONLY`** — a writing query was run with `db.read.query` (or with a repository function that was given `db.read`); use `db.query`/`db`.
- **`TRANSACTION_CLOSED`** — `tx` leaked out of `work`.
- **Import not found** — the `.sql` changed and `bun run db:codegen` was not run.
