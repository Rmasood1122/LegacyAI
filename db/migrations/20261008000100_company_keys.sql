-- migrate:up

-- Phase 4, Batch B step 4: bring-your-own-key (feature 21). docs/phase4/08-bring-your-own-key.md, decision D35.
--
-- A company can have its OWN encryption key, held at a key service the company controls. The API never sees that
-- key: it keeps a data key of the company's, wrapped (encrypted) by the company's key, and asks the key service to
-- unwrap it when it needs it. The company can switch its key off at its key service at any time; from then on what
-- was sealed with its data key cannot be read by anybody here - not even by the platform operator.
--
-- What is sealed this way today: the secrets the API keeps for a company (authenticator-app seeds, webhook signing
-- secrets, SSO client secrets). NOT the documents and knowledge: see the document for why and what that would take.
--
-- One row per version of the company's data key. At most one is live; switching to another key (or back to none)
-- retires the live one. Retired versions stay: what was sealed with them can still be read while the company's key
-- that wrapped them works.
--
-- (tenants.encryption_key_ref from Phase 1 stays unused: the application may not update tenant rows - migration
-- 20261002000600_hardening.sql - and the reference belongs with the wrapped key it opens.)
CREATE TABLE company_data_keys (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  version      integer NOT NULL CHECK (version BETWEEN 1 AND 100000),
  -- where the company's key is, e.g. "local:<name>" for the stand-in; a real service's key resource name later.
  -- A reference, never a key.
  key_ref      text NOT NULL CHECK (char_length(key_ref) BETWEEN 1 AND 512 AND key_ref !~ '[[:space:][:cntrl:]]'),
  -- the data key, encrypted by the company's key (nonce | tag | ciphertext)
  wrapped_key  bytea NOT NULL CHECK (octet_length(wrapped_key) BETWEEN 29 AND 4096),
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  PRIMARY KEY (tenant_id, version)
);
CREATE UNIQUE INDEX company_data_keys_one_live ON company_data_keys (tenant_id) WHERE retired_at IS NULL;

ALTER TABLE company_data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON company_data_keys USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- A version never changes; retiring it is final. No DELETE: a version that sealed something must stay to open it.
CREATE FUNCTION company_data_keys_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.version <> OLD.version OR NEW.key_ref <> OLD.key_ref
     OR NEW.wrapped_key <> OLD.wrapped_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'company_data_keys: a version of a data key cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'company_data_keys: a retired version stays retired' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION company_data_keys_guard() FROM PUBLIC;
CREATE TRIGGER company_data_keys_guard BEFORE UPDATE ON company_data_keys FOR EACH ROW EXECUTE FUNCTION company_data_keys_guard();
GRANT SELECT, INSERT, UPDATE ON company_data_keys TO legacyai_app;

-- Setting or clearing a company's key is the platform operator's (it is configured at the company's request, together
-- with the key service), never the company's own Owner's: an Owner's card is not proof of control over a key service.
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('tenant:encryption_key', 'Set or clear a company''s own encryption key (bring-your-own-key)', true, true);
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('company_owner', 'tenant:encryption_key', 'tenant', 3, 'base');
INSERT INTO audit_detail_keys (key) VALUES ('key_version');

-- migrate:down
-- Refused while any company has (or had) its own key: secrets sealed with a company's data key could not be opened
-- once the wrapped keys were gone. Clearing a company's key does not undo that (retired versions still open old
-- secrets); the secrets must be sealed again with the platform's key first, which is not built (see the document).
DO $$
BEGIN
  ALTER TABLE company_data_keys NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM company_data_keys) THEN
    RAISE EXCEPTION 'cannot roll back bring-your-own-key: % compan(y/ies) have data keys; secrets sealed with them would become unreadable',
      (SELECT count(DISTINCT tenant_id) FROM company_data_keys);
  END IF;
END
$$;
DELETE FROM audit_detail_keys WHERE key = 'key_version';
DELETE FROM role_permissions WHERE permission_key = 'tenant:encryption_key';
DELETE FROM permissions WHERE permission_key = 'tenant:encryption_key';
DROP TABLE company_data_keys;
DROP FUNCTION company_data_keys_guard();
