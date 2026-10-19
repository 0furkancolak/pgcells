--up
-- Region model. A node (cell) can say where it lives (`region`, e.g. eu-west), which residency zone it belongs to (`residency_zone`, e.g. eu) and carry free labels
-- (`labels`, e.g. {"dedicated": "true"}). All of it is optional: a database with no region behaves exactly as before.
ALTER TABLE nodes
  ADD COLUMN region text CHECK (region ~ '^[a-z][a-z0-9-]{0,62}$'),
  ADD COLUMN residency_zone text CHECK (residency_zone ~ '^[a-z][a-z0-9-]{0,62}$'),
  ADD COLUMN labels jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (labels::text LIKE '{%');

-- The residency zone a tenant is bound to; empty means unrestricted. Set when the tenant is created (from the request, or from the node's zone) and checked by
-- every operation that places tenant data (provision, restore, move, adopt).
ALTER TABLE placements ADD COLUMN residency_zone text CHECK (residency_zone ~ '^[a-z][a-z0-9-]{0,62}$');

-- Where a node's read replicas live. `ordinal` is the replica's 1-based position in DATABASE_REPLICA_URLS for that node (db1#2). A replica without a row is taken to live
-- in its node's region.
CREATE TABLE replicas (
  database_id text NOT NULL REFERENCES nodes (database_id),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  region text NOT NULL CHECK (region ~ '^[a-z][a-z0-9-]{0,62}$'),
  PRIMARY KEY (database_id, ordinal)
);

--down
-- Informational only: no command runs platform/node down sections.
DROP TABLE replicas;
ALTER TABLE placements DROP COLUMN residency_zone;
ALTER TABLE nodes DROP COLUMN labels, DROP COLUMN residency_zone, DROP COLUMN region;
