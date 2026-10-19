# Decision: a shared core package for `pgcells` and `pgcells-single` (F5.5)

Date: 2026-10-19 · Status: decided, revisit at v0.5 · Context: [roadmap](2026-10-18-roadmap-remaining.md) F5.5, design decision D4 ("copy and continue").

## Question

`@0furkancolak/pgcells-single` started as a copy of `@0furkancolak/pgcells`. Should the shared parts move into a third package (`@pgcells/core`) that both depend on?

## What the code looks like today

Non-test, non-generated TypeScript: `pgcells` 12,272 lines, `pgcells-single` 6,518 lines. Comparing the files that exist in both:

| Group | Files | Changed lines between the copies |
|---|---|---|
| Near-identical | drivers (`bun`, `pg`, `neon`, `postgres`), `pg-pool`, `jsonl`, `ask-secret`, SQL `tables`, `grammar`, `casing`, `auth-adapter` | under 35 each (about 1,500 lines in total) |
| Same shape, diverged | SQL `compiler`, `parser-gaps`, `codegen`, `source`, `registry`, `pull`, `tools/auth` | 50–100 changed lines each |
| Different programs | `runtime`, `database` (pool counters, drain, tenant limit, stats), `doctor`, `copy`, `backup`, `middleware`, `config` | 160–500 changed lines each |

The multi-tenant runtime moved a long way from the single-tenant one in the work of 2026-10-19 (fencing, region model, connection management); none of that belongs in the single-tenant package.

## Options

1. **Keep the copy** (status quo). Duplicated: about 1,500 near-identical lines and about 1,000 more with small drift. A fix to a driver or to the SQL compiler must be made twice.
2. **Extract `@pgcells/core`** with the near-identical group and the SQL compiler. A third published package in the fixed version group, its own build and exports map, and a stable internal API to maintain; every change to a shared file becomes a change to a published package.
3. **Merge into one package with a `single` mode.** Rejected earlier (D4): the multi-tenant surface would leak into the single-tenant one.

## Decision

**Keep the copy until v0.5.** The duplicated code is small, stable (the drivers and the grammar changed by a few lines while everything above them was rebuilt), and the cost of a wrong extraction is a public API we then have to keep. Revisit at v0.5 with these triggers; extract if any holds:

- a driver or SQL-compiler fix had to be made twice in the same month more than once;
- a second maintainer starts changing the shared files in only one of the packages;
- the near-identical group grows beyond about 2,500 lines.

If extracted, the candidates are, in order: drivers and `pg-pool`, the SQL grammar/tables/casing/compiler, `jsonl` and `ask-secret`. The runtime, management and tools stay separate.
