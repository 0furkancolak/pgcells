# Tenants

This document covers a tenant's identity (the subdomain label), how that identity is extracted from the request, how it turns into a schema name, the placement record and its states, which IDs are never handed out, which database a new tenant is placed in, and what must be true for the application to count as "ready".

## Tenant ID rules

The tenant ID is the subdomain label: `abc.example.com` → `abc`. The same value is valid both as a DNS label and as a schema name.

- 3–56 characters; starts with a lowercase letter; contains `[a-z0-9]` and single `-`.
- No `-` at the start, at the end or repeated; no `.`, `_` or `xn--` (IDN).
- The stored ID is strict: an uppercase letter or a space gives `INVALID_TENANT_ID`.

```ts
import { normalizeTenantId, validateTenantId } from "@0furkancolak/pgcells";

validateTenantId("abc-shop");   // "abc-shop"
validateTenantId("ABC");        // AppError INVALID_TENANT_ID
normalizeTenantId("  ABC ");    // "abc" — cleans up user input first, then validates
```

## Tenant from the Host header: `tenantFromHost`

```ts
import { tenantFromHost } from "@0furkancolak/pgcells";

tenantFromHost("abc.example.com", "example.com");                 // "abc"
tenantFromHost("abc.example.com:443", "example.com");             // "abc" (the port is dropped)
tenantFromHost("ABC.example.com.", "example.com");                // "abc" (lowercased, trailing dot dropped)
tenantFromHost("abc.localhost:3000", ["example.com", "localhost"]);   // "abc" (roots are tried in order)
tenantFromHost("a.abc.example.com", "example.com");               // INVALID_TENANT_ID (multiple labels)
tenantFromHost("abc.baska.com", "example.com");                       // INVALID_TENANT_ID (different root)
tenantFromHost(null, "example.com");                                  // INVALID_TENANT_ID (no header)
```

The host must be exactly `<id>.<root>`. `dbMiddleware` does this itself with the `rootDomain` option ([middleware-and-jobs.md](middleware-and-jobs.md)). Whether the user may access that tenant is still decided by the application.

## Schema name and kind

The schema name is derived from the ID: `tenant_` (`demo_` for a demo tenant) + the ID, with `-` → `_`.

| ID | Kind (`kind`) | Schema |
|---|---|---|
| `abc` | `tenant` | `tenant_abc` |
| `abc-shop` | `tenant` | `tenant_abc_shop` |
| `vitrin` | `demo` | `demo_vitrin` |

