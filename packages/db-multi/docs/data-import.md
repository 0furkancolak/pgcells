# Data import

There are two ways to move a customer from another application into a tenant: `users import` for users only (JSON Lines, a read-only query on another PostgreSQL, or any iterable from code), and a three-step flow from an SQL backup for all application data (`dump split` → `dump scaffold` → `app-migrate`). Both can be re-run and require a direct (management) connection. The target tenant must be `active` (`TENANT_UNAVAILABLE`).

## User import: `users import`

It writes users to the tenant's `user`-type Better Auth tables (`users`, `account`) and to the `user_imports` mapping.

```sh
# A JSON Lines file (.jsonl or .jsonl.gz)
bun run tools users import abc --source eski-panel --file kullanicilar.jsonl --dry-run
bun run tools users import abc --source eski-panel --file kullanicilar.jsonl

# A read-only query on another PostgreSQL; --from-url takes no value, the URL is asked through hidden input
bun run tools users import abc --source eski-panel --from-url \
  --query 'SELECT id AS "externalId", email, full_name AS name, password_hash AS "passwordHash", created_at AS "createdAt" FROM users'
# Source database URL (postgres://…, what you type is invisible): ********

# In a script (if there is no terminal, the first line is read); do not put the URL on the command line
printf '%s\n' "$ESKI_DB_URL" | bun run tools users import abc --source eski-panel --from-url --query 'SELECT …'
```

```ts
import { importUsers, jsonLinesSource, sqlSource } from "@0furkancolak/pgcells/tools";

await importUsers(management, "abc", jsonLinesSource("kullanicilar.jsonl"), { source: "eski-panel" });
await importUsers(management, "abc", eskiKullanicilar(), { source: "eski-panel", onConflict: "link", report: console.log });
// sqlSource(driver, url, query) — the same as --from-url/--query
```

