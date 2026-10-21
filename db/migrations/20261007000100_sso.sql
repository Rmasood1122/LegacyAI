-- migrate:up

-- Phase 4, Batch B: sign-in through the company's identity provider (feature 16, part A: SSO with OpenID Connect).
-- docs/phase4/07-sso-scim.md, decision D33.
--
-- THE RULE FROM PHASE 1 HOLDS: a sign-in at the company's identity provider counts as the STRONG FACTOR - like a
-- passkey or an authenticator-app code. It never replaces the card or its 3-digit code. A person who signs in
-- with SSO still types their card number and their code.
--
-- Phase 1 left a design-only table `sso_connections` (empty, no privileges, never read). It is replaced here; the
-- rollback puts it back exactly.
DROP TABLE sso_connections;

-- 1. A company's identity provider. One live connection per company. The client secret has to be sent to the
--    provider again at every sign-in, so it is stored ENCRYPTED with the credential keyring (bound to the company
--    and the connection), never hashed and never shown again. The issuer never changes: another provider is
--    another connection (the people linked to the old one must link again).
CREATE TABLE sso_connections (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  protocol           text NOT NULL DEFAULT 'oidc' CHECK (protocol = 'oidc'),
  issuer             text NOT NULL CHECK (issuer ~ '^https://' AND char_length(issuer) BETWEEN 9 AND 2048),
  client_id          text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 255),
  client_secret_enc  bytea,
  secret_key_id      text,
  enabled            boolean NOT NULL DEFAULT false,
  created_by_card_id uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((client_secret_enc IS NULL) = (secret_key_id IS NULL)),
  CHECK (removed_at IS NULL OR (client_secret_enc IS NULL AND NOT enabled)),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id)
);
CREATE UNIQUE INDEX sso_connections_one_live ON sso_connections (tenant_id) WHERE removed_at IS NULL;

CREATE FUNCTION sso_connections_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.issuer <> OLD.issuer OR NEW.protocol <> OLD.protocol
     OR NEW.created_by_card_id <> OLD.created_by_card_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'sso_connections: the provider of a connection cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL AND (NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'sso_connections: a removed connection stays removed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sso_connections_guard() FROM PUBLIC;
CREATE TRIGGER sso_connections_guard BEFORE UPDATE ON sso_connections FOR EACH ROW EXECUTE FUNCTION sso_connections_guard();

ALTER TABLE sso_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_connections USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON sso_connections TO legacyai_app;

