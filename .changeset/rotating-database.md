---
"@0furkancolak/pgcells": minor
---

Add `createRotatingDatabase`: a `Database` whose pools can be replaced with `rotate()` (new credentials or node list) without a restart; the candidate must pass `ready()` before it takes over.
