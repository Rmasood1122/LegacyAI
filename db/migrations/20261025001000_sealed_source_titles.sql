-- migrate:up

-- Decision D41, step 6 part 4a (the founder's choice of 2026-10-25: through the AI service): a document's title is
-- stored SEALED from now on, bound to "source:<id>", with the key's name alongside. The API no longer reads it from
-- the database: it asks the AI service for the titles of the documents it shows (/internal/sources/titles), so the
-- document list and page need the AI service. Rows written before stay readable until the housekeeping job seals
-- them; a title is readable or sealed, never both. Erasing a document empties both forms.

ALTER TABLE sources
  ADD COLUMN title_sealed bytea CHECK (octet_length(title_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key   text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE sources ALTER COLUMN title DROP NOT NULL;
-- the existing check on the title (1 to 200 characters, or '' once withdrawn) passes for NULL and stays
ALTER TABLE sources ADD CONSTRAINT sources_title_form CHECK (
  (title_sealed IS NULL) = (sealed_key IS NULL) AND (title IS NULL) = (title_sealed IS NOT NULL));

-- The API login loses its right to the title: what it shows comes from the AI service. Its rights were table-wide
-- (SELECT, INSERT); they become every column except the title's three. It never inserts a document (the AI service
-- does), so INSERT goes altogether.
REVOKE SELECT, INSERT ON sources FROM legacyai_app;
GRANT SELECT (id, tenant_id, kind, department_id, sensitivity, owner_person_id, consent_id, company_owned_attested_by_card_id,
              contributor_confirmed_at, uploaded_by_card_id, status, failure_code, mime, byte_size, page_count, char_count, chunk_count,
              content_sha256, language, created_at, updated_at, ready_at) ON sources TO legacyai_app;

-- migrate:down
-- Refused while any title is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE sources NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM sources WHERE title_sealed IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed document titles: some are sealed';
  END IF;
  ALTER TABLE sources FORCE ROW LEVEL SECURITY;
END
$$;
REVOKE SELECT ON sources FROM legacyai_app;
GRANT SELECT, INSERT ON sources TO legacyai_app;
ALTER TABLE sources DROP CONSTRAINT sources_title_form;
ALTER TABLE sources ALTER COLUMN title SET NOT NULL;
ALTER TABLE sources DROP COLUMN sealed_key, DROP COLUMN title_sealed;
