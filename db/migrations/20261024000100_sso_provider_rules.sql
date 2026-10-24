-- migrate:up

-- Phase 4: SSO with real providers (decision D39, docs/phase4/07-sso-scim.md "Real providers").
--
-- Google lets ANY Google account sign in. A company that signs in with Google names its Google Workspace domain here,
-- and every ID token must carry exactly that domain in its `hd` claim (the API checks it; providers.ts). Required for
-- a Google connection, refused for any other provider (the API decides which is which by the issuer).
ALTER TABLE sso_connections ADD COLUMN allowed_domain text
  CHECK (allowed_domain IS NULL OR (char_length(allowed_domain) BETWEEN 4 AND 253
    AND allowed_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'));

-- migrate:down
-- Refused while a live connection has a domain: without the column, the older code would let any Google account in.
-- Remove those connections first (removing one revokes its sign-ins; see the document).
DO $$
BEGIN
  ALTER TABLE sso_connections NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM sso_connections WHERE allowed_domain IS NOT NULL AND removed_at IS NULL) THEN
    RAISE EXCEPTION 'cannot roll back: % live SSO connection(s) depend on allowed_domain (Google); remove them first',
      (SELECT count(*) FROM sso_connections WHERE allowed_domain IS NOT NULL AND removed_at IS NULL);
  END IF;
  ALTER TABLE sso_connections FORCE ROW LEVEL SECURITY;
END
$$;
ALTER TABLE sso_connections DROP COLUMN allowed_domain;
