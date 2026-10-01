-- Creates the three database roles LegacyAI uses. Safe to run more than once.
--
-- Run as a superuser (local Docker) or as the Neon console role, AFTER setting
-- three custom settings in the same session (scripts/db-roles.mjs does this):
--   SELECT set_config('legacyai.migrator_password', '...', false);
--   SELECT set_config('legacyai.app_password', '...', false);
--   SELECT set_config('legacyai.backup_password', '...', false);
-- Passwords never appear in this file. A missing or short password aborts the script.
--
--   legacyai_migrator  owns all tables; runs migrations. Never used by the running API.
--   legacyai_app       the running API. No superuser, no BYPASSRLS, per-table grants only.
--   legacyai_backup    read-only, BYPASSRLS, for nightly pg_dump (a backup must see every tenant).

DO $$
DECLARE
  r text;
  pw text;
BEGIN
  FOREACH r IN ARRAY ARRAY['migrator', 'app', 'backup'] LOOP
    pw := current_setting('legacyai.' || r || '_password', true);
    IF pw IS NULL OR length(pw) < 16 THEN
      RAISE EXCEPTION 'legacyai.%_password is missing or shorter than 16 characters', r;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacyai_' || r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', 'legacyai_' || r);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
      'legacyai_' || r, pw);
  END LOOP;
END
$$;

ALTER ROLE legacyai_migrator NOBYPASSRLS;
ALTER ROLE legacyai_app NOBYPASSRLS;

-- The backup role must read every tenant's rows. If the role running this script
-- cannot grant BYPASSRLS, the script stops here: a backup that silently skips rows
-- is worse than no backup.
ALTER ROLE legacyai_backup BYPASSRLS;
GRANT pg_read_all_data TO legacyai_backup;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO legacyai_migrator, legacyai_app, legacyai_backup', current_database());
  EXECUTE format('GRANT CREATE ON DATABASE %I TO legacyai_migrator', current_database());
END
$$;

GRANT USAGE, CREATE ON SCHEMA public TO legacyai_migrator;
GRANT USAGE ON SCHEMA public TO legacyai_app, legacyai_backup;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
