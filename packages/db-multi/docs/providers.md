# Managed Postgres providers (Neon, Supabase, Hyperdrive)

This document says which connection type to use for which job and the **verification status** of each row. Provider behavior is not assumed but measured: `documented, not verified` rows rest on the provider's documentation and have not yet been measured with a real account. Measured ones are marked `verified (date, driver)`.

The basic rule ([configuration.md](configuration.md)): the **runtime** connects to a transaction-mode pooler, and **management** (CLI, `bootstrap`, `migrate-all`, session advisory locks) requires a direct or session-pooled connection.

## URL type → role

| Provider | URL type | Use | Status |
|---|---|---|---|
| Neon | direct (`ep-…`, no `-pooler`) | management | documented, not verified |
| Neon | `-pooler` (PgBouncer, transaction) | runtime; `neonDriver` on Workers/edge ([configuration.md](configuration.md#neon-serverless-driver)) | documented, not verified |
| Supabase | direct `db.<ref>.supabase.co:5432` (IPv6 only; the IPv4 add-on is paid) | management (if there is an IPv6 network) | documented, not verified |
| Supabase | Supavisor session `…pooler.supabase.com:5432` (user `postgres.<ref>`) | management (IPv4) | documented, not verified |
| Supabase | Supavisor transaction `…pooler.supabase.com:6543` | runtime | documented, not verified |
| Supabase | dedicated PgBouncer `db.<ref>.supabase.co:6543` (paid plan) | runtime | documented, not verified |
| Hyperdrive | Workers binding | runtime; the check can give a false negative, `pooler: "assumed"` is recommended | documented, not verified |

## PgBouncer versions

The transaction-pooling path (`ready()` probe, deadlines, tenant queries, transactions, the database-level `statement_timeout`) is exercised in CI against a matrix of PgBouncer releases, each with `max_prepared_statements` 0 and 100, using a `pgbouncer.ini` produced by `pooler generate`:

| PgBouncer | Alpine | `max_prepared_statements` 0 | `max_prepared_statements` 100 |
|---|---|---|---|
| 1.21.0 | 3.19 | verified (2026-10-19, bun) | verified (2026-10-19, bun) |
| 1.23.1 | 3.21 | verified (2026-10-19, bun) | verified (2026-10-19, bun) |
| 1.24.0 | 3.22 | verified (2026-10-19, bun) | verified (2026-10-19, bun) |

No behavioural difference between these versions showed up in these checks. Older releases, PgCat and PgDog are not tested. Managed poolers (Supavisor, Neon, RDS Proxy, Hyperdrive) stay `documented, not verified` until `verify:provider` has run against a real account.

## Online move (logical replication)

`move --online` ([operations.md](operations.md#online-move-move---online)) needs the source to publish and the target to subscribe. What each provider allows, with the verification status of each row:

| Provider | As source (publisher) | As target (subscriber) | Status |
|---|---|---|---|
| Plain PostgreSQL 15/16, self-hosted or Docker | `wal_level=logical`, a free slot and WAL sender | superuser, or `pg_create_subscription` (16) | **verified** (2026-10-19, PostgreSQL 16.15, Bun SQL) |
| Amazon RDS / Aurora PostgreSQL | parameter `rds.logical_replication=1` (needs a reboot) | `rds_superuser` can create subscriptions | documented, not verified |
| Google Cloud SQL for PostgreSQL | database flag `cloudsql.logical_decoding=on` | the default admin role may create subscriptions | documented, not verified |
| Neon | logical replication is enabled per project in its settings | supported with the project owner role | documented, not verified |
| Supabase | publications and slots are available | the `postgres` role is not a superuser, so creating a subscription is not possible: restricted, use it as a source only | documented, not verified |

All the provider rows come from the providers' documentation and have not been run against real accounts. The source must be reachable from the target server (private networking or allow-listing), which is outside what pgcells can check.

## Verification

```bash
DATABASE_URLS='<management URLs>' bun run verify:provider [--driver bun|postgres|pg|neon]
```

The management URLs come from `DATABASE_URLS`; the runtime URLs (the same count and order, comma-separated) are asked through a hidden prompt (the same format as `doctor --pooled-urls`). The output is only JSON; it contains no URL, host, user or password. **Run it only on free/temporary test databases.** The script temporarily changes the `ALTER DATABASE` setting and writes the original value back; if it cannot be written back, `alterDatabase.restoreSql` gives the command to run by hand.

| Field | Expected / meaning |
|---|---|
| `probe.runtime.transactionPooler` | `true`: the runtime URL goes to a transaction pooler |
| `probe.management.transactionPooler` | `false`: the management URL is direct or session-pooled |
| `alterDatabase.allowed` / `newSession` | `bootstrap`'s `ALTER DATABASE … SET` job was accepted and was visible in a new direct session |
| `alterDatabase.throughRuntime` | was visible in a new session on the runtime URL. `false` alone is not an error: the pooler may reuse existing server connections |
| `privileges` | the `CREATE` privilege for `bootstrap`, the role type, and a `CREATE EXTENSION` attempt for an extension (the transaction is rolled back) |
| `deadline.cancelDefined` | whether the driver defines cancellation on the server (Bun SQL and `neonDriver` do not) |
| `deadline.serverStoppedAfterMs` | how long the long query on the server took to finish after the connection was discarded; if `null`, it did not finish within the time |

The script does not repeat the connection checks (`pooled_runtime`, `direct_connection`, `runtime_timeouts`); `doctor --pooled-urls` measures them. Use the two commands together.

### Replica measurement

```bash
DATABASE_URLS='<management URLs>' bun run verify:provider --replica
```

`--replica` asks for the replica URLs (`db0=postgres://…`, comma-separated, one per node) through a hidden prompt and adds `replica` to the node report. It only reads.

| Field | Meaning |
|---|---|
| `replica.inRecovery` | `true`: the URL really goes to a replica |
| `replica.lagMs` | Lag in three samples one second apart (by replay position; `0` caught up, `null` unknown) |
| `replica.maxStandbyStreamingDelay`, `replica.hotStandbyFeedback` | Standby settings that determine recovery conflicts; these determine whether a `--from-replica` backup will be cancelled during a long snapshot |

| Provider | Replica behavior |
|---|---|
| Neon read replica | documented, not verified |
| Supabase read replica | documented, not verified |

## Decisions based on the result

| Measurement | Action |
|---|---|
| The check is `false` on a real pooler | A false negative: use `pooler: "assumed"` for that provider ([configuration.md](configuration.md)). |
| `ALTER DATABASE … SET` is rejected | The database defaults cannot be written; the runtime timeouts cannot be set up with `bootstrap`. The fix is the provider's role privileges. |
| The Supabase direct URL cannot connect because of IPv6 | `DATABASE_UNAVAILABLE`; use the session pooler (`:5432`) as the management URL. |
| The backend continues after the deadline on the pooler | Even if the connection is discarded, the statement can run until the server `statement_timeout`; keep the runtime `statement_timeout` low accordingly. |

## Limits

- Supabase PITR restores the **whole project in place and with downtime**; there is no restoring a single tenant.
- The Neon HTTP `neon()` function is not supported: it offers no interactive session or dedicated connection.

## Provider tools

The Neon tools call the Neon API with `fetch`; the API key is asked through **hidden input** (it is not written to argv or env) and does not enter any output. Projects are found by matching the endpoint list of the key's account against the node hosts (`PROVIDER_NODE_NOT_FOUND`); if the key is tied to an organization, pass `--org <id>`. **The tools delete no branches** (deletion is irreversible): delete the branches that were opened yourself from the Neon console. The free plan's branch count and history retention period are limited; if the limit is exceeded, Neon's error (`PROVIDER_API_ERROR`) is shown as is.

| Command | What it does |
|---|---|
| `migrate-all --safety-point neon` | Opens a `pre-migrate-<timestamp>` branch from each source branch, covering the current moment; **the migration does not start until all of them are opened**. A second branch in the same project gets `-2` appended to the name. |
| `migrate-all --safety-point supabase` | Makes no API call: records the UTC timestamp (`recovery_time_target_unix`) and prints the `restore-pitr` request. |
| `neon stage-copy` | Opens a `stage-<timestamp>` branch from each source branch (for a migration trial); only the branch id and host are written, the encrypted URI is not (get the password from the console). |
| `neon export-tenant <tenant> <folder> --at TIME` | Opens a `pitr-<timestamp>` branch at the `--at` moment from each source branch, sets up a temporary management context with these branches and writes the tenant to the folder with the existing `export`. No write to live data happens. |

### Turning a tenant back to a past moment

```bash
bun run cli neon export-tenant acme ./acme-at --at 2026-10-03T09:30:00Z   # export of a past moment (--at: RFC 3339 with a UTC offset; a time without an offset is rejected)
bun run cli restore acme ./acme-at                                         # builds the tenant if it is missing
```

`restore` does not overwrite an active tenant (`TENANT_EXISTS`): the tenant must be missing first. There is no restoring to a new id; the `tenant.json` and table files in the export folder can also be used to inspect data that was overwritten by mistake.

### Supabase

The Supabase safety point is only a record, and **rests on a paid add-on**: PITR can be enabled as an add-on only on the Pro, Team and Enterprise plans; on the free plan and without the add-on, the recorded time is not a restore point (there, take your own `db dump` backup before `migrate-all`). PITR (`POST https://api.supabase.com/v1/projects/{ref}/database/backups/restore-pitr`, body `{"recovery_time_target_unix": <seconds>}`) restores the **whole project in place and with downtime**; restoring a single tenant is not possible.
