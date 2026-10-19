FROM alpine:3.22
RUN apk add --no-cache pgbouncer && adduser -D -H pooler
USER pooler
ENTRYPOINT ["pgbouncer", "/etc/pgbouncer/pgbouncer.ini"]
