# Queries

Application SQL is written in files, compiled with `bun run codegen`, and imported from the generated modules. SQL is not parsed at runtime; the context's schema is added to table names and values always travel as separate parameters. This document covers the query file format, the three scopes (tenant, node, platform), how and in which context queries run, transactions, and the generated zod table types.

## Scopes

The scope is the folder, and it determines which schema the query is bound to:

| Folder | Schema | Context it runs in | Import |
|---|---|---|---|
| `src/queries/tenant/<area>.sql` | the tenant's schema (`tenant_abc`) | `withTenant`, `c.get("db").tenant` | `@0furkancolak/pgcells/queries/tenant/<area>` |
| `src/queries/node/<area>.sql` | a database's `platform` schema | `withNode(databaseId)`, `c.get("db").node` (the tenant's database) | `@0furkancolak/pgcells/queries/node/<area>` |
| `src/queries/platform/<area>.sql` | db0's `platform` schema | `withPlatform`, `c.get("db").platform` | `@0furkancolak/pgcells/queries/platform/<area>` |

If a query of one scope is run in the context of another scope, `QUERY_SCOPE`. There is no root `db.query`: which database to go to is written on every call.

## Writing queries

A SQL file contains one or more named blocks:

```sql
-- src/queries/tenant/users.sql (the phone column comes from the migration in getting-started.md step 4)
-- name: listUsers
SELECT id::text AS id, name, email, phone FROM users ORDER BY users.created_at DESC LIMIT $1 OFFSET $2

-- name: setUserPhone
UPDATE users SET phone = $2, updated_at = now() WHERE id = $1::uuid RETURNING id::text AS id, phone
```

- The name must be unique across the package and a camelCase verb + noun (`^[a-z][A-Za-z0-9]*$`): `listUsers`, `createPasswordUser`, `getNodeIdentity`.
- Write table names without a schema; the schema is added at compile time.
- Parameters are `$1`, `$2` …; with a type cast if needed (`$1::uuid`). Use `$1::text::jsonb` for JSON, and use JSON instead of arrays.
- Do not take a schema name, table name or SQL fragment from the client. Input validation (zod etc.) is the application's job.
- Unsupported SQL is rejected in codegen with `SQL_UNSUPPORTED`; it does not survive until runtime.

## Functions that return JSON, arrays, regex and tables

Operators: `->`, `->>` (the key must be **constant** text or a number), `#>>`, `@>`, `<@`, `?`, `?|`, `?&`, `~`, `~*`, `!~`, `!~*`. Functions: `unnest`, `generate_series`, `jsonb_set`, `jsonb_each`, `jsonb_each_text`, `jsonb_array_elements`, `jsonb_array_elements_text`, `jsonb_extract_path`, `jsonb_extract_path_text`, `concat`, `replace`, `btrim`, `ltrim`, `rtrim`, `trim` (single-argument; written as `btrim`), `regexp_replace`, `regexp_match`, `regexp_matches`, `array_length`. All are pure (side-effect free), so `SELECT`s containing these constructs stay `readOnly` and run in a replica read context.

```sql
-- name: listByStatus
SELECT id::text AS id, data->>'status' AS status, data#>>'{customer,name}' AS customer_name
FROM orders WHERE data @> $1::text::jsonb ORDER BY orders.id

-- name: listItems
SELECT orders.id::text AS id, item.elem AS item
FROM orders CROSS JOIN LATERAL jsonb_array_elements(orders.data->'items') AS item(elem)
```

- **Dynamic key:** `data->>$1` cannot be written; use `jsonb_extract_path_text(data, $1)`.
- **`#>` cannot be parsed** (a parser limit); `jsonb_extract_path(data, 'a', 'b')` gives the same result as jsonb. `#>>` is supported.
- **A function in `FROM`** requires an alias. `SELECT *` expands only if a column list is given (`AS item(elem)`); otherwise write the columns explicitly.
- **`trim(both … from …)`** cannot be parsed; use `btrim(x, 'chars')`.
- `?` is not a placeholder; parameters are always `$n`.

## Query constructs: recursion, set operations, frames, grouping sets

```sql
-- name: subtree
WITH RECURSIVE tree AS (
  SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = $1::integer
  UNION ALL
  SELECT n.id, n.parent_id, t.depth + 1 FROM nodes n JOIN tree t ON n.parent_id = t.id
)
SELECT id, depth FROM tree ORDER BY depth, id

-- name: movingTotal
SELECT id, sum(amount) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)::integer AS moving FROM sales ORDER BY id
```

