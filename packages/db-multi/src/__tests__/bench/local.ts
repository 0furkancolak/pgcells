/** Addresses of the local compose stack (packages/db-multi/compose.yaml); used by hotpath.ts and spans.ts. */
const LOCAL = "postgres://admin:local_admin_password@127.0.0.1";
/** Direct PostgreSQL (postgres-0, postgres-1): for management operations. */
export const LOCAL_DIRECT_URLS = [`${LOCAL}:5540/app`, `${LOCAL}:5541/app`];
/** PgBouncer (transaction pooling): for runtime queries. */
export const LOCAL_BOUNCER_URLS = [`${LOCAL}:5543/db0`, `${LOCAL}:5543/db1`];
