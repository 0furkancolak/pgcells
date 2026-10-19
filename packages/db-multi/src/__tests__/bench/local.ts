/** Yerel compose yığınının (packages/db-multi/compose.yaml) adresleri; hotpath.ts ve spans.ts kullanır. */
const LOCAL = "postgres://admin:local_admin_password@127.0.0.1";
/** Doğrudan PostgreSQL (postgres-0, postgres-1): yönetim işlemleri için. */
export const LOCAL_DIRECT_URLS = [`${LOCAL}:5540/app`, `${LOCAL}:5541/app`];
/** PgBouncer (transaction pooling): çalışma zamanı sorguları için. */
export const LOCAL_BOUNCER_URLS = [`${LOCAL}:5543/db0`, `${LOCAL}:5543/db1`];
