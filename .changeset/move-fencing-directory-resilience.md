---
"@0furkancolak/pgcells": minor
---

Fencing and directory resilience.

- `move` now has a `fenced` phase after cutover: the source schema is renamed to `tenant_x__moved_<move id>`, so a process that still routes by the old placement fails with `undefined_table` instead of silently writing to the abandoned copy. Moving a tenant back no longer needs a manual `DROP SCHEMA`. `doctor` lists the retained copies (`retained_moved_copies`) and fails on old copies that kept the tenant's own name (`unfenced_moved_copies`).
- `createManagement` rejects a `placementCacheWaitMs` below the longest placement cache (`25000`, plus `replicaMaxLagMs` when `db0` has replicas) with `INVALID_CONFIG`. `unsafePlacementCacheWait: true` opts out for throwaway environments.
- With replicas of `db0`, placement lookups use them for `active` records and confirm everything else on the primary.
- New runtime option `staleIfErrorMs` (off by default, at most 300000): while the directory is unreachable, an expired `active` placement is served for that long. New span `placement.stale`.
