-- Creates the four database roles LegacyAI uses. Safe to run more than once.
--
-- Run as a superuser (local Docker) or as the Neon console role, AFTER setting
-- three custom settings in the same session (scripts/db-setup.mjs does this):
--   SELECT set_config('legacyai.migrator_password', '...', false);
--   SELECT set_config('legacyai.app_password', '...', false);
--   SELECT set_config('legacyai.backup_password', '...', false);
--   SELECT set_config('legacyai.ai_password', '...', false);
-- Passwords never appear in this file. A missing or short password aborts the script.
--
--   legacyai_migrator  owns all tables; runs migrations. Never used by the running API.
--   legacyai_app       the running API. No superuser, no BYPASSRLS, per-table grants only.
--   legacyai_backup    read-only, BYPASSRLS, for nightly pg_dump (a backup must see every tenant).
--   legacyai_ai        the Python service (Phase 2). No superuser, no BYPASSRLS, per-table grants only.

DO $$
DECLARE
  r text;
  pw text;
BEGIN
  FOREACH r IN ARRAY ARRAY['migrator', 'app', 'backup', 'ai'] LOOP
    pw := current_setting('legacyai.' || r || '_password', true);
    IF pw IS NULL OR length(pw) < 16 THEN
      RAISE EXCEPTION 'legacyai.%_password is missing or shorter than 16 characters', r;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacyai_' || r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', 'legacyai_' || r);
    END IF;
    -- SUPERUSER / REPLICATION are deliberately not mentioned: on PostgreSQL 16+ a non-superuser
    -- (such as the Neon console role) may not name those attributes at all. New roles never
    -- have them; the check at the end of this script proves it.
    EXECUTE format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L', 'legacyai_' || r, pw);
  END LOOP;
END
$$;

ALTER ROLE legacyai_migrator NOBYPASSRLS;
ALTER ROLE legacyai_app NOBYPASSRLS;
ALTER ROLE legacyai_ai NOBYPASSRLS;

-- The backup role must read every tenant's rows. If the role running this script
-- cannot grant BYPASSRLS, the script stops here: a backup that silently skips rows
-- is worse than no backup.
ALTER ROLE legacyai_backup BYPASSRLS;
GRANT pg_read_all_data TO legacyai_backup;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO legacyai_migrator, legacyai_app, legacyai_backup, legacyai_ai', current_database());
  -- Temporary tables could be used to shadow real tables inside SECURITY DEFINER functions.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

GRANT USAGE, CREATE ON SCHEMA public TO legacyai_migrator;
GRANT USAGE ON SCHEMA public TO legacyai_app, legacyai_backup, legacyai_ai;

-- pgvector (Phase 2). Created here, by the setup role, because the migration role may not create
-- extensions. On Neon this is the console role; whether that works without further steps is UNVERIFIED.
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Final check: stop loudly if any of the roles ended up with more power than intended.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
   WHERE rolname IN ('legacyai_migrator', 'legacyai_app', 'legacyai_backup', 'legacyai_ai') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'these roles have privileges they must not have: %', bad; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('legacyai_migrator', 'legacyai_app', 'legacyai_ai') AND rolbypassrls) THEN
    RAISE EXCEPTION 'legacyai_migrator / legacyai_app / legacyai_ai must not be able to bypass row-level security';
  END IF;
END
$$;
