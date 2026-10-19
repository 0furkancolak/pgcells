# SQL compiler

Application SQL (`src/queries/*.sql`, migrations and seeds) is compiled once during `bun run db:codegen`; the runtime entry (`src/index.ts`) never loads the parser. Usage: [docs/queries.md](../../../docs/queries.md), [docs/migrations-and-seeds.md](../../../docs/migrations-and-seeds.md).

## What compilation does

1. **Parsing**: the source is parsed once with the pinned `pgsql-ast-parser@12.0.2`. Comments are first masked with spaces of the same length (positions are preserved). The few clauses the parser does not recognize (`ALTER COLUMN … TYPE … USING`, `UNIQUE NULLS NOT DISTINCT`, `ALTER TYPE … ADD VALUE IF NOT EXISTS/BEFORE/AFTER`, `INTERSECT`/`EXCEPT`, `IS [NOT] DISTINCT FROM`, `GROUPING SETS`, strict window frames, `WITH RECURSIVE`) are hidden in `parser-gaps.ts` only in the parser's copy and, after parsing, attached to the AST node exactly adjacent to them; a clause that cannot be attached is rejected. The generated SQL is always the original source.
2. **Validation**: `grammar.ts` lists the allowed fields, types, functions and operators for every AST node type; `compiler.ts` enforces the semantic rules (scope, CTE resolution, lock clause, the `DROP … CASCADE` rule). Unknown nodes or fields, schema-qualified names, extension types/functions, dollar-quoting and `U&` quoting are rejected with `SQL_UNSUPPORTED`. `grammar.ts` is the single authoritative list of the supported subset.
3. **Splitting into parts**: a schema insertion point is recorded for every real table/DML target/FK target/enum name; built-in types and functions are qualified with `pg_catalog` (except a bare `INTERVAL`). `casing.ts` turns the outermost output names into camelCase aliases; `*` is expanded only when a column name changes, using the column list folded from the migrations (`tables.ts`).
4. **Binding**: `bind(schema)` only validates the schema name and joins the immutable parts; there is no AST walk, session setting or cache. Values are always `$n` parameters.

The result (`PreparedQuery`) is immutable and carries the `readOnly` (lock-free, non-modifying) and `requiresTransaction` (`FOR UPDATE …`) flags. Migration sections are compiled as multi-statement input with `prepareMigration` and also yield the parsed `statements` (the registry's CONCURRENTLY index handling and codegen's table types are derived from them). Source schema prefixes in `pull` output are removed at the AST position by `unqualifyMigration`, then normal compilation runs.

## Boundary

The compiler is for trusted application code and does not accept SQL from a client. Authorization, view/trigger bodies and PostgreSQL's own semantic checks (missing column, type mismatch) are out of scope. Connections must use `standard_conforming_strings=on` (the default).

## Extending

For new syntax: add the field/function/operator to `grammar.ts`; for every new name that carries a schema, write an insertion point and a scope rule in `compiler.ts`; add acceptance and rejection tests (`sql*.test.ts`) in the same change. Upgrading the parser version requires the same review (new AST fields, source positions). Existing migration files are not edited for the new grammar; a new migration is added.
