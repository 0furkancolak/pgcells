# Walkthrough: from the first tenant to a second region

A story, start to finish, with code you can run. **Ledgerly**, a small bookkeeping SaaS, starts with one customer in Europe, signs a customer in the US that must keep its data in the US, and later moves a customer between regions. Every `ts walkthrough` block below is a real script: CI type-checks it and runs it, in order, against a local PostgreSQL pair (`docker compose up -d` in `packages/db-multi`, then `DATABASE_URLS` pointing at the two direct URLs from `.env.example`). If this page and the package disagree, the build fails.

What you need: Bun and three empty PostgreSQL databases reachable with direct URLs, in `DATABASE_URLS` (`<db0>,<db1>,<db2>`). Locally the compose file in `packages/db-multi` starts two servers (`postgres-0`, `postgres-1`); create the third database on either (`CREATE DATABASE ledgerly_us`). A *cell* is one such database (in production, a cluster).

Concepts used here are explained in the [regions guide](regions.md) (cells, the directory, residency) and the [connections guide](connections.md) (poolers). This page is the path through them.

## 1. Three cells in two zones

A cell holds many tenants, one schema each. `db0` is the first URL in `DATABASE_URLS`; it also holds the *directory*, the small `platform` schema that says which tenant lives where. `bootstrap` prepares every database (idempotent, safe on every deploy); then we say where each cell lives. Ledgerly runs two EU regions and one US region:

```ts walkthrough
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { bootstrap, createManagement } from "@0furkancolak/pgcells/management";
import { listDatabases, setDatabase } from "@0furkancolak/pgcells/tools";

// Management uses direct connections (session locks); the URLs come from DATABASE_URLS.
const management = createManagement({ driver: bunDriver });
await bootstrap(management);

// A residency zone is the legal area; a region is where a cell runs. Two regions can share a zone.
await setDatabase(management, "db0", { region: "eu-west", zone: "eu" });
await setDatabase(management, "db1", { region: "eu-central", zone: "eu" });
await setDatabase(management, "db2", { region: "us-east", zone: "us" });

for (const database of await listDatabases(management)) console.log(database.databaseId, database.region, database.residencyZone);
await management.close();
```

## 2. The first tenant

A tenant is a customer. It gets a schema in one cell, migrated to the current version. Asking for the zone `eu` *binds* it there: it will never be placed or moved outside the zone. Left to itself pgcells picks the least loaded EU cell; to keep this story predictable we name `db0`.

```ts walkthrough
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement, provisionTenant } from "@0furkancolak/pgcells/management";

const management = createManagement({ driver: bunDriver });
const acme = await provisionTenant(management, "ledgerly-acme", "db0", { zone: "eu" });
console.log(acme.tenantId, "lives on", acme.databaseId, "in", acme.region, "bound to zone", acme.residencyZone);
await management.close();
```

## 3. Serving requests

The application opens the runtime once per process. In production its `DATABASE_URLS` point at a transaction-mode pooler such as PgBouncer ([connections guide](connections.md)); here, to keep the page self-contained, we point it at the same direct URLs and tell it so with `pooler: "assumed"`. The `region` says where *this process* runs. Queries are compiled SQL; `withTenant` finds the tenant's cell (a cached directory lookup) and runs the query in its schema.

```ts walkthrough
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { prepareQuery } from "@0furkancolak/pgcells/management";

const db = createDatabase({ driver: bunDriver, pooler: "assumed", region: "eu-west" });

const addUser = prepareQuery("INSERT INTO users (id, name, email) VALUES ($1::uuid, $2, $3) RETURNING id::text AS id, name");
const listUsers = prepareQuery("SELECT id::text AS id, name FROM users ORDER BY created_at, id LIMIT $1::integer");

await db.withTenant("ledgerly-acme", (tenant) => tenant.query(addUser, [crypto.randomUUID(), "Ada", "ada@acme.example"]));
const users = await db.withTenant("ledgerly-acme", (tenant) => tenant.query<{ id: string; name: string }[]>(listUsers, [10]));
console.log("acme has", users.length, "user:", users[0]?.name);
await db.close();
```

## 4. A customer that must stay in the US

Ledgerly signs *Globex*, whose contract keeps its data in the US. Same call, another zone; the placement follows the zone (and would fail with `NO_CAPACITY` rather than place Globex in Europe if there were no US cell).

