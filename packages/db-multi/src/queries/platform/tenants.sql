-- name: listTenants
SELECT tenant_id, kind, status FROM placements ORDER BY tenant_id LIMIT $1 OFFSET $2