- **`INTERSECT` / `EXCEPT`** (including `ALL`): each branch is compiled separately; the output names come from the left branch.
- **`IS [NOT] DISTINCT FROM`**: a comparison that treats `NULL` as equal.
- **Window frame:** `ROWS`/`RANGE`/`GROUPS` + `UNBOUNDED PRECEDING|FOLLOWING`, `CURRENT ROW` or an integer constant + `PRECEDING|FOLLOWING`, at the end of the `OVER (…)` parentheses. `EXCLUDE`, `$n` and expression offsets are not supported.
- **`ROLLUP`, `CUBE`, `GROUPING SETS`** only as a direct `GROUP BY` element; the empty set `()` and nested `ROLLUP` are not supported. `grouping(column)` is used in the select list and in `HAVING`.
- **`WITH RECURSIVE`** has no additional limit: uncontrolled recursion is stopped by the server's `statement_timeout` (default 5 s, written to the database by `bootstrap`) and the client sees `DATABASE_TIMEOUT`. Make sure the recursion will terminate (for example `WHERE depth < N`).

## Result names: snake_case column, camelCase key

Columns stay snake_case in the database (`first_name`, `created_at`); the keys of result rows are camelCase (`firstName`, `createdAt`). The mapping is written into the SQL itself at compile time: the outermost output columns get aliases and PostgreSQL returns the rows directly with camelCase names.

```sql
-- name: listUserNames
SELECT u.id, u.email_verified, name AS display_name, created_at::text, count(*) OVER () FROM users u ORDER BY display_name
```

```sql
-- generated SQL (with the schema added)
SELECT u.id, u.email_verified AS "emailVerified", name AS "displayName", created_at::"pg_catalog"."text" AS "createdAt",
  "pg_catalog"."count"(*) OVER () FROM "tenant_abc".users u ORDER BY "displayName"
```

Row: `{ id, emailVerified, displayName, createdAt, count }`.

- **No runtime cost.** There is no per-row key conversion, loop or driver transformation (e.g. postgres.js `transform: camel`); the name is the column name PostgreSQL returns. Bun SQL, postgres.js and pg see the same keys.
- **Only the outermost output:** the top-level `SELECT` (the last statement after WITH; in a `UNION`, the first branch that supplies the names) or the `RETURNING` list of a top-level `INSERT`/`UPDATE`/`DELETE`. CTE bodies, subqueries, the `INSERT ... SELECT` projection, `ON CONFLICT` and `excluded.column` do not change; the outer SQL keeps referring to them by their SQL names. Parameters are positional and need no mapping.
- **A column without an alias** (qualified or not, also inside parentheses/a type cast) gets an alias if its name changes. Names that are a single word or already camelCase stay as they are.
- **An unquoted alias** is lowercased like PostgreSQL does, then camelCased and written quoted: `AS full_name` → `AS "fullName"`. `AS fullName` is `fullname` in PostgreSQL and stays that way.
- **A quoted alias stays as is — the escape hatch.** If you want to choose the name exactly, quote it: `AS "full_name"`, `AS "userID"`.
- **Other expressions** keep PostgreSQL's default name (`count(*)` → `count`, `date_trunc(…)` → `date_trunc`); give an alias if you want a name.
- **The same name twice** (e.g. `first_name` and `"firstName"`, or `s.id` and `c.id`) gives `SQL_UNSUPPORTED`: one of them would silently be lost in the object row.
- **`ORDER BY` / `DISTINCT ON`** resolves a bare name to the output name first; a reference to a renamed output is written with the new name. **`GROUP BY`** resolves a bare name to the input column first; a `GROUP BY` reference to a renamed alias is rejected: write the expression or the position (`GROUP BY 1`), or quote the alias.

### The `*` rule

`*` and `t.*` expand to an explicit column list at compile time, but only if at least one column's name changes. If no name changes, `*` stays as written.

```sql
SELECT * FROM verification
-- → SELECT "verification"."id", "verification"."identifier", "verification"."value", "verification"."expires_at" AS "expiresAt",
--   "verification"."created_at" AS "createdAt", "verification"."updated_at" AS "updatedAt" FROM "tenant_abc".verification
```

The columns come from the migrations in the query's scope (the same folding that produces the table types), from a CTE with an explicit projection, or from a subquery. A source whose columns are unknown (e.g. `WITH x AS (SELECT 1) SELECT * FROM x`), a table not in the migrations, or an unqualified `*` in a `USING` join is rejected with `SQL_UNSUPPORTED`: write the columns explicitly. If a migration adds a new column, `bun run codegen` updates the expansion; `codegen --check` catches stale output.

