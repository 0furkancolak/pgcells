--up
-- Better Auth 1.7.5 tabloları: kullanıcı, oturum, hesap, doğrulama, 2FA ve veritabanı rate limit'i. Sütunlar snake_case, kimlikler veritabanında
-- üretilen uuid. Better Auth eşlemesi `authTables()` / `twoFactorTables()` / `rateLimitTable()` (`@repo/db-single/auth`).
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  email varchar NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image varchar,
  two_factor_enabled boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT session_token_unique UNIQUE (token)
);

CREATE TABLE account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE two_factor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);

-- `rateLimit.storage: "database"`: `key` tekildir (Better Auth eşzamanlı ilk isteği çakışmadan ayırt eder); `last_request` epoch
-- milisaniyesidir, süresi geçen satırlar ona göre silinir.
CREATE TABLE rate_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL,
  CONSTRAINT rate_limit_key_unique UNIQUE (key)
);

-- Better Auth'un `index: true` işaretlediği alanlar (`getSchema`); `rate_limit.last_request` süresi geçen satırların temizliği içindir.
CREATE INDEX session_user_id_idx ON session (user_id);
CREATE INDEX account_user_id_idx ON account (user_id);
CREATE INDEX verification_identifier_idx ON verification (identifier);
CREATE INDEX two_factor_secret_idx ON two_factor (secret);
CREATE INDEX two_factor_user_id_idx ON two_factor (user_id);
CREATE INDEX rate_limit_last_request_idx ON rate_limit (last_request);
--down
DROP TABLE rate_limit;
DROP TABLE two_factor;
DROP TABLE verification;
DROP TABLE account;
DROP TABLE session;
DROP TABLE users;
