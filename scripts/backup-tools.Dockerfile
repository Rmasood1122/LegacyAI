# Tools image for the backup job and the restore test: PostgreSQL 18 client tools + age.
# Small, non-root, no secrets baked in.
#   docker build -f scripts/backup-tools.Dockerfile -t legacyai-backup-tools scripts
FROM postgres:18.6-trixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends age ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh restore-test.sh /usr/local/bin/
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/restore-test.sh
# The postgres image already has an unprivileged "postgres" user (uid 999).
USER postgres
WORKDIR /tmp
ENTRYPOINT []
CMD ["backup.sh"]
