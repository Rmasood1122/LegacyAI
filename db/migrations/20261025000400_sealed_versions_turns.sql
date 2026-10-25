-- migrate:up

-- Decision D41, step 4b part 3: knowledge versions (the text of an item) and interview turns (the question asked and
-- the expert's answer) are stored SEALED from now on, like chunks (migration 20261025000300): encrypted with the
-- company's content key, bound to the company, the column and the row's natural key, with the key's name stored
-- alongside. Rows written before stay readable until step 5; a value is readable or sealed, never both. Erasing
-- (consent withdrawal) empties both forms.

-- ---------------------------------------------------------------- knowledge versions
ALTER TABLE knowledge_versions
  ADD COLUMN body_sealed bytea CHECK (octet_length(body_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key  text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE knowledge_versions ALTER COLUMN body DROP NOT NULL;
ALTER TABLE knowledge_versions DROP CONSTRAINT knowledge_versions_check;
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_sealed_check CHECK (
  (body_sealed IS NULL) = (sealed_key IS NULL)
  AND CASE
        WHEN erased_at IS NOT NULL THEN body = '' AND body_sealed IS NULL        -- erased: nothing left in either form
        WHEN body_sealed IS NOT NULL THEN body IS NULL                           -- sealed
        ELSE char_length(body) BETWEEN 1 AND 2000                                -- readable (written before step 4b)
      END);

-- Versions never change; the only exception is erase_version(), which now empties the sealed form too.
CREATE OR REPLACE FUNCTION knowledge_versions_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge_versions: versions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (NEW.body = '' AND NEW.body_sealed IS NULL AND NEW.sealed_key IS NULL AND NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL
          AND NEW.id = OLD.id AND NEW.item_id = OLD.item_id AND NEW.version_no = OLD.version_no
          AND NEW.change_kind = OLD.change_kind) THEN
    RAISE EXCEPTION 'knowledge_versions: a version cannot be changed, only erased' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION erase_version(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ UPDATE knowledge_versions SET body = '', body_sealed = NULL, sealed_key = NULL, erased_at = now() WHERE id = p_id AND erased_at IS NULL $$;

-- ---------------------------------------------------------------- interview turns
ALTER TABLE interview_turns
  ADD COLUMN question_sealed bytea CHECK (octet_length(question_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN answer_sealed   bytea CHECK (octet_length(answer_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key      text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE interview_turns ALTER COLUMN question_text DROP NOT NULL;
ALTER TABLE interview_turns DROP CONSTRAINT interview_turns_check;
ALTER TABLE interview_turns DROP CONSTRAINT interview_turns_check1;
ALTER TABLE interview_turns DROP CONSTRAINT interview_turns_check2;
ALTER TABLE interview_turns ADD CONSTRAINT interview_turns_sealed_check CHECK (
  (question_sealed IS NULL) = (sealed_key IS NULL)                                -- a sealed turn names its key
  AND (answer_sealed IS NULL OR question_sealed IS NOT NULL)                       -- a sealed answer only in a sealed turn
  AND (answer_text IS NULL OR answer_sealed IS NULL)                               -- never both forms of the answer
  AND ((answer_text IS NULL AND answer_sealed IS NULL) = (answered_at IS NULL))    -- an answered turn has its answer
  AND CASE
        WHEN erased_at IS NOT NULL THEN question_text = '' AND question_sealed IS NULL AND answer_sealed IS NULL
                                        AND (answer_text IS NULL OR answer_text = '')
        WHEN question_sealed IS NOT NULL THEN question_text IS NULL AND answer_text IS NULL
        ELSE char_length(question_text) BETWEEN 1 AND 1000
             AND (answer_text IS NULL OR char_length(answer_text) BETWEEN 1 AND 4000)
      END);

-- migrate:down
-- Refused while anything is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE knowledge_versions NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE interview_turns NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM knowledge_versions WHERE body_sealed IS NOT NULL)
     OR EXISTS (SELECT 1 FROM interview_turns WHERE question_sealed IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed knowledge versions and interview turns: some are sealed';
  END IF;
  ALTER TABLE knowledge_versions FORCE ROW LEVEL SECURITY;
  ALTER TABLE interview_turns FORCE ROW LEVEL SECURITY;
END
$$;
ALTER TABLE interview_turns DROP CONSTRAINT interview_turns_sealed_check;
ALTER TABLE interview_turns ALTER COLUMN question_text SET NOT NULL;
ALTER TABLE interview_turns ADD CONSTRAINT interview_turns_check
  CHECK (char_length(question_text) BETWEEN 1 AND 1000 OR (erased_at IS NOT NULL AND question_text = ''));
ALTER TABLE interview_turns ADD CONSTRAINT interview_turns_check1
  CHECK (answer_text IS NULL OR char_length(answer_text) BETWEEN 1 AND 4000 OR (erased_at IS NOT NULL AND answer_text = ''));
ALTER TABLE interview_turns ADD CONSTRAINT interview_turns_check2 CHECK ((answer_text IS NULL) = (answered_at IS NULL));
ALTER TABLE interview_turns DROP COLUMN sealed_key, DROP COLUMN answer_sealed, DROP COLUMN question_sealed;

CREATE OR REPLACE FUNCTION erase_version(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ UPDATE knowledge_versions SET body = '', erased_at = now() WHERE id = p_id AND erased_at IS NULL $$;
CREATE OR REPLACE FUNCTION knowledge_versions_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge_versions: versions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (NEW.body = '' AND NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL
          AND NEW.id = OLD.id AND NEW.item_id = OLD.item_id AND NEW.version_no = OLD.version_no
          AND NEW.change_kind = OLD.change_kind) THEN
    RAISE EXCEPTION 'knowledge_versions: a version cannot be changed, only erased' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE knowledge_versions DROP CONSTRAINT knowledge_versions_sealed_check;
ALTER TABLE knowledge_versions ALTER COLUMN body SET NOT NULL;
ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_check
  CHECK (char_length(body) BETWEEN 1 AND 2000 OR (erased_at IS NOT NULL AND body = ''));
ALTER TABLE knowledge_versions DROP COLUMN sealed_key, DROP COLUMN body_sealed;
