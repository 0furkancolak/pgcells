--up
CREATE TABLE tenants (
  tenant_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- DATABASE_URLS sırasından türeyen DB kimlikleri (db0, db1 …); yalnızca eklenir.
CREATE TABLE nodes (
  database_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE placements (
  tenant_id text PRIMARY KEY REFERENCES tenants (tenant_id),
  database_id text NOT NULL REFERENCES nodes (database_id),
  -- demo: `demo_…` schema'sı, demo seed'leri ve `demo-reset`; schema adı önekini belirler.
  kind text NOT NULL DEFAULT 'tenant' CHECK (kind IN ('tenant', 'demo')),
  schema_name text NOT NULL UNIQUE,
  status text NOT NULL,
  schema_version integer NOT NULL DEFAULT 0,
  placement_version integer NOT NULL DEFAULT 1,
  move_operation_id uuid
);

-- listPage sırası: database_id + tenant_id COLLATE "C".
CREATE INDEX placements_database_tenant_c_idx ON placements (database_id, tenant_id COLLATE "C");

CREATE TABLE migration_runner (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  run_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

-- Yalnızca `bun run tools move` kullanır.
CREATE TABLE moves (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  target_database_id text NOT NULL,
  source jsonb NOT NULL,
  owner_id uuid,
  status text NOT NULL CHECK (status IN ('running', 'failed', 'completed', 'rolled-back')),
  phase text NOT NULL DEFAULT 'planned',
  fingerprint text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--down
-- Yalnızca bilgi amaçlı: platform/node down'ı çalıştıran bir komut yoktur.
DROP TABLE moves, migration_runner, placements, nodes, tenants;
