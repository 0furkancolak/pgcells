--up
-- Platform kapsamlı Better Auth (`createPlatformAuth`, ör. jamaster `panel`) tabloları, db0'ın `platform` schema'sında: tenant
-- `user` türüyle aynı düzen (`authTables("user")`, `twoFactorTables("user")`, `rateLimitTable("user")`), kimlikler veritabanında
-- üretilen uuid. jamaster geçişinde bu migration silinir: panel tabloları `platform-move` ile gelir (docs/jamaster-migration.md).
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

CREATE TABLE rate_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  count integer NOT NULL,
  last_request bigint NOT NULL,
  CONSTRAINT rate_limit_key_unique UNIQUE (key)
);

CREATE INDEX session_user_id_idx ON session (user_id);
CREATE INDEX account_user_id_idx ON account (user_id);
CREATE INDEX verification_identifier_idx ON verification (identifier);
CREATE INDEX two_factor_secret_idx ON two_factor (secret);
CREATE INDEX two_factor_user_id_idx ON two_factor (user_id);
CREATE INDEX rate_limit_last_request_idx ON rate_limit (last_request);

--down
DROP TABLE rate_limit, two_factor, verification, account, session, users;
