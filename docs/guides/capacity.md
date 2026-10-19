# Capacity: how many instances, cells and replicas for a target load

"How many servers do I need for a million requests per second?" has no honest answer without three numbers that depend on **your** hardware, schema and query mix. This guide gives the model, a calculator (`pgcells capacity plan`), one measured starting point, and says exactly which parts are measured and which are assumed.

Status legend: *measured* = taken from a run recorded in this repository; *assumed* = a stand-in you must replace with your own measurement.

## 1. The model

A statement's life: application process → pooler → one PostgreSQL server. Three capacities matter:

| Figure | Meaning | How to get it |
|---|---|---|
| `perProcessRps` | Statements per second one application process sustains at 100 % of one core | `bun run bench:hotpath` (in-process) and the k6 routes of `bench:compare` (over HTTP) |
| `perCellRps` | Statements per second one PostgreSQL server (a primary, or a replica) sustains at 100 % | Run your real query mix against one cell until its CPU saturates; `bench:compare` does this for point reads and inserts |
| `utilization` | The fraction you plan to use at peak (default 60 %) | Headroom for spikes, a failover that moves load onto the survivors, and rolling deploys |

From those and your target the model gives:

- **Application instances** = target ÷ (`perProcessRps` × utilization), never below 2.
- **Cells (primaries)**: writes decide them. Each cell takes its share of the writes; with replicas, reads are served by replicas, not by primaries. The number of cells is also at least `tenants ÷ tenantsPerCell` when you give both (a cell's catalog and migration time grow with its tenant count).
- **Replicas per cell** = reads per cell ÷ (`perCellRps` × utilization), at most 8 (the package's limit); beyond that the plan adds cells instead.

```bash
pgcells capacity plan --target-rps 1000000 --per-process-rps 15000 --per-cell-rps 20000 \
  --read-percent 80 --tenant-count 20000 --tenants-per-cell 1500
```

It needs no database. In code: `capacityPlan(input)` from `@0furkancolak/pgcells/tools`. A unit test locks the numbers of the example below.

## 2. A measured starting point

Recorded runs in `packages/db-multi/src/__tests__/bench/results/` (Apple M4 laptop, Docker VM with 6 vCPUs, PostgreSQL 16 in a container, PgBouncer 1.24 in transaction mode, Bun 1.3.14, k6 with 64 virtual users; everything shares one machine, so these are **order-of-magnitude figures, not benchmarks of your hardware**):

| What was measured | Result | Read as |
|---|---:|---|
| One cell, point read over HTTP (`compare-2026-09-16`, route `point`) | about 9,000 requests/s, PostgreSQL at ~92 % of its core | `perCellRps` ≈ **9,000 per PostgreSQL core** for a primary-key read |
| Same run, the application process | ~53 % of one core at 9,000 requests/s | `perProcessRps` ≈ 17,000 per core — *assumed* linear, the run did not saturate the application |
| A route that does not touch the database (`health`) | about 20,000 requests/s | The HTTP stack's own ceiling for one process |
| In-process statements through `withTenant` (`bench:hotpath`, 32 loops; a 2026-10-19 run, not saved under `results/`) | 20,677 statements/s (22,127 for the raw driver); 9,410 for the same code when the machine was busy | Driver plus pooler ceiling for one process; it drops sharply when the machine is busy |

A cell here is one PostgreSQL core. A production server has many cores and faster storage, so `perCellRps` is mostly a question of your hardware: measure it.

## 3. Worked example: one million statements per second

Assume 80 % of statements are reads that replicas can serve, 20,000 tenants, a cell that holds 1,500 tenants comfortably, and (assumed) 15,000 statements/s per application process and 20,000 per PostgreSQL server:

| | |
|---|---|
| Application instances | 112 (1,000,000 ÷ (15,000 × 0.6)) |
| Cells (primaries) | 17: writes are 200,000/s, each primary plans for 12,000/s |
| Replicas per cell | 4: 800,000 reads ÷ 17 cells = 47,059 per cell ÷ 12,000 |
| PostgreSQL servers | 85 (17 primaries + 68 replicas) |
| Per cell at peak | 11,765 writes/s, 47,059 reads/s, ~1,176 tenants |

With the **measured** figures instead (9,000 per PostgreSQL core, 17,000 per application process):

```bash
pgcells capacity plan --target-rps 1000000 --per-process-rps 17000 --per-cell-rps 9000 \
  --read-percent 80 --tenant-count 20000 --tenants-per-cell 1500
# 99 instances, 38 cells, 4 replicas per cell, 190 PostgreSQL servers
```

The gap between the two plans (85 versus 190 servers) is the point: the answer moves by more than a factor of two with the per-server figure, so measure it.

## 4. The connection side of the same fleet

Throughput is not the only limit: every instance holds pools and every PostgreSQL server accepts a bounded number of connections. Feed the plan into `pgcells pooler plan` (see the [connections guide](connections.md#3-sizing-the-connection-budget)): for each cell, `instances × poolMax × (1 + replicas)` client connections must fit the poolers, and the pooled server connections must fit `max_connections`. At 112 instances and `poolMax` 5, one cell with 4 replicas sees 112 × 5 × 5 = 2,800 client connections per database: that needs several PgBouncer instances per cell, not one.

## 5. Backpressure: why the pending limit stays at 64

Each process accepts at most 64 pending jobs per database (`DATABASE_BUSY` beyond that). The worst wait for a job at the back of the queue is about `pending × average statement time ÷ poolMax`: with a 2 ms statement and `poolMax` 5 that is 26 ms; with a 100 ms statement it is 1.3 s. A deeper queue only helps when jobs would otherwise be refused while the pool is mostly idle, and it turns a fast, explicit `DATABASE_BUSY` into a slow `DATABASE_TIMEOUT` once the wait nears `statementTimeoutMs`. **Decision (2026-10-19): the limit stays at 64 and is not configurable**; to absorb bursts, raise `poolMax` (and the pooler's pool size) or add instances. The measured behaviour under a storm (320 concurrent statements from four processes against a server pool of five) is in the [connections guide](connections.md#9-fairness-one-tenant-must-not-starve-the-rest).

## 6. Sharing pools across instances

Pools are per process and per database; nothing is shared between processes. What is shared is the pooler: many small client pools multiplex onto a few server connections. So scaling application instances costs client connections (cheap), not server connections (expensive), as long as the poolers are sized by the budget above. Do not run a pooler sidecar per instance: each sidecar keeps its own server pool and the server connections multiply with the instance count.

## 7. What these numbers leave out

- Write amplification: indexes, triggers, WAL and replication traffic. Replica count also costs primary WAL sender bandwidth.
- Statement mix. A point read and a report are three orders of magnitude apart; use your mix.
- Tenant count per cell. The model takes `tenantsPerCell` as an input; the rule of thumb in the [regions guide](regions.md#11-capacity-and-noisy-neighbours) (hundreds to low thousands) is guidance, not a measurement. The integration suite exercises 1,000 schemas across two databases; the 10,000-tenant benchmark fixture is `bench --phase setup`. Watch catalog size, autovacuum and migration time on your hardware.
- Failure headroom. Utilization 60 % assumes a failed replica's load moves to its siblings; plan more if you run a single replica per cell.
- Replica lag under write load: reads that need your own write must go to the primary ([regions guide](regions.md#6-consistency-model)).
