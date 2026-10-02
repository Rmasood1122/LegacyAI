# Tools image for the backup job and the restore test: PostgreSQL 18 client tools + age + curl.
# Small (no database server, no cloud SDK), non-root, no secrets baked in.
#   docker build -f scripts/backup-tools.Dockerfile -t legacyai-backup-tools scripts
FROM alpine:3.24
RUN apk add --no-cache bash coreutils curl ca-certificates age postgresql18-client \
 && adduser -D -u 10001 backup
COPY backup.sh restore-test.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore-test.sh
USER backup
WORKDIR /tmp
CMD ["backup.sh"]
