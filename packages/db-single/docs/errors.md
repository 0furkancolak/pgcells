# Error codes

The package throws errors as `AppError`: `error.code` is stable, `error.message` is for humans and contains no URL or password. Driver and PostgreSQL errors are also converted to `AppError` (`DriverError`): the code is the SQLSTATE or a connection code, and the message is only `Database operation failed (<code>)`. `errorCode(error)` reduces anything to a single code. Mapping to an HTTP status is the application’s job ([middleware-and-jobs.md](middleware-and-jobs.md#http-status-mapping-example)).

```ts
import { AppError, databaseUnavailable, errorCode } from "@0furkancolak/pgcells-single";

try {
  await createUser(db, { name, email });
} catch (error) {
  errorCode(error);           // AppError → code; PostgreSQL → SQLSTATE ("23505"); connection → "ECONNREFUSED", "CONNECTION_CLOSED" …; unknown → "OPERATION_FAILED"
  databaseUnavailable(error); // SQLSTATE 08xxx, 53xxx, 57P0x or a driver/socket connection error → true
  error instanceof AppError;  // is it the package's own error
}
```

The CLI writes the error to stderr as `{"error": "<code>", "message": "…"}` and exits with code 1; the message of non-`AppError` errors is not written.

## Common PostgreSQL codes

| Code | When | What to do |
|---|---|---|
| `23505` | UNIQUE violation (same email/id) | 409; may count as success on a queue retry |
| `23503` | Foreign key violation | Fix the input or the write order |
| `23502` | NOT NULL violation | Supply the column |
| `42P01` | Table missing (schema dropped, migration missing) | `migrate`; if the schema is lost, [restore](operations.md#restore) |
| `42501` | Permission denied (e.g. `migrate`’s `ALTER DATABASE` with a role that is not the DB owner; `restore` can also fail with it after data has been written) | Run with the owner role ([operations.md](operations.md#what-migrate-writes-to-the-database)) |
| `08P01` | PgBouncer found no server (the DB behind it is down) | 503; reduce to `DATABASE_UNAVAILABLE` with `databaseUnavailable(error)` |
| `57014` | Server statement timeout | The package throws it as `DATABASE_TIMEOUT` |

## Configuration and usage

| Code | When | What to do |
|---|---|---|
| `INVALID_CONFIG` | Invalid `DATABASE_URLS` (empty, multiple, routing the schema through a parameter) or `DATABASE_REPLICA_URLS` (more than 8, duplicated, equal to the primary); an option out of range (including `--steps`/`--keep` in the CLI); wrong `pooler`/`replicaOnUnavailable`; a wrong `dbMiddleware` combination; Better Auth secret < 32 characters, malformed `cookiePrefix`/`basePath`; `auth generate` finds a column of the wrong type or an index that does not match the field; `--from-replica` gets a malformed URL, or a URL that is the primary or not a replica; a malformed PgBouncer console URL | Fix what the message names ([configuration.md](configuration.md)) |
| `USAGE` | A CLI argument missing/extra/repeated/unknown; an option without a value; a name that is not snake_case; `--steps` together with `--to`, or `--steps` greater than the applied count; `pull` with a malformed schema/`--exclude` name; `--safety-point` other than neon/supabase, or `--org` without neon; `--at` missing, without an offset, or not in the past; hidden input cancelled/empty; an `auth generate` module without a default export | See the command’s usage ([cli.md](cli.md)) |
| `INVALID_SCHEMA` | Invalid schema name: uppercase, `pg_*`, `information_schema`, characters outside `a-z0-9_`, longer than 63 bytes | Use a plain lowercase name |
| `INVALID_IDENTIFIER` | An identifier that is empty, longer than 63 bytes or contains NUL | Use a valid PostgreSQL identifier |

## Database and readiness

| Code | When | What to do |
|---|---|---|
| `DATABASE_UNAVAILABLE` | `ready()`: the DB is unreachable (the message adds only the reason code) | Fix the DB/network; 503 |
| `POOLER_REQUIRED` | `ready()`: the URL goes to the DB directly, without a transaction pooler | Point `DATABASE_URLS` at a transaction-mode pooler; in an environment that cannot be probed, `pooler: "assumed"` on purpose; 503 |
| `DIRECT_CONNECTION_REQUIRED` | Management (or the `--from-replica` URL) connected through a transaction pooler | A direct or session-pooled URL ([configuration.md](configuration.md#direct-and-pooler-url)) |
| `DATABASE_CLOSED` | Use after `close()` | Fix the shutdown order |
| `DATABASE_TIMEOUT` | A connection could not be acquired within `statementTimeoutMs`, a statement was not answered within `statementTimeoutMs + 1 s` ([details](configuration.md#timeouts-and-cancellation)), or a server timeout | 504; `poolMax`, slow queries, DB health |
| `DATABASE_BUSY` | The limit (64) on jobs waiting for a connection is full | 503; reduce the load or raise `poolMax` |
| `CONNECTION_CLOSED` | `errorCode` fallback code: the connection closed | Check the log; usually transient |
| `OPERATION_FAILED` | `errorCode` fallback code: an unrecognized error | Check the log |
| `PROVIDER_API_ERROR` | Neon command: the API returned an error, timed out after 30 s, was cancelled, or returned an unusable response; the message carries the status and Neon’s message (never the key). If it happens after a branch was created, the message names it and says it was not deleted | Fix the cause (key, branch limit, history window); delete the branches from the Neon console |
| `PROVIDER_NODE_NOT_FOUND` | Neon command: the `DATABASE_URLS` host matched no endpoint in the key’s account | Verify that the key belongs to the account hosting the DB; in an organization, `--org <id>` |

## Queries

| Code | When | What to do |
|---|---|---|
| `INVALID_QUERY` | An object that is not a compiled query | A generated query or `prepareQuery` |
| `QUERY_NOT_READ_ONLY` | A query that is not `readOnly` in a read context (`read.query`); rejected without going to the DB | Run the write with `db.query` ([replicas.md](replicas.md)) |
| `REPLICA_UNAVAILABLE` | With `replicaOnUnavailable: "error"` there is no healthy replica (down, lag exceeded, or none at all) | Fix the replica or set the policy to `"primary"`; 503 |
| `TRANSACTION_REQUIRED` | A row lock (`FOR UPDATE`) outside a transaction | `db.transaction(async (tx) => …)` |
| `NESTED_TRANSACTION` | `transaction` inside a transaction | Use a single transaction |
| `TRANSACTION_CLOSED` | The context was used after `work` finished | Do not move the context out of `work` |
| `SQL_UNSUPPORTED` | SQL the compiler does not support (codegen or `prepareQuery`) | Simplify the SQL ([queries.md](queries.md)) |
| `UNSUPPORTED` | An unknown operator or an invalid limit/offset in the Better Auth adapter | Change the Better Auth configuration |
| `UNSUPPORTED_PASSWORD_HASH` | Sign-in with an argon2 hash outside Bun | Have the user reset the password, or run on Bun |

## Migrations and seeds

| Code | When | What to do |
|---|---|---|
| `MIGRATION_INVALID` | A malformed file name/section format; a non-DML statement in an SQL seed; ID order/uniqueness; `CONCURRENTLY` not alone in its section | Fix the file ([migrations-and-seeds.md](migrations-and-seeds.md#file-format)) |
| `MIGRATION_DRIFT` | The ledger is not a prefix of the list (changed/unknown/gapped history); a concurrent index has a different definition; the backup was taken with newer code | Roll back the applied file and write a new migration; for restore, use current code |
| `SEED_DRIFT` | An applied seed changed or is unknown | Write a new seed; run `codegen` after a TS seed |
| `MIGRATION_IRREVERSIBLE` | The selection includes a migration with an empty `--down` | It cannot be rolled back; a forward-fixing migration |
| `MIGRATION_NOT_APPLIED` | `--to` is an ID that was not applied | Give an applied ID |
| `MIGRATION_NOT_PENDING` | The baseline ID is not a pending migration | Pick the ID with `migration-status` |
| `SCHEMA_MISMATCH` | Baseline: a folded table/column/enum is missing from the live schema | Make the schema match, then retry |
| `MIGRATIONS_PENDING` | A seed requires up-to-date migrations | Run `migrate` first |
| `MIGRATION_INDEX_INVALID` | A concurrent index is still invalid after being rebuilt | Inspect the index by hand (conflicting data) |
| `MIGRATION_RUNNER_BUSY` | Another migration/seed/baseline/restore is running | Wait for it to finish; the command does not wait |
| `MIGRATION_CANCELLED` | The operation was cancelled (signal) | Run the same command again |
| `LOCK_LOST` | The management session dropped/stopped responding or the lock was lost | Run the same command again |

## Backup, restore and pull

| Code | When | What to do |
|---|---|---|
| `BACKUP_EXISTS` | The target directory or `<target>.partial` exists, or another run is writing | Pick another directory; delete the `.partial` of a killed run ([operations.md](operations.md#leftover-partial-directories)) |
| `BACKUP_NOT_FOUND` | There is no completed set in the root, or `--set` is missing/partial | Check the set list and `backup.json` |
| `BACKUP_INVALID` | The backup has no migration ledger or table file, or the format differs | Inspect the backup |
| `UNSUPPORTED_SCHEMA` | `export`/`backup`: the schema contains something the backup cannot reproduce exactly (a view, a domain/range/composite type, an enum in another schema, a function, an unsupported column type …); every violated rule is reported, and the message names the object where possible (at most 20 names per rule, the rest as “and N more”) | Remove/change the object, or back up with a DB-level tool ([operations.md](operations.md#what-it-covers-what-it-rejects)) |
| `SCHEMA_NOT_EMPTY` | `restore`: the target schema has objects; nothing was deleted | Restore under another name with `--schema`, or drop the old one yourself |
| `RESTORE_MISMATCH` | The number of restored rows differs from the backup’s | The transaction was rolled back; inspect the backup and retry |
| `VERSION_MISMATCH` | The PostgreSQL major version of the backup/source and the target differ | Restore on the same major version |
| `COLLATION_MISMATCH` | The encoding, locale or collation version differs | Create the target DB with the same encoding/locale |
| `EXTENSION_MISMATCH` | An extension in the backup is missing on the target or its version differs | Install the same extensions first |
| `COPY_FAILED` | The sequence state or server information could not be read | Check access and retry |
| `REPLICA_CONFLICT` | `--from-replica`: the replica cancelled the long snapshot (recovery conflict) | Retry, or take it from the primary ([replicas.md](replicas.md)) |
| `REPLICA_LAG_EXCEEDED` | `--from-replica`: lag exceeded the threshold at the start/is unknown, or the replica could not catch up to the primary’s position in time | Retry once it has caught up. The CLI cannot change the threshold (5000 ms); in code, `createManagement({ replicaMaxLagMs })` |
| `PULL_UNSUPPORTED` | `pull`: the schema contains an object the initial migration cannot express; all of them are listed in the message | Remove the object, write it by hand after the pull, or use `--exclude` ([migrations-and-seeds.md](migrations-and-seeds.md#initial-migration-from-an-existing-database-pull)) |
| `SOURCE_SCHEMA_MISSING` | `pull`: the source schema does not exist | Check the name |