Because the ID contains no `_`, the mapping is one-to-one and a 56-character ID fits the 63-byte schema limit. Demo tenants are created with `provision <id> --demo` and receive the demo seeds ([migrations-and-seeds.md](migrations-and-seeds.md#demo-tenants)).

## Placement

Placement is the platform record that holds where a tenant lives (the `Placement` type and the `placementSchema` zod schema come from `@0furkancolak/pgcells`):

```ts
{ tenantId: "abc", databaseId: "db1", kind: "tenant", schemaName: "tenant_abc", status: "active", schemaVersion: 5, placementVersion: 1, residencyZone: "eu", region: "eu-west" }
```

`residencyZone` is the zone the tenant is bound to (`null`: unrestricted) and `region` is the region of the node it lives on (`null`: the node has none); both belong to the [region model](#regions-zones-and-labels).

```ts
```

| `status` | Meaning | For requests |
|---|---|---|
| `provisioning` | Being created (migration/seed in progress or left half-done) | `TENANT_UNAVAILABLE` |
| `active` | Usable | normal |
| `maintenance` | Demo reset or the cutover of a move | `TENANT_UNAVAILABLE` |
| `migrating` | Being moved | `TENANT_UNAVAILABLE` |
| `failed` | The operation failed; retried with the same command | `TENANT_UNAVAILABLE` |

To read it:

```ts
await db.placement("abc");       // from the in-process cache (active record only, placementCacheMs) or from the platform database
db.invalidatePlacement("abc");   // immediately deletes the cache entry in this process; a read in flight is not written to the cache either
await db.platform.get("abc");    // from the platform database every time; TENANT_NOT_FOUND if missing
```

CLI: `bun run cli status abc`.

## Application fields on the tenant record

In the package's migrations `platform.tenants` defines only the `tenant_id` and `created_at` columns. The application can add columns with its own platform migration (e.g. `name`, `display_name`, `owner_email`). If these columns are NOT NULL, every package flow that creates the tenant record must supply their values; the package writes them in the same `INSERT` statement that creates the record.

| Flow | Fields |
|---|---|
| `provisionTenant(m, id, dbN, { tenant })` | `bun run cli provision abc --tenant '{"name":"Abc","display_name":"ABC","owner_email":"a@abc.test"}'` |
| `adoptSchemas` / `planAdoption` | `"tenant": { … }` in the JSONL line |
| `restoreTenant(m, id, dir, { tenant })` | The row in the backup is written by itself; `tenant` overwrites it (API only) |

```ts
import { provisionTenant } from "@0furkancolak/pgcells/management";

await provisionTenant(management, "abc", undefined, { tenant: { name: "Abc", displayName: "ABC", owner_email: "a@abc.test" } });
```

Rules:

- **Key = column name** (snake_case), because the columns come from the application's migrations, not the package's. If there is no column with the same name, a camelCase key is converted to snake_case (`displayName` → `display_name`); if two keys land on the same column (`displayName` + `display_name`) it is rejected. A column with the exact name (a quoted name with uppercase letters) always takes precedence.
- **Values** are text, number, boolean or `null`; they are sent as a single bound JSON parameter and PostgreSQL converts them to the column type (`json_populate_record`): ISO text for `timestamptz`, text for `uuid`. Column names are quoted.
- **Validation** is against the real columns (`information_schema.columns`, with the bound schema/table name) and is cached per management context; for a key that is not found, the columns are re-read once. `INVALID_CONFIG`: an unknown or generated (`GENERATED`) column, `tenant_id`, a column defined by the package's migrations (`created_at`), a non-plain value. The error comes before the lock and the write.
- **New record only:** repeating `provision`/`adopt` with the same intent does not change the existing row; updating fields is the application's job. The placement lock, placement selection and CAS rules are the same.
- **Missing required column:** the code is PostgreSQL's `23502`, and the message names the column (`platform.tenants.owner_email is NOT NULL; …`); the transaction is rolled back and no placement is written. In adoption the row becomes `failed`.
- **Restore** brings back the whole row, `created_at` included. In an export folder the row is in the `tenant` field of `tenant.json`; at the backup root the `platform/tenants.jsonl.gz` record of the selected set is used (the values as of the set, even if the tenant data stayed in an older set). Columns that no longer exist on the target are not written and are returned in the result as `skippedTenantColumns`. Exports taken before this field have no row: the required columns are supplied with the `tenant` option.

## Reserved IDs

`platform.reserved_tenant_ids` holds subdomains that will never be given out as tenants. The platform migration fills it with infrastructure and environment names (e.g. `www`, `api`, `app`, `cdn`, `static`, `mail`, `smtp`, `db`, `redis`, `worker`, `localhost`, `dev`, `staging`, `test` …).

- `provision` and `restore` give `TENANT_RESERVED` for a reserved ID.
- Add brand or product names yourself; an existing tenant cannot be reserved (`TENANT_EXISTS`).
- Reserving and placement selection take the same transaction lock, so they do not race.

```sh
bun run tools reserve mybrand,destek --reason brand
bun run tools reserved
bun run tools unreserve destek
```

From code: `reserveTenantIds(management, ["mybrand"], "brand")`, `releaseTenantIds(management, ["destek"])`, `listReservedTenantIds(management)` — `@0furkancolak/pgcells/tools`.

## One ID, one schema across all databases

Before writing, `provision` and `restore` look for the `tenant_<id>` and `demo_<id>` schemas in **every** database in `DATABASE_URLS`; if one exists, `SCHEMA_EXISTS` (the message says which database). The `platform.tenants` primary key and the `placements.schema_name` UNIQUE constraint are the second safeguard. For this reason all databases must be ready when creating a tenant: the check is the same as `db.ready()`, and no tenant is created while a database is down or missing.

## Placement selection: size, capacity, draining

- Each placement's `size` (1–100, default 1) is the tenant's estimated load.
- Each database's `capacity` (default 1000) is the upper limit of the sum of sizes on it (`load`).
- If no database is given, among the databases with `status = active` that satisfy `load + size ≤ capacity`, the one with the lowest `(load + size) / capacity` ratio is chosen; ties are broken in the order `db0`, `db1` …. If none fits, `NO_CAPACITY`.
- If the database is given by hand (`provision abc db1`), that database must be `active` and the tenant must fit.
- A database in the `draining` state takes no new tenants; existing ones stay. Capacity may drop below the load; then the database also takes no new tenants.
- The selection is in the same transaction as the placement record; when a half-finished provision is retried, the same database is used. If the same ID is requested again with a different database, kind or residency zone, `TENANT_CONFLICT`.
- `--region`, `--zone` and `--label` narrow the choice to matching databases ([below](#regions-zones-and-labels)); if none matches or fits, `NO_CAPACITY` with the request in the message.

```sh
bun run cli provision kadikoy --size 20     # db0 (load 0/1000)
bun run cli provision moda --size 10        # db1: (0+10)/1000 < (20+10)/1000
bun run cli provision sisli                 # db1: (10+1)/1000 < (20+1)/1000
bun run tools databases
# [{"databaseId":"db0","status":"active","capacity":1000,"tenants":1,"load":20,"configured":true},
#  {"databaseId":"db1","status":"active","capacity":1000,"tenants":2,"load":11,"configured":true}]
bun run tools database set db0 --status draining
bun run tools database set db1 --capacity 2000
```

From code: `listDatabases(management)`, `setDatabase(management, "db0", { status: "draining", capacity: 2000 })` — `@0furkancolak/pgcells/tools`; `provisionTenant(management, "abc", undefined, { size: 20 })` — `@0furkancolak/pgcells/management`.

## Regions, zones and labels

A database can say where it lives; none of it is required, and a database with no region behaves exactly as before.

```sh
bun run tools database set db0 --region eu-west --zone eu
bun run tools database set db1 --region us-east --zone us --label tier=gold
bun run tools database set db1 --label dedicated=true       # skipped by automatic placement
bun run tools database set db1 --unlabel tier --region none # "none" clears a region or zone
bun run tools databases    # now lists region, residencyZone and labels per database
```

- **`region`** is where the database runs (`eu-west`). **`residency_zone`** is the legal area it belongs to (`eu`): several regions can share a zone. Both are lowercase names of up to 63 characters (`a-z`, `0-9`, `-`).
- **Placement requests.** `provisionTenant(m, id, undefined, { region, zone, labels })` and `restoreTenant(…, { region, zone, labels })` (CLI `--region`, `--zone`, `--label k=v`) restrict the automatic choice to databases that match. A database labelled `dedicated=true` is skipped by automatic choice unless the request carries that label or names the database.
- **Residency.** A tenant is bound to a zone: the requested `zone`, else the zone of the database it was placed on (none if that database has no zone). From then on `provision` onto, `restore` onto, `move` to and `adopt` into a database outside that zone is refused with `RESIDENCY_VIOLATION`, checked in the same transaction that writes the placement. `database set --zone` is refused while it would strand a tenant bound to another zone. A backup remembers the zone and `restore` keeps it.
- **Moves.** `move` to a database in a different *region* needs `--allow-cross-region` (`CROSS_REGION_MOVE` otherwise); it never lets a tenant leave its zone.
- **What this guarantees and what it does not:** the package never places or moves tenant data outside its zone. It cannot see application columns you add to `platform.tenants`, where you write backups or logs; `doctor` warns about personal-looking directory columns (`directory_pii`). See the [regions guide](https://github.com/0furkancolak/pgcells/blob/main/docs/guides/regions.md).

From code: `setDatabase(m, "db1", { region, zone, labels, unlabel })`, `listDatabases(m)` (`@0furkancolak/pgcells/tools`).

## Readiness: `db.ready()`

`db.ready()` connects to every database in `DATABASE_URLS` and compares its identity (`platform.node_identity`) and the `platform.nodes` records. It also checks that each database is behind a transaction-mode pooler (`pooler: "verified"`, the default); if not, `POOLER_REQUIRED`. Call it at application startup and in the health endpoint; if there is an error, do not start the process.

| Code | Situation | What to do |
|---|---|---|
| `DATABASE_UNAVAILABLE` | A database cannot be reached | Fix the database/network; the message contains only `dbN` |
| `DATABASE_ORDER_CHANGED` | A position points at a different database | Restore the `DATABASE_URLS` order |
| `DATABASE_NOT_CONFIGURED` | A registered database's URL is not in the list | Add the missing URL back in its old position |
| `DATABASE_NOT_REGISTERED` | The list has a database that has not been bootstrapped | `bun run cli bootstrap` |
| `POOLER_REQUIRED` | The database is connected to directly (no pooler) | Point `DATABASE_URLS` at a pooler, or in an environment that cannot be tested deliberately use `pooler: "assumed"` |
| `DATABASE_TIMEOUT` | No response within `statementTimeoutMs + 1 s` (+ at most 0.5 s of cancellation wait) (e.g. the database is down behind PgBouncer); the pooler check also gives this code with its own `statementTimeoutMs + 1 s` limit, so with a database that is down `ready()` waits for two limits in a row in the worst case | Handle it like `DATABASE_UNAVAILABLE` |

Provision, restore and `backup` run the same check themselves.

## What isolation does and does not guarantee

- The tenant ID is validated; the client cannot choose a database or schema. Query fragments are joined with the validated schema name, and values are sent as separate parameters.
- This is **routing at the application level.** The application and management use the same credential; this credential can access all tenant schemas and the platform tables. It is not physical isolation against someone who can run arbitrary SQL with the same credential.
- User → tenant authorization is the application's job; the package only resolves "which tenant does this request go to".