## Codegen

Codegen also writes a `readOnly` flag for each query: lock-free `SELECT`/`VALUES`/`UNION` and CTEs that only read are `readOnly`; writes and `FOR UPDATE/SHARE` are not. The replica read context runs only these ([replicas.md](replicas.md)).

```sh
bun run codegen          # one module per SQL file: auth.sql → auth.gen.ts; a .gen.ts whose SQL was deleted is removed
bun run codegen --check  # rejects missing, stale, orphaned or hand-edited output (CI)
```

Do not edit the generated files by hand; commit them together with the SQL. Codegen rejects duplicate or invalid names across files. The same command also generates the migration and seed lists and the zod table types. No database is needed.

## Running in contexts

```ts
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { getNodeIdentity } from "@0furkancolak/pgcells/queries/node/identity";
import { listTenants } from "@0furkancolak/pgcells/queries/platform/tenants";
import { listUsers } from "@0furkancolak/pgcells/queries/tenant/users";

const db = createDatabase({ driver: bunDriver });

type User = { id: string; name: string; email: string; phone: string | null };
const users = await db.withTenant("abc", (tenant) => tenant.query<User[]>(listUsers, [20, 0]));
const identity = await db.withNode("db1", (node) => node.query(getNodeIdentity));
const tenants = await db.withPlatform((platform) => platform.query(listTenants, [100, 0]));
```

- `db.withTenant(id, work)`: reads the placement from the in-process cache (`active` only, `placementCacheMs`) or the platform database. `TENANT_NOT_FOUND` if the tenant does not exist, `TENANT_UNAVAILABLE` if it is not `active`.
- `db.withTenant.forPlacement(placement, work)`: if you have already read the placement (e.g. from Redis), skips the second read.
- `db.withTenantRead(id, work)`: only `readOnly` queries, from a replica; see [replicas.md](replicas.md). A writing query gives `QUERY_NOT_READ_ONLY`.
- `db.withNode(databaseId, work)`: that database's pool (the same pool as the tenants'), the `platform` schema.
- `db.withPlatform(work)`: db0's pool, the `platform` schema.
- Inside the middleware the same contexts are ready as `c.get("db").tenant`, `.node`, `.platform` and can be used together with `Promise.all` ([middleware-and-jobs.md](middleware-and-jobs.md)).

The context (`TenantContext`) is valid only for the duration of `work`: used after `work` returns, `TRANSACTION_CLOSED`. Queries that were not awaited before `work` returns are awaited as well; if one of them fails, the error is thrown instead of `work`'s result.

## Transactions

```ts
import { createPasswordUser } from "@0furkancolak/pgcells/queries/tenant/auth";
import { setUserPhone } from "@0furkancolak/pgcells/queries/tenant/users";

await db.withTenant("abc", (tenant) =>
  tenant.transaction(async (tx) => {
    const [created] = await tx.query<{ userId: string }[]>(createPasswordUser, ["Ada", "ada@example.com", passwordHash]);
    await tx.query(setUserPhone, [created!.userId, "+905550000000"]);
  }),
);
```

- Do the writes that must commit together inside `transaction`; if `work` throws, `ROLLBACK`.
- Queries that take row locks, such as `FOR UPDATE`, run only inside a transaction; outside one, `TRANSACTION_REQUIRED`.
- There are no nested transactions (`NESTED_TRANSACTION`).
- An error caught inside a transaction still counts the transaction as failed.
- Do not open a transaction for a single query: a single query outside a transaction is one round trip, while a transaction adds `BEGIN … COMMIT`.
- Only queries compiled by the package are accepted; any other object gives `INVALID_QUERY`.

## Compiling in code: `prepareQuery`

For a one-off query that is not in a generated file (a test, a CLI tool, a helper compiled once at process start), `prepareQuery` from the `@0furkancolak/pgcells/management` entry point can be used. It compiles the same way as codegen: output names become camelCase, and `*` is expanded from the package's migration tables. Because it loads the SQL parser, prefer generated queries wherever you do not want to add it to the runtime bundle.

```ts
import { prepareQuery } from "@0furkancolak/pgcells/management";

const countUsers = prepareQuery("SELECT count(*)::int AS n FROM users"); // tenant scope
const [row] = await db.withTenant("abc", (tenant) => tenant.query<{ n: number }[]>(countUsers));
```

## Performance note: `ORDER BY`

