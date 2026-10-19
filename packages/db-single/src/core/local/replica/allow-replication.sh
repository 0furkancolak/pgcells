#!/bin/sh
# Local replica testing only: lets the replica container take a pg_basebackup from the primary.
echo "host replication all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
