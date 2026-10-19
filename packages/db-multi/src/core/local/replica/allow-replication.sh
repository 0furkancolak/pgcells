#!/bin/sh
# Local replica testing only: lets the replica container run pg_basebackup against the primary.
echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