-- 2. "Sign in with your company" starts BEFORE anyone is known: the person names their company (its short name,
--    which is not secret) and the sign-in goes to that company's provider. This function answers ONLY whether that
--    company has a connection that is switched on, and which - never anything about a card. Deciding by the
--    company and not by the card means the answer cannot reveal whether a card number exists.
CREATE FUNCTION resolve_sso_company(p_slug text) RETURNS TABLE (tenant_id uuid, connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.id, c.id FROM tenants t JOIN sso_connections c ON c.tenant_id = t.id
   WHERE t.slug = p_slug AND t.status = 'active' AND NOT t.is_platform AND c.enabled AND c.removed_at IS NULL
$$;
REVOKE ALL ON FUNCTION resolve_sso_company(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_sso_company(text) TO legacyai_app;

-- 3. The SSO factor of a card: the identity at the provider (its `sub`, which the provider promises never to reuse)
--    linked to one card, through one connection. Linked only during the card's set-up (enrollment token + 3-digit
--    code), never by matching an e-mail address. One identity opens at most one live card of the company.
ALTER TABLE credentials DROP CONSTRAINT credentials_type_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_type_check CHECK (type IN ('passkey', 'totp', 'sso'));
ALTER TABLE credentials ADD COLUMN sso_connection_id uuid, ADD COLUMN sso_subject text CHECK (sso_subject IS NULL OR char_length(sso_subject) BETWEEN 1 AND 255);
ALTER TABLE credentials ADD CONSTRAINT credentials_sso_connection_fk FOREIGN KEY (tenant_id, sso_connection_id) REFERENCES sso_connections (tenant_id, id);
ALTER TABLE credentials DROP CONSTRAINT credentials_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_check CHECK (
  (type = 'passkey' AND webauthn_credential_id IS NOT NULL AND webauthn_public_key IS NOT NULL
     AND totp_secret_enc IS NULL AND totp_key_id IS NULL AND sso_connection_id IS NULL AND sso_subject IS NULL)
  OR
  (type = 'totp' AND totp_secret_enc IS NOT NULL AND totp_key_id IS NOT NULL
     AND webauthn_credential_id IS NULL AND webauthn_public_key IS NULL AND sso_connection_id IS NULL AND sso_subject IS NULL)
  OR
  (type = 'sso' AND sso_connection_id IS NOT NULL AND sso_subject IS NOT NULL
     AND webauthn_credential_id IS NULL AND webauthn_public_key IS NULL AND totp_secret_enc IS NULL AND totp_key_id IS NULL)
);
CREATE UNIQUE INDEX credentials_sso_identity ON credentials (tenant_id, sso_connection_id, sso_subject) WHERE type = 'sso' AND status = 'active';

-- 4. A company may allow the SSO factor (Owner's choice in the settings; off by default).
ALTER TABLE tenant_settings DROP CONSTRAINT tenant_settings_allowed_factor_types_check;
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_allowed_factor_types_check
  CHECK (allowed_factor_types <@ ARRAY['passkey', 'totp', 'sso'] AND cardinality(allowed_factor_types) >= 1);

-- 5. A sign-in at the provider is a short-lived step of its own, held like the other sign-in steps
--    (auth_transactions: single use, expires, removed by housekeeping): purpose 'sso'.
ALTER TABLE auth_transactions DROP CONSTRAINT auth_transactions_purpose_check;
ALTER TABLE auth_transactions ADD CONSTRAINT auth_transactions_purpose_check CHECK (purpose IN ('login', 'enroll', 'sso'));

-- 6. Permissions: the Company Owner manages the connection (decision D33).
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('sso:read',   'See the company''s identity-provider connection (never its client secret)', false, false),
  ('sso:manage', 'Set up, change, switch on or off and remove the identity-provider connection', true,  false);
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('company_owner', 'sso:read',   'tenant', 3, 'base'),
  ('company_owner', 'sso:manage', 'tenant', 3, 'base');
INSERT INTO audit_detail_keys (key) VALUES ('sso_connection_id');

-- migrate:down
DELETE FROM audit_detail_keys WHERE key = 'sso_connection_id';
DELETE FROM role_permissions WHERE permission_key IN ('sso:read', 'sso:manage');
DELETE FROM permissions WHERE permission_key IN ('sso:read', 'sso:manage');
-- An SSO credential cannot be deleted once the card's history names it (card_events is append-only and points at
-- the credential), so the rollback STOPS when any exists rather than rewrite history; it works on a database where
-- nobody has set up SSO. Rows that can go do go (of EVERY company: the role that runs migrations cannot bypass
-- row-level security, so FORCE is lifted for the table's owner for these statements and put back at once).
DO $$
BEGIN
  ALTER TABLE credentials NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM credentials WHERE type = 'sso') THEN
    RAISE EXCEPTION 'rollback of 20261007000100_sso refused: SSO credentials exist and the card history refers to them'
      USING ERRCODE = 'check_violation';
  END IF;
  ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
END
$$;
DELETE FROM auth_transactions WHERE purpose = 'sso';
ALTER TABLE auth_transactions DROP CONSTRAINT auth_transactions_purpose_check;
ALTER TABLE auth_transactions ADD CONSTRAINT auth_transactions_purpose_check CHECK (purpose IN ('login', 'enroll'));
ALTER TABLE tenant_settings NO FORCE ROW LEVEL SECURITY;
UPDATE tenant_settings SET allowed_factor_types = array_remove(allowed_factor_types, 'sso') WHERE 'sso' = ANY (allowed_factor_types);
UPDATE tenant_settings SET allowed_factor_types = ARRAY['passkey', 'totp'] WHERE cardinality(allowed_factor_types) = 0;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings DROP CONSTRAINT tenant_settings_allowed_factor_types_check;
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_allowed_factor_types_check
  CHECK (allowed_factor_types <@ ARRAY['passkey', 'totp'] AND cardinality(allowed_factor_types) >= 1);
DROP INDEX credentials_sso_identity;
ALTER TABLE credentials DROP CONSTRAINT credentials_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_check CHECK (
  (type = 'passkey' AND webauthn_credential_id IS NOT NULL AND webauthn_public_key IS NOT NULL
     AND totp_secret_enc IS NULL AND totp_key_id IS NULL)
  OR
  (type = 'totp' AND totp_secret_enc IS NOT NULL AND totp_key_id IS NOT NULL
     AND webauthn_credential_id IS NULL AND webauthn_public_key IS NULL)
);
ALTER TABLE credentials DROP CONSTRAINT credentials_sso_connection_fk;
ALTER TABLE credentials DROP COLUMN sso_subject, DROP COLUMN sso_connection_id;
ALTER TABLE credentials DROP CONSTRAINT credentials_type_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_type_check CHECK (type IN ('passkey', 'totp'));
DROP FUNCTION resolve_sso_company(text);
DROP TRIGGER sso_connections_guard ON sso_connections;
DROP TABLE sso_connections;
DROP FUNCTION sso_connections_guard();

-- The design-only table of migration 20261002000500, exactly as it was.
CREATE TABLE sso_connections (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  protocol   text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  issuer     text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sso_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sso_connections USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
