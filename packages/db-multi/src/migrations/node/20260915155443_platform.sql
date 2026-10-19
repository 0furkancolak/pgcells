--up
-- Bu DB'nin DATABASE_URLS içindeki kimliği; bootstrap ilk çalıştırmada yazar, sonra her seferinde doğrular.
CREATE TABLE node_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  database_id text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

-- Yalnızca `bun run tools move` kullanır: hedef DB'de taşıma sahipliği.
CREATE TABLE move_targets (
  tenant_id text PRIMARY KEY,
  operation_id uuid NOT NULL,
  schema_name text NOT NULL
);

--down
-- Yalnızca bilgi amaçlı: platform/node down'ı çalıştıran bir komut yoktur.
DROP TABLE move_targets, node_identity;
