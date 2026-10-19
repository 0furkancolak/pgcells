# Managed Postgres providers (Neon, Supabase, RDS, Hyperdrive)

Which connection type to use for which job. Provider behavior is not assumed, it is measured.

> **Nothing on this page has been verified against a real Neon, Supabase or RDS account (every row is based on documentation).** The provider tools (`neon stage-copy`, `neon export`, `migrate --safety-point`) were tested only against a **fake Neon API** (a local imitation of the HTTP endpoints they call) and a local PostgreSQL; the Supabase safety point makes no API call at all. The Neon *driver* is tested through a local WebSocket proxy: that tests the driver, not the Neon service. Running the tools and `verify:provider` on your own account is the first real measurement.

The basic rule ([configuration.md](configuration.md#direct-and-pooler-url)): the **application** connects to a transaction-mode pooler, and **management** connects directly or through a session-pooled connection.

## URL type → role

| Provider | URL type | Use |
|---|---|---|
| Neon | direct (`ep-…`, no `-pooler`) | management |
| Neon | `-pooler` (PgBouncer, transaction) | application; `neonDriver` in Workers/edge |
| Supabase | direct `db.<ref>.supabase.co:5432` (IPv6 only; the IPv4 add-on is paid) | management (if you have an IPv6 network) |
| Supabase | Supavisor session `…pooler.supabase.com:5432` (user `postgres.<ref>`) | management (IPv4) |
| Supabase | Supavisor transaction `…pooler.supabase.com:6543` | application |
| Supabase | dedicated PgBouncer `db.<ref>.supabase.co:6543` (paid plan) | application |
| RDS | instance endpoint | management |
| RDS | with a transaction-mode pooler in front (PgBouncer, or RDS Proxy set to transaction pooling) | application |
| Hyperdrive | Workers binding | application; the probe can give a false negative, `pooler: "assumed"` is recommended |

`migrate` writes `ALTER DATABASE … SET`: on every provider, run it with the role that owns the DB ([operations.md](operations.md#what-migrate-writes-to-the-database)).

## `verify:provider`

```bash
DATABASE_URLS='<management URL>' bun run verify:provider [--driver bun|postgres|pg|neon] [--replica]
```

Measures the pooler probe, `migrate`’s `ALTER DATABASE` job, privileges and server behavior after a deadline; the fields are in the JSON output and in `src/__tests__/provider/measure.ts`. The application URL (and, with `--replica`, the replica URL) is asked through hidden input; the output contains no URL, host, user or password. **Run it only on free/disposable test DBs:** it temporarily changes the DB default `statement_timeout` and writes it back; if it cannot be written back, `alterDatabase.restoreSql` gives the command to run by hand. `doctor --pooled-url` measures the connection checks; use the two together.

| Measurement | Action |
|---|---|
| The probe is `false` on a real pooler | A false negative: `pooler: "assumed"` for that provider |
| `ALTER DATABASE … SET` is rejected | The role’s privilege must be fixed at the provider; otherwise the runtime timeouts cannot be set |
| The Supabase direct URL cannot connect because of IPv6 | `DATABASE_UNAVAILABLE`; for management, the session pooler (`:5432`) |
| The backend continues after a deadline behind the pooler | The statement can run until the server’s `statement_timeout`; keep the runtime `statement_timeout` low |

## Provider tools

The Neon tools call the Neon API with `fetch`. The API key is asked through **hidden input** (it never enters argv/the environment) and never appears in any output or error message. The project is found by matching the `DATABASE_URLS` host (the `-pooler` suffix is ignored) with the endpoints in the key’s account (`PROVIDER_NODE_NOT_FOUND`); on an organization account pass `--org <id>` (only with neon, otherwise `USAGE`). **The tools never delete a branch** (deletion cannot be undone): delete the branches they create yourself from the Neon console. The free plan’s branch count and history window are limited; if a limit is exceeded, Neon’s message appears as `PROVIDER_API_ERROR`. Every API request is limited to 30 s and cancelled with Ctrl-C; waiting for a branch operation is limited to 120 s. If a branch was created before an error, the error names it (name, project, branch id) and says it was not deleted.

| Command | What it does |
|---|---|
| `migrate --safety-point neon` | Before `migrate`, creates a `pre-migrate-<UTC time>` branch from the source branch’s current point. **If it cannot be created, `migrate` does not run at all.** A `--dry-run` and a run with no pending migrations take no point |
| `migrate --safety-point supabase` | Makes no API call and asks for no key: records the UTC second (`recoveryTimeTargetUnix`) and prints the `restore-pitr` request |
| `neon stage-copy` | Creates a `stage-<time>` branch from the source branch to rehearse a migration; only the branch id and host are printed, not the URI with the password (get the password from the console) |
| `neon export <dir> --at TIME` | Creates a `pitr-<time>` branch at the `--at` moment, sets up a temporary management context with it and runs `export`; nothing is written to live data |

- **`--safety-point neon` creates a branch on every `migrate` that has pending migrations and never deletes it** (it creates none when nothing is pending). Branches count against the plan quota; clean them up from the console.
- **A `POST /branches` that exceeds 30 s can leave a branch behind.** Neon may still create the branch after the client gives up; because the tool never saw the response, the error only says the request timed out and does not name the branch. Look in the Neon console for a `pre-migrate-`, `stage-` or `pitr-` branch with a matching time, and delete it if the work did not continue.

### Going back to a past moment

```bash
bun run cli neon export ./at-0930 --at 2026-10-03T09:30:00Z   # --at: RFC 3339 with a UTC offset and in the past; a time without an offset is rejected
bun run cli restore ./at-0930 --schema restored               # the target schema must not exist or must be empty
```

`--at` and the target directory are checked before the API key is asked: an existing `<dir>` or `<dir>.partial` gives `BACKUP_EXISTS` without any branch being created (since branches are not deleted, repeats would pile up). `restore` does not write over existing objects (`SCHEMA_NOT_EMPTY`); to compare or copy rows back, load under another schema name. Output `{ dir, tables, rows, at, branch, note }`; the temporary branch stays.

### Supabase

The Supabase safety point only records a time and **depends on a paid add-on**: PITR can be enabled only on the Pro, Team and Enterprise plans; a time recorded on the free plan or without the add-on is not a rollback point (there, take your own dump before `migrate`). PITR (`POST https://api.supabase.com/v1/projects/{ref}/database/backups/restore-pitr`, body `{"recovery_time_target_unix": <seconds>}`) restores **the whole project in place and with downtime**; restoring a single schema is not possible.

## Limits

The Neon HTTP `neon()` function is not supported (it offers no interactive session and no dedicated connection).
