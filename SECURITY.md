# Security policy

## Supported versions

pgcells is pre-1.0. Security fixes are made on the latest `0.x` release only.

| Version | Supported |
|---|---|
| latest `0.x` | yes |
| older | no |

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue or pull request for a suspected vulnerability.

Include what you found, the affected package and version, steps or a proof of concept, and the impact you expect. You should receive an acknowledgement within 7 days. We aim to confirm the issue, agree on a disclosure date and publish a fix and an advisory together; credit is given unless you prefer otherwise.

## Scope

In scope: the published packages (`@0furkancolak/pgcells`, `@0furkancolak/pgcells-single`, `@0furkancolak/pgcells-redis`) and the CLI: tenant isolation bypasses, SQL injection through identifiers or values, credential or URL leakage in output, cross-tenant session/cookie confusion in the auth adapter, unsafe handling of backups and dumps.

Out of scope: vulnerabilities in PostgreSQL, PgBouncer, Redis or other third-party services themselves, and misconfiguration described in the documentation as unsupported (for example a runtime connected to PostgreSQL without a transaction pooler).

Note that tenant isolation in pgcells is **application-level routing**: the runtime and management share one database credential that can reach every tenant schema ([tenants.md](packages/db-multi/docs/tenants.md#what-isolation-does-and-does-not-guarantee)). Physical isolation requires separate cells or databases with separate credentials.