`management` is a `createManagement` instance ([configuration.md](configuration.md#management-options-createmanagement)).

### Row format (`ImportedUser`)

| Field | Type | Note |
|---|---|---|
| `externalId` | string or number, required | The ID in the source (1–255 characters) |
| `email` | email, required | Lowercased |
| `name` | string \| null | `""` if missing |
| `emailVerified` | boolean | Default `false` |
| `image` | string \| null | |
| `createdAt` | date | |
| `passwordHash` | string \| null | Better Auth scrypt, bcrypt or argon2; if missing, the user signs in with a password reset or a social account |
| `accounts` | `[{ providerId, accountId }]` | Social accounts |

Invalid rows are skipped and reported through `report` with the row number and the names of the bad fields (values are not written).

### Options

| CLI | `importUsers` option | Default | Meaning |
|---|---|---|---|
| `--source name` | `source` | required | The source name (`[a-z0-9][a-z0-9_.-]{0,62}`); part of the mapping key, keep it constant for the same source |
| `--file x.jsonl` | `jsonLinesSource(path)` | | Cannot be given together with `--from-url`/`--query` |
| `--from-url --query SQL` | `sqlSource(driver, url, query)` | | Both together; `--from-url` takes no value, the URL is asked through hidden input (see below) |
| `--on-conflict skip\|link\|fail` | `onConflict` | `skip` | Email conflict |
| `--auth-runtime bun\|workers` | `authRuntime` | `bun` | The runtime that will verify the login |
| `--dry-run` | `dryRun` | | Does not write |
| `--batch-size N` | `batchSize` | 500 (≤ 10000) | Rows per batch |
| | `signal`, `report` | | Cancellation and progress |

Result: `{ read, invalid, created, updated, unchanged, linked, skipped, passwords: { scrypt, bcrypt, argon2, unsupported }, dryRun }`.

### Behavior

- **Re-running is safe.** Thanks to the `user_imports (source, external_id → user_id, checksum)` mapping in the tenant, the same source and external ID do not create a user a second time; if the record changed it updates the user and the password hash, and if it did not it does not touch it. When moving related data (orders, notes …), go from the old ID to the new user through this table.
- **Email conflict** (another user with the same email in the tenant): `skip` skips and reports; `link` adds the mapping and the social accounts to the existing user (its name and password do not change); `fail` rolls back that batch and stops with `IMPORT_CONFLICT`. The same rule applies when the external ID was previously mapped to another user (A) but the new email belongs to B: `skip` and `fail` change nothing; `link` moves the mapping to B and adds the accounts to B, A's email is not updated to B's (no uniqueness violation), and neither user's record changes.
- **Passwords.** The hash is written to the `credential` account as is. Give Better Auth `emailAndPassword.password: importedPasswords` ([auth.md](auth.md#imported-passwords-importedpasswords)). A hash that cannot be verified (`unsupported`; including argon2 for Workers) is not written, it is counted.
- Each batch is a single transaction and a fixed number of bulk statements.
- The SQL source is read in a single snapshot and a read-only transaction, in pages of 500. Because the query runs as is, connect to the source database with a user who has read-only privileges.
- **The source URL is asked for.** `--from-url` only means "ask for the URL", it takes no value: the password does not end up in argv (any user on the machine can read it with `ps`) or in the shell history. What you type appears as `*` in the terminal; Ctrl+C cancels. The prompt is written to stderr and the result to stdout. With non-terminal input the first line is read (`… < url.txt` or `printf '%s\n' "$URL" | …`), so scripts keep working. When called from code, the URL is passed directly to `sqlSource(driver, url, query)`. The `--from-url=URL` and `--from-url URL` forms are rejected with `USAGE`.

## Downloading a backup from a remote database (`dump fetch`)

It downloads a plain-text backup of a remote PostgreSQL such as staging into a local `.sql.gz` file. pg_dump is not needed on the host; Docker is enough. The server's major version is read and the pg_dump in the `postgres:<version>-alpine` image of the same version is run. The database is only read, and with `--no-owner --no-privileges` role/privilege lines are not written.

```sh
bun run tools dump fetch ./staging.sql.gz                       # the whole database
bun run tools dump fetch ./staging-panel.sql.gz --schema panel   # only the given schemas (repeatable)
# Source database URL (postgres://…, what you type is invisible): ********
# {"file":"./staging.sql.gz","bytes":1234567,"image":"postgres:16-alpine","serverVersion":16,"schemas":"all","seconds":8.4}
```

- **The URL is asked for.** There is no command-line option or environment variable that carries the URL: the URL does not end up in the shell history, the `ps` output or the shell environment. What you type appears as `*` in the terminal; Ctrl+C cancels. The prompt is written to stderr, and stdout is only the JSON result. With non-terminal input the first line is read (`… < url.txt`). Preferably enter the URL of a read-only user.
- The file name, the `<file>.partial` conflict and `--schema` are checked before the prompt is asked and before connecting to the database.
- Writing goes to `<file>.partial`; when pg_dump finishes successfully, the target file is created **atomically, only if it does not exist** (`link`). It does not overwrite an existing file (`USAGE`) — even if it appeared after the check: in that case the target is not touched and the downloaded data stays in the `.partial` file, whose path is in the error message.
- An existing `.partial` (another download that was left half-done or is still running) is rejected with `USAGE` and is **not deleted**; the operator decides what to do. Only the partial file created by this run is cleaned up on error or cancellation.
- SIGINT/SIGTERM: both while the prompt is open and during the download it exits cleanly with `USAGE`, the terminal leaves raw mode, and this run's partial file is deleted.
- A connection (version reading) or pg_dump error is `DUMP_FETCH_FAILED`; the password in the message is hidden (also a password containing a percent escape that cannot be decoded: `local%admin_password`).
- A `localhost`/`127.0.0.1` source: on Linux the container uses the host network, on Docker Desktop it connects to `host.docker.internal`. Make sure Docker can reach a host behind a VPN.
- The output is read with `dump split`, `app-migrate` and `gunzip -c staging.sql.gz | psql <local-url>`. The repository ignores `*.sql.gz` files; they may contain real user data, do not share them, and delete them when the work is done.

## Migrating from another application (`backup.sql`)

The SQL backup of an old, similar application is transferred to a tenant in three steps: the backup is split, a migration code skeleton is produced from the pieces, and the mappings are filled in and run. Plain-text pg_dump (COPY or `--inserts`) and mysqldump are read; `.gz` also works.

```sh
bun run tools dump split backup.sql ./legacy-work
# {"dir":"./legacy-work","dialect":"postgres","tables":{"members":{"rows":2,"columns":4},…}}
# written: tables/<table>.jsonl.gz + analysis.json (column, type, row and null counts; no sample values)

bun run tools dump scaffold ./legacy-work --name legacy2app --source legacy
# {"file":"src/app-migrations/legacy2app.ts"} — rejects with USAGE if the file exists; another path with --out

bun run tools app-migrate abc ./legacy-work --file src/app-migrations/legacy2app.ts --dry-run
bun run tools app-migrate abc ./legacy-work --file src/app-migrations/legacy2app.ts
# {"tenantId":"abc","source":"legacy","dryRun":false,"steps":[{"table":"members","read":2,"skipped":1,"written":1},…]}
```

The input of `app-migrate` can be the pieces folder or directly `backup.sql`/`.sql.gz` (it is split into a temporary folder, then deleted). `--file` is resolved relative to the working folder and the module must export `defineAppMigration(...)` as the default (`USAGE`). Extra options: `--auth-runtime bun|workers`, `--batch-size N` (default 500).

### `defineAppMigration`

The skeleton produces the row types (`Rows`); you write the mappings. `notes` and `note_tags` in the example are tables added with the application's own migrations; the package's tenant migrations set up only the auth tables and `user_imports`.

```ts
// src/app-migrations/legacy.ts
import { defineAppMigration } from "@0furkancolak/pgcells/tools";

type Rows = {
  members: { id: number; email: string | null; full_name: string | null; password: string | null };
  notlar: { id: number; uye_id: number; metin: string };
  not_etiketleri: { not_id: number; etiket: string };
};

export default defineAppMigration<Rows>({
  source: "legacy",
  steps: [
    { table: "members", users: (row) => (row.email ? { externalId: row.id, email: row.email, name: row.full_name, passwordHash: row.password } : null) },
    { table: "notlar", into: "notes", map: (row, ctx) => ({ id: ctx.uuid("notlar", row.id), user_id: ctx.userId(row.uye_id), body: row.metin }) },
    { table: "not_etiketleri", into: "note_tags", map: (row, ctx) => ({ note_id: ctx.uuid("notlar", row.not_id), tag: row.etiket }) },
  ],
});
```

Running from code:

```ts
import legacy from "./app-migrations/legacy";

await legacy(management, "abc", "./backup.sql", { dryRun: true });   // the pieces folder or directly .sql
```

Options: `dryRun`, `batchSize`, `authRuntime`, `signal`, `report`. To do the splitting from code, `splitSqlDump(path, outDir)` (`@0furkancolak/pgcells/tools`) can be used; skeleton generation (`dump scaffold`) is only in the CLI. The `ctx` type is exported as `AppMigrationContext`.

### Steps

- They run **in order**; order the tables by foreign key.
- A `users` step uses `importUsers` (mapping, email conflict, bcrypt/argon2 passwords); `onConflict` can be given to the step. A row that returns `null` is skipped.
- An `into` + `map` step writes to a tenant table. If `map` returns `null` the row is skipped; to produce several rows from one row, return an array.
- `ctx.uuid(table, oldId)` produces the same UUID every time from source + table + old ID; relations (e.g. `note_id`) are found with the same call and the writes are `ON CONFLICT DO NOTHING`. That is why **re-running is safe**.
- `ctx.userId(oldId)`: the new user ID of an old user ID imported in the `users` step (`null` if none).
- `ctx.tenantId` and `ctx.source` exist too.

### Caveats

- **Errors come early:** a table that is not in the dump, or a target table or column that is not in the tenant, is `IMPORT_INVALID`; a broken dump is `DUMP_INVALID`; a foreign key violation rolls back that batch with the PostgreSQL code (`23503`). Use `--dry-run` first.
- The parser reads only table definitions and data (functions, triggers, indexes are skipped); memory use is bounded by row size, and a single gzip stream stays open.
- The pieces folder is **customer data**; delete it after the work.
