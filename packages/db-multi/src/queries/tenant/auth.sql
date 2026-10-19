-- name: createPasswordUser
WITH created AS (
  INSERT INTO users (name, email, email_verified) VALUES ($1::text, $2::text, true) RETURNING id
)
INSERT INTO account (account_id, provider_id, user_id, password)
SELECT id::text, 'credential', id, $3::text FROM created
RETURNING user_id::text AS user_id
