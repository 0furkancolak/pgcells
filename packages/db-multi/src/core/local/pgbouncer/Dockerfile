# Alpine release picks the PgBouncer version: 3.19 -> 1.21, 3.21 -> 1.23, 3.22 -> 1.24 (the CI version matrix builds each).
ARG ALPINE=3.22
FROM alpine:${ALPINE}
RUN apk add --no-cache pgbouncer && adduser -D -H pooler
USER pooler
ENTRYPOINT ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
