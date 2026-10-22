-- migrate:up

-- Phase 4, Batch B step 3, part B: SCIM - people provisioned from the company's directory (feature 16).
-- docs/phase4/07-sso-scim.md, decision D34.
--
-- The company's directory (Microsoft Entra ID, Okta, Google, ...) calls the API with a DIRECTORY KEY: an API key
-- (D30) that carries exactly one permission, person:scim, and nothing else. What it may do:
--   - create people, change their name, e-mail and directory user name, and mark them as left ("departed": their
--     cards are revoked, as when an administrator does it);
--   - only people the directory created ("scim_managed"); never anyone whose card holds the Owner role.
-- What it may NOT do: issue cards, give roles, read knowledge. A person the directory creates has no card and so no
-- way in; an administrator still issues the card. Provisioning hands nobody access.
--
-- person:scim is held by the Company Owner's role so that an Owner can MAKE such a key; the policy refuses it to
-- any signed-in card (only a key can use it).
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('person:scim', 'Provision people from the company directory (SCIM). Usable only with a directory key, never by a signed-in card', true, false);
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('company_owner', 'person:scim', 'tenant', 3, 'base');

-- A directory key carries person:scim ALONE: a key that can change people cannot also read knowledge, and a key made
-- for reading cannot change people. (The application refuses such a key too; this makes the database refuse it.)
ALTER TABLE api_keys ADD CONSTRAINT api_keys_directory_key_alone
  CHECK (NOT ('person:scim' = ANY (scope)) OR scope = ARRAY['person:scim']::text[]);

-- The directory's name for a person (SCIM userName): unique in the company, compared without regard to case
-- (RFC 7643: userName is not case-exact). Only people the directory manages have one. external_id and scim_managed
-- were laid down in Phase 1 for this feature.
ALTER TABLE people ADD COLUMN scim_user_name text
  CHECK (scim_user_name IS NULL OR (char_length(scim_user_name) BETWEEN 1 AND 256 AND scim_user_name !~ '[[:cntrl:]]'));
ALTER TABLE people ADD CONSTRAINT people_scim_fields CHECK (scim_managed OR (scim_user_name IS NULL AND external_id IS NULL));
ALTER TABLE people ADD CONSTRAINT people_scim_user_name_required CHECK (NOT scim_managed OR scim_user_name IS NOT NULL);
CREATE UNIQUE INDEX people_scim_user_name ON people (tenant_id, lower(scim_user_name)) WHERE scim_user_name IS NOT NULL;

-- migrate:down
-- People the directory created stay, with their history, and become ordinary people that an administrator manages.
-- That is why the directory's marks are cleared: the user name and the directory's id go, and scim_managed goes back
-- to false. This touches EVERY company, so FORCE is lifted for the table's owner for this one statement and put back
-- at once; a failure rolls the whole migration back.
-- Directory keys are left as they are. Once the permission is gone, the policy refuses any action it does not know
-- (DENY_UNKNOWN_ACTION), and a key's scope can never change (api_keys_guard).
ALTER TABLE api_keys DROP CONSTRAINT api_keys_directory_key_alone;
DROP INDEX people_scim_user_name;
ALTER TABLE people DROP CONSTRAINT people_scim_user_name_required;
ALTER TABLE people DROP CONSTRAINT people_scim_fields;
ALTER TABLE people DROP COLUMN scim_user_name;
ALTER TABLE people NO FORCE ROW LEVEL SECURITY;
UPDATE people SET scim_managed = false, external_id = NULL WHERE scim_managed;
ALTER TABLE people FORCE ROW LEVEL SECURITY;
DELETE FROM role_permissions WHERE permission_key = 'person:scim';
DELETE FROM permissions WHERE permission_key = 'person:scim';
