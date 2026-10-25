-- migrate:up

-- Decision D41, step 4b (part 1: keys). docs/phase4/10-content-under-company-key.md.
--
-- Every company's content will be sealed with a content key derived from a data key of the company's:
--   - a company that brought its own key (bring-your-own-key, D35/D40): its live data key in company_data_keys,
--     wrapped by the company's key. The AI service now reads those rows too and unwraps them itself, with its own
--     service account (the company grants the role to both services' accounts);
--   - every other company: a data key of its own in content_data_keys (below), wrapped by the PLATFORM's content key
--     (a Cloud KMS key in the platform's project, the founder's choice of 2026-10-25). The AI service makes it the
--     first time it needs one.
-- Rows here hold wrapped keys only, never a key in readable form.
CREATE TABLE content_data_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  version      integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  -- where the platform's content key is ("local:<name>" for the stand-in, a Cloud KMS key name in production)
  key_ref      text NOT NULL CHECK (char_length(key_ref) BETWEEN 1 AND 512 AND key_ref !~ '[[:space:][:cntrl:]]'),
  -- the data key, encrypted by the platform's content key
  wrapped_key  bytea NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 29 AND 4096),
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  PRIMARY KEY (tenant_id, version)
);
CREATE UNIQUE INDEX content_data_keys_one_live ON content_data_keys (tenant_id) WHERE retired_at IS NULL;

ALTER TABLE content_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_data_keys USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- A version never changes; retiring it is final. No DELETE: a version that sealed something must stay to open it.
CREATE FUNCTION content_data_keys_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version OR NEW.key_ref <> OLD.key_ref
     OR NEW.wrapped_key <> OLD.wrapped_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'content_data_keys: a version of a data key cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'content_data_keys: a retired version stays retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION content_data_keys_guard() FROM PUBLIC;
CREATE TRIGGER content_data_keys_guard BEFORE UPDATE ON content_data_keys FOR EACH ROW EXECUTE FUNCTION content_data_keys_guard();

GRANT SELECT, INSERT, UPDATE ON content_data_keys TO legacyai_ai;
-- the AI service unwraps a company's own data key itself (read only; only the API sets or clears a company's key)
GRANT SELECT ON company_data_keys TO legacyai_ai;

-- migrate:down
-- Refused once any company has a content data key: what was sealed with it could not be opened without it.
DO $$
BEGIN
  ALTER TABLE content_data_keys NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM content_data_keys) THEN
    RAISE EXCEPTION 'cannot roll back content keys: % compan(y/ies) have content data keys; content sealed with them would become unreadable',
      (SELECT count(DISTINCT tenant_id) FROM content_data_keys);
  END IF;
END
$$;
REVOKE SELECT ON company_data_keys FROM legacyai_ai;
DROP TABLE content_data_keys;
DROP FUNCTION content_data_keys_guard();
