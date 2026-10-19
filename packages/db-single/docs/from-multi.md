# From `db-multi`: why there are no tenants here

`@0furkancolak/pgcells-single` was made by copying `@0furkancolak/pgcells` and deleting everything tenant-related. This file is the only place where the package deliberately uses the multi-tenant vocabulary (tenant, placement, platform database): `src/__tests__/unit/no-multi-tenant.test.ts` keeps this vocabulary out of the source, manifest and compose files, and this note is its documented rationale.

| | `db-multi` | `db-single` |
|---|---|---|
| Structure | multiple DBs, one schema per tenant, a platform database that records where each tenant lives | **one DB, one schema** (`public` by default) |
| Environment | `DATABASE_URLS` with multiple URLs (the order is the identity) | `DATABASE_URLS` with exactly one URL |
| For whom | an application serving many tenants from a single codebase | classic managed PostgreSQL (Neon, Supabase, RDS) with a single table set |
| Query target | chosen on every call (`withTenant`, `withNode`, `withPlatform`) | the single schema bound in `createDb` |

The two packages are separate on purpose: `db-single` does not depend on `db-multi`, and each can be copied on its own. The cost is a full copy: compiler, driver and tool fixes are made in two places and the two can diverge; a shared SQL package was left out of scope.

## There is no automatic migration between the two

`db-multi` code reaches data through a tenant context; `db-single` has no context: queries, middleware and the auth wiring are not translated but rewritten. Names: `createDatabase` → `createDb`; `db.withTenant(id, (t) => t.query(q))` and `c.get("db").tenant.query(q)` → `db.query(q)` and `c.get("db").query(q)`; `withTenantRead`/`tenantRead` → `db.read.query`; `createTenantAuth` → `createAuth`; `src/queries/tenant/*.sql` and `src/migrations/tenant/*.sql` → `src/queries/*.sql` and `src/migrations/*.sql`. There is no tool that moves data; since `pull` can read any schema, it can produce an initial migration from a tenant schema ([migrations-and-seeds.md](migrations-and-seeds.md#initial-migration-from-an-existing-database-pull)), but moving the rows is up to you (`pg_dump`, `COPY`).

## What is missing, and why

- **The tenant concept:** tenant/placement/node/platform scopes, `withTenant`/`withNode`/`withPlatform`, `provision`, `move`, `copy`, `adopt`, platform-merge/-move, reserved IDs, capacity and placement selection, `databases`. There is a single target, so the “the target is explicit on every call” principle holds by itself. `createDbScope(db)` remains only for read-your-writes.
- **The management scaffolding:** `bootstrap`, the `platform` schema, the DB identity guard (`DATABASE_ORDER_CHANGED`), `migration-recover` and the persistent runner marker. With a single URL there is no order and no DB to mix up; the ledgers (`_migrations`, `_seeds`) live in the application schema, and every step can be retried.
- **Bulk jobs:** `migrate-all`, `seed-all`, `demo-reset`, the install/demo seed profiles; with a single schema, `migrate` and `seed` are enough.
- **Application-specific tools:** `users import`, `dump *`, `app-migrate`, `import-users`.
- **Auth:** the `student`/`teacher` kinds, per-tenant secret/cookie prefix/cache, `createPlatformAuth`, `user_imports`; there is nothing to isolate.
- **Measurement:** the `bench*` scripts (scale and capacity are a separate sub-project).

What remains: the three drivers and the Neon driver, the SQL compiler and codegen, the pooler requirement and its probe, deadlines/timeouts, telemetry, replica reads, Neon/Supabase verification and tools, backup/restore/export, `doctor`, `pull`, `replicas` and the Better Auth adapter.