```ts walkthrough
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement, provisionTenant } from "@0furkancolak/pgcells/management";

const management = createManagement({ driver: bunDriver });
const globex = await provisionTenant(management, "ledgerly-globex", undefined, { zone: "us" });
console.log(globex.tenantId, "lives on", globex.databaseId, "in", globex.region);
await management.close();
```

## 5. The wrong region says no

A request for Globex that lands on a European process must not quietly cross the Atlantic. With `region` set, the runtime refuses it with `WRONG_REGION`, before touching Globex's data. In a web app, `regionGuard` turns that into `421` or a `307` to the right host ([middleware guide](../../packages/db-multi/docs/middleware-and-jobs.md#regions-regionguard)).

```ts walkthrough
import { createDatabase } from "@0furkancolak/pgcells";
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";

const europe = createDatabase({ driver: bunDriver, pooler: "assumed", region: "eu-west" });
try {
  await europe.withTenant("ledgerly-globex", async () => "never reached");
  throw new Error("expected a refusal");
} catch (error) {
  console.log((error as { code?: string }).code);
} finally {
  await europe.close();
}
```

## 6. Residency is enforced, not just documented

Moving Globex to an EU cell is refused by the package itself, in the same transaction that would write the placement:

```ts walkthrough
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement } from "@0furkancolak/pgcells/management";
import { startMove } from "@0furkancolak/pgcells/tools";

const management = createManagement({ driver: bunDriver });
try {
  await startMove(management, "ledgerly-globex", "db0", true);
  throw new Error("expected a refusal");
} catch (error) {
  console.log((error as { code?: string }).code);
} finally {
  await management.close();
}
```

What the package guarantees is that it never places or moves tenant data outside the zone; what you write into the directory's application columns, your backups and your logs is yours to keep in-region ([regions guide, section 8](regions.md#8-residency)).

## 7. Relocating a customer inside its zone

*Acme* grows in Germany and Ledgerly wants it served from `eu-central`. That is a move between two cells of the same zone, which residency allows, but a move to another *region* is a deliberate act: without `allowCrossRegion` (`--allow-cross-region` on the CLI) it is refused. The mover then marks the tenant as migrating, waits for every process's cached placement to expire (`placementCacheWaitMs`, 30 s by default), copies the schema, checks the copy, switches the placement and renames the old schema so a process with a stale placement fails instead of writing to it. `writersDrained: true` is your promise that nothing writes to the tenant meanwhile. This block takes about half a minute for that reason.

```ts walkthrough
import { bunDriver } from "@0furkancolak/pgcells/drivers/bun";
import { createManagement } from "@0furkancolak/pgcells/management";
import { startMove } from "@0furkancolak/pgcells/tools";

const management = createManagement({ driver: bunDriver });
try {
  await startMove(management, "ledgerly-acme", "db1", true);
} catch (error) {
  console.log("without the flag:", (error as { code?: string }).code);
}
const move = await startMove(management, "ledgerly-acme", "db1", true, undefined, { allowCrossRegion: true });
const acme = await management.platform.get("ledgerly-acme");
console.log("move", move.status, "- acme now on", acme.databaseId, "in", acme.region, "still bound to zone", acme.residencyZone);
await management.close();
```

The old copy is kept under a marker name (`tenant_ledgerly_acme__moved_…`) until you drop it; `doctor` lists it. A process running as `eu-west` now refuses Acme with `WRONG_REGION`, like Globex in section 5.

## 8. Operating it

Two questions every operator asks, answered with arithmetic you can run: how many connections the fleet needs, and how many servers a target load needs. Both are pure functions and need no database.

```ts walkthrough
import { capacityPlan, connectionBudget } from "@0furkancolak/pgcells/tools";

const budget = connectionBudget({ appInstances: 40, poolMax: 5, poolers: 2, defaultPoolSize: 20, maxClientConn: 1000, maxConnections: 200, rps: 5000, latencyMs: 2 });
console.log("connection budget ok:", budget.ok, "server connections", budget.servers.load, "of", budget.servers.limit);

const plan = capacityPlan({ targetRps: 100_000, readShare: 0.8, perProcessRps: 15_000, perCellRps: 20_000, tenants: 2000, tenantsPerCell: 1500 });
console.log("100k statements/s needs", plan.appInstances, "instances and", plan.cells, "cells with", plan.replicasPerCell, "replicas each");
```

From here: [connections](connections.md) for poolers and failure behaviour, [regions](regions.md) for the model, [capacity](capacity.md) for sizing.