```sql
-- slow: sorts by the id::text alias, cannot use the primary key index (full scan + sort)
SELECT id::text AS id, name FROM users ORDER BY id LIMIT $1
-- right: a column qualified with the table
SELECT id::text AS id, name FROM users ORDER BY users.id LIMIT $1
```

## Table types (zod)

`bun run codegen` folds the up migrations without a database (CREATE/ALTER/RENAME/DROP TABLE, adding/dropping/renaming columns, type, NOT NULL, default, enum) and writes one module per scope and table. DDL that cannot be folded (an unknown table/column/type, an unsupported ALTER) stops codegen; nothing is guessed.

```ts
// @0furkancolak/pgcells/tables/tenant/users (abridged)
export const userRow = z.object({ id: z.uuid(), name: z.string(), email: z.string(), emailVerified: z.boolean(), image: z.string().nullable(), … });
export const userInsert = z.object({ id: z.uuid().optional(), name: z.string(), email: z.string(), emailVerified: z.boolean().optional(), … });
export const userColumns = { id: "id", name: "name", email: "email", emailVerified: "email_verified", … } as const;
export type UserRow = z.infer<typeof userRow>;
export type UserInsert = z.infer<typeof userInsert>;
```

```ts
import { userInsert } from "@0furkancolak/pgcells/tables/tenant/users";

const input = userInsert.parse(await request.json());
```

The module name is the table name; the exported names are the singular camelCase form of the table (`users` → `userRow`, `move_targets` → `moveTargetRow`). The schema keys are the same camelCase names as the query results (`userRow` → `{ emailVerified, createdAt, … }`). `<name>Columns` is a constant mapping from the camelCase key to the SQL column name; dynamic SQL or adapters (e.g. Better Auth) take the column name from here: `userColumns.emailVerified === "email_verified"`. If two columns land on the same camelCase key (`first_name` and `"firstName"`), codegen stops with `SQL_UNSUPPORTED`. Type mapping:

| Column | zod |
|---|---|
| uuid | `z.uuid()` |
| text, varchar, bpchar | `z.string()` |
| int2, int4 | integer |
| float4, float8 | `z.number()` |
| int8, numeric | `z.string()` |
| boolean | `z.boolean()` |
| timestamptz, timestamp, date | `z.date()` |
| time, timetz, interval | `z.string()` |
| inet, cidr, macaddr, tsvector, tsquery, int4range, int8range, numrange, tsrange, tstzrange, daterange | `z.string()` (ranges in the `"[1,5)"` form) |
| json, jsonb | `z.unknown()` |
| bytea | `Uint8Array` |
| arrays | `z.array(…)` |
| enum, and `CHECK (col IN (…))` on a text column | `z.enum([...])` |

**The extra types are scalar only.** `inet`, `cidr`, `macaddr`, `tsvector`, `tsquery` and range types come back as strings in all three drivers; their arrays come back in different forms across drivers (postgres.js gives the raw `"{…}"` text), so as an array element (column, cast, `inet[][]`) they give `SQL_UNSUPPORTED`. If you need an array, use `array_agg(ip::text)` or JSON. `serial`/`smallserial`/`bigserial` are accepted only in a `CREATE TABLE`/`ADD COLUMN` column definition, are written as is, and appear in the table as a number with `NOT NULL` + a default (`bigserial` as a string). Operators: `@@` (full text), `&&` (array/range overlap), `<<`, `>>` (network address/range containment); `-|-`, `<<=`, `>>=` cannot be parsed and are therefore not supported. Functions: `to_tsvector`, `to_tsquery`, `plainto_tsquery`, `websearch_to_tsquery`, `ts_rank`. **`citext` is not supported:** it is an extension type, the schema it is installed in varies by provider (mostly `public` on Neon, `extensions` on Supabase), and the compiler cannot know the schema without `search_path`; for case-insensitive comparison use `WHERE lower(email) = lower($1)` and a unique index on `lower(email)`.

A nullable column is `.nullable()`; in the `Insert` schema a nullable or defaulted column is `.optional()`.

## Common errors

- **`QUERY_SCOPE`** — a `src/queries/platform/` query was called with `c.get("db").tenant` (or the reverse). Use the right context, or move the query to the right folder and run `codegen`.
- **`TRANSACTION_REQUIRED`** — a query containing `FOR UPDATE`/`FOR SHARE` outside a transaction.
- **`TRANSACTION_CLOSED`** — the context leaked out of `work` (e.g. `tenant` was returned as the result of `withTenant`, or used in an unawaited callback).
- **Import not found** — the `.sql` changed but `bun run codegen` was not run.
