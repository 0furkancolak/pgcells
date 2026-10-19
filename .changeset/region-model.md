---
"@0furkancolak/pgcells": minor
---

Region model.

- Databases can carry a `region`, a `residency_zone` and labels (`tools database set db1 --region eu-west --zone eu --label tier=gold`); an additive platform migration adds the columns and a `replicas` table. Everything is optional: a database with none behaves as before. `Placement` gains `residencyZone` and `region`.
- Placement requests: `provision`/`restore` take `--region`, `--zone`, `--label`; automatic choice narrows to matching databases (`NO_CAPACITY` names the request). A database labelled `dedicated=true` is skipped by automatic choice unless asked for.
- Residency: a tenant is bound to a zone (requested, else its database's). `provision`, `restore`, `move` and `adopt` refuse a target outside it with `RESIDENCY_VIOLATION`, checked in the transaction that writes the placement; `database set --zone` refuses to strand a bound tenant; backups record the zone. A move to another region needs `--allow-cross-region` (`CROSS_REGION_MOVE`).
- `createDatabase({ region, onWrongRegion })`: a tenant of another region is refused with `WRONG_REGION`; `regionGuard` answers 421 or 307 before the route runs; `RequestDb` exposes `placement()` and `region`.
- Replica locality: a regional application reads only from replicas in its own region (`tools replica set db1#2 --region …`); the replica report shows each replica's region.
- `doctor`: `directory_pii`, `app_region` (`--app-region`) and `replica_region`.
- Test stack `compose.regions.yaml` (two simulated regions with injected latency) and a CI job for it.
