--up
-- Yer seçimi yalnızca `active` DB'lere yeni tenant koyar; `draining` mevcut tenant'ları tutar, yenisini almaz.
-- Kapasite, üzerindeki tenant boyutlarının (1–100) toplamının üst sınırıdır.
ALTER TABLE nodes
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draining')),
  ADD COLUMN capacity integer NOT NULL DEFAULT 1000 CHECK (capacity BETWEEN 1 AND 1000000);

-- Tenant'ın tahmini yükü: 1 (küçük) … 100 (en büyük). Yer seçimi DB başına toplamı kapasiteye oranlar.
ALTER TABLE placements ADD COLUMN size smallint NOT NULL DEFAULT 1 CHECK (size BETWEEN 1 AND 100);

-- Tenant olarak hiçbir zaman verilmeyecek alt alan adları (güvenlik ve altyapı adları).
CREATE TABLE reserved_tenant_ids (
  tenant_id text PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO reserved_tenant_ids (tenant_id, reason) VALUES
  ('www', 'infrastructure'), ('api', 'infrastructure'), ('app', 'infrastructure'), ('apps', 'infrastructure'),
  ('cdn', 'infrastructure'), ('static', 'infrastructure'), ('assets', 'infrastructure'), ('media', 'infrastructure'),
  ('files', 'infrastructure'), ('img', 'infrastructure'), ('images', 'infrastructure'), ('upload', 'infrastructure'),
  ('uploads', 'infrastructure'), ('download', 'infrastructure'), ('ws', 'infrastructure'), ('wss', 'infrastructure'),
  ('dns', 'infrastructure'), ('ns1', 'infrastructure'), ('ns2', 'infrastructure'), ('mx', 'infrastructure'),
  ('mail', 'infrastructure'), ('email', 'infrastructure'), ('smtp', 'infrastructure'), ('imap', 'infrastructure'),
  ('pop', 'infrastructure'), ('pop3', 'infrastructure'), ('ftp', 'infrastructure'), ('sftp', 'infrastructure'),
  ('ssh', 'infrastructure'), ('vpn', 'infrastructure'), ('proxy', 'infrastructure'), ('gateway', 'infrastructure'),
  ('db', 'infrastructure'), ('database', 'infrastructure'), ('redis', 'infrastructure'), ('queue', 'infrastructure'),
  ('cron', 'infrastructure'), ('worker', 'infrastructure'), ('workers', 'infrastructure'), ('internal', 'infrastructure'),
  ('localhost', 'infrastructure'), ('dev', 'environment'), ('development', 'environment'), ('stage', 'environment'),
  ('staging', 'environment'), ('test', 'environment'), ('testing', 'environment'), ('qa', 'environment'),
  ('uat', 'environment'), ('preview', 'environment'), ('sandbox', 'environment'), ('prod', 'environment'),
  ('production', 'environment'), ('demo', 'environment'), ('beta', 'environment'), ('alpha', 'environment'),
  ('admin', 'security'), ('administrator', 'security'), ('root', 'security'), ('system', 'security'),
  ('sysadmin', 'security'), ('superuser', 'security'), ('owner', 'security'), ('staff', 'security'),
  ('auth', 'security'), ('login', 'security'), ('logout', 'security'), ('signin', 'security'), ('signup', 'security'),
  ('register', 'security'), ('sso', 'security'), ('oauth', 'security'), ('openid', 'security'), ('saml', 'security'),
  ('account', 'security'), ('accounts', 'security'), ('id', 'security'), ('identity', 'security'),
  ('password', 'security'), ('reset', 'security'), ('verify', 'security'), ('security', 'security'),
  ('secure', 'security'), ('webmail', 'security'), ('autodiscover', 'security'), ('autoconfig', 'security'),
  ('billing', 'security'), ('pay', 'security'), ('payment', 'security'), ('payments', 'security'),
  ('checkout', 'security'), ('invoice', 'security'), ('platform', 'product'), ('dashboard', 'product'),
  ('console', 'product'), ('panel', 'product'), ('portal', 'product'), ('manage', 'product'), ('support', 'product'),
  ('help', 'product'), ('docs', 'product'), ('status', 'product'), ('blog', 'product'), ('news', 'product'),
  ('about', 'product'), ('contact', 'product'), ('legal', 'product'), ('terms', 'product'), ('privacy', 'product'),
  ('public', 'postgres'), ('information-schema', 'postgres'), ('pg-catalog', 'postgres'), ('tenant', 'product'),
  ('tenants', 'product');

--down
-- Yalnızca bilgi amaçlı: platform/node down'ı çalıştıran bir komut yoktur.
DROP TABLE reserved_tenant_ids;
ALTER TABLE placements DROP COLUMN size;
ALTER TABLE nodes DROP COLUMN capacity, DROP COLUMN status;
