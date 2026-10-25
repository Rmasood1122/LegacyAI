-- migrate:up

-- Decision D41, step 6 part 4b (second half; the founder's choice of 2026-10-25: through the AI service): a topic's
-- name and description are stored SEALED from now on, bound to "topic:<id>", with the key's name alongside. Only the
-- AI service writes and reads them (the first half, 20261025001100). Names stay unique per company in any case:
-- name_hash is a keyed fingerprint of the name in lower case, under the key the row is sealed with, and is unique per
-- company; the old unique index on lower(name) keeps covering the rows still readable (a sealed row's name is NULL,
-- so it never conflicts there). Rows written before stay readable until the housekeeping job seals them; name and
-- description are readable or sealed together, never both.

ALTER TABLE topics
  ADD COLUMN name_sealed        bytea CHECK (octet_length(name_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN description_sealed bytea CHECK (octet_length(description_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key         text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$'),
  ADD COLUMN name_hash          bytea CHECK (octet_length(name_hash) = 32);
ALTER TABLE topics ALTER COLUMN name DROP NOT NULL, ALTER COLUMN description DROP NOT NULL;
-- the existing checks on name (1 to 120 characters) and description (at most 500) pass for NULL and stay
ALTER TABLE topics ADD CONSTRAINT topics_text_form CHECK (
  (name_sealed IS NULL) = (sealed_key IS NULL) AND (name_sealed IS NULL) = (description_sealed IS NULL)
  AND (name_sealed IS NULL) = (name_hash IS NULL)
  AND (name IS NULL) = (name_sealed IS NOT NULL) AND (description IS NULL) = (description_sealed IS NOT NULL));
CREATE UNIQUE INDEX topics_name_hash ON topics (tenant_id, name_hash) WHERE name_hash IS NOT NULL;

-- The AI service seals older rows (housekeeping) and writes sealed names when a topic is renamed.
GRANT UPDATE (name_sealed, description_sealed, sealed_key, name_hash) ON topics TO legacyai_ai;

-- migrate:down
-- Refused while any topic is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE topics NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM topics WHERE name_sealed IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed topic names: some are sealed';
  END IF;
  ALTER TABLE topics FORCE ROW LEVEL SECURITY;
END
$$;
REVOKE UPDATE (name_sealed, description_sealed, sealed_key, name_hash) ON topics FROM legacyai_ai;
DROP INDEX topics_name_hash;
ALTER TABLE topics DROP CONSTRAINT topics_text_form;
ALTER TABLE topics ALTER COLUMN name SET NOT NULL, ALTER COLUMN description SET NOT NULL;
ALTER TABLE topics DROP COLUMN name_hash, DROP COLUMN sealed_key, DROP COLUMN description_sealed, DROP COLUMN name_sealed;
