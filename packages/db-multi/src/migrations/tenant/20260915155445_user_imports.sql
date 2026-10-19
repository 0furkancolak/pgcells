--up
-- Başka uygulama/DB'den aktarılan kullanıcıların eşlemesi: aynı kaynak + dış ID tekrar aktarılınca yeni kullanıcı açılmaz;
-- ilişkili verileri taşırken eski ID'den yeni kullanıcıya bu tablo üzerinden gidilir.
CREATE TABLE user_imports (
  -- Biçim (`[a-z0-9][a-z0-9_.-]*`) aktarım aracında doğrulanır.
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 63),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  checksum text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);

CREATE INDEX user_imports_user_id_idx ON user_imports (user_id);

--down
DROP TABLE user_imports;
