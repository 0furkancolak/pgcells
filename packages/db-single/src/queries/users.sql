-- name: findUserById
SELECT * FROM users WHERE id = $1::uuid

-- name: findUserByEmail
SELECT * FROM users WHERE email = $1::text

-- name: findUsers
SELECT * FROM users ORDER BY created_at, id LIMIT $1::integer OFFSET $2::integer

-- name: createUser
INSERT INTO users (name, email) VALUES ($1::text, $2::text) RETURNING *

-- name: deleteUser
DELETE FROM users WHERE id = $1::uuid RETURNING id
