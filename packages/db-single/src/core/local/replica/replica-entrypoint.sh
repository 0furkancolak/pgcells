#!/bin/sh
# Local replica testing only: on first start takes a base backup from the primary, then starts as a standby. To trigger the conflict test,
# the standby delay is kept short (fixed default, no environment variable).
set -e
export PGPASSWORD=local_admin_password
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  su-exec postgres pg_basebackup -h postgres-rp -U admin -D "$PGDATA" -R -X stream
fi
exec docker-entrypoint.sh postgres -c hot_standby=on -c max_standby_streaming_delay=1s -c hot_standby_feedback=off
