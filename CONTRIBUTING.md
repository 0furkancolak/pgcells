# Contributing to pgcells

Thank you for helping. This file explains how to set up the repository, what a good change looks like, and the few rules that exist because the code runs against production databases.

## Setup

```sh
bun install                                   # Bun >= 1.3.14 (see .bun-version)
cd packages/db-multi
cp .env.example .env
docker compose up -d --wait                   # 2 PostgreSQL + PgBouncer (+ a streaming replica pair for replica tests)
```

Node 22 is needed only for the packaging checks (`bash scripts/smoke-pack.sh`).

## Checks

Run what CI runs, from the package you changed:

```sh
bun run codegen --check && bun run typecheck && bun run lint
bun test --timeout 60000 src/__tests__/unit
RUN_INTEGRATION=1 bun test --timeout 60000 --preload ./src/__tests__/integration/leak-guard.ts src/__tests__/integration   # needs Docker
```

(`db-single` uses `bun run db:codegen --check`.) From the repository root: `bash scripts/check-no-legacy-scope.sh`, `bash scripts/check-wording.sh`, `bash scripts/check-english.sh` (comments and docs stay English), `bun scripts/check-doc-links.ts`, `bash scripts/smoke-pack.sh`. Unit tests that spawn the CLI can exceed Bun's 5 s default on slow disks; use `--timeout 60000`.

## Rules that are not negotiable

- **Never edit an applied migration or seed.** The ledger stores a SHA-256 of every file; changing one byte (including a comment) makes `bootstrap`/`migrate-all` fail with `MIGRATION_DRIFT`/`SEED_DRIFT` on existing installations. Add a new migration instead. `frozen-identifiers.test.ts` enforces this, along with the persisted strings it lists (derived-secret salt, pull marker, advisory-lock keys, error codes).
- **Create migrations and seeds only with the CLI** (`bun run db:generate:tenant|platform|node`, `db:generate:seed`), so IDs are real UTC timestamps.
- **No `search_path`**, in any form. The schema is bound into the SQL at compile time.
- **No new environment variables.** Configuration is typed options, `DATABASE_URLS` and the optional `DATABASE_REPLICA_URLS`.
- **No SQL parsing at runtime.** `pgsql-ast-parser` is used by codegen only.
- **Explicit targets, no hidden retries.** Every call names its target (tenant, node, platform; primary or replica). Do not add per-query retries or implicit routing.
- **`db-multi` and `db-single` are independent copies by design.** A fix to shared code (SQL compiler, drivers, deadline logic) is made in both.

## Pull requests

1. Open an issue first for anything larger than a small fix.
2. Write the failing test first, watch it fail, then implement.
3. Add a changeset (`bun run changeset`) for changes to a published package.
4. Keep the diff focused; update the docs in `packages/*/docs` and, for architecture changes, `docs/guides`.
5. Sign off your commits (`git commit -s`): you certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Reporting security problems

Do not open a public issue; see [SECURITY.md](SECURITY.md).
