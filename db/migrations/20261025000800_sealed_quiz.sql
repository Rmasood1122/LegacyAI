-- migrate:up

-- Decision D41, step 6 part 3a: readiness questions and learners' answers are stored SEALED from now on.
-- - quiz_items: the question's words (stem, options, expected points) as ONE sealed JSON value ("content"), bound to
--   "quiz_item:<id>". The kind, the index of the correct option and the labels stay readable.
-- - quiz_answers: what the learner wrote ("answer") and what the grading model said about it ("rubric_result"), bound to
--   "quiz_answer:<id>", one key per row.
-- Rows written before stay readable until the housekeeping job seals them; a value is readable or sealed, never both.
-- Only the AI service reads these columns.

-- ---------------------------------------------------------------- quiz_items
ALTER TABLE quiz_items
  ADD COLUMN content_sealed bytea CHECK (octet_length(content_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key     text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE quiz_items ALTER COLUMN stem DROP NOT NULL;
ALTER TABLE quiz_items DROP CONSTRAINT quiz_items_check, DROP CONSTRAINT quiz_items_check1, DROP CONSTRAINT quiz_items_check2;
ALTER TABLE quiz_items ADD CONSTRAINT quiz_items_content_form CHECK (
  (content_sealed IS NULL) = (sealed_key IS NULL)
  AND CASE
        WHEN erased_at IS NOT NULL THEN stem = '' AND content_sealed IS NULL
        WHEN content_sealed IS NOT NULL THEN stem IS NULL AND options IS NULL AND rubric IS NULL
                                             AND (kind <> 'mcq' OR correct_option BETWEEN 0 AND 3)
        ELSE char_length(stem) BETWEEN 1 AND 2000
             AND (kind <> 'mcq' OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4 AND correct_option BETWEEN 0 AND 3))
             AND (kind <> 'open' OR jsonb_typeof(rubric) = 'array')
      END);

-- An approved question still cannot be edited; sealing a readable one (the housekeeping job) is not an edit.
CREATE OR REPLACE FUNCTION quiz_items_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'quiz_items: a new question is a draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity
      OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'quiz_items: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'retired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'retired'))) THEN
    RAISE EXCEPTION 'quiz_items: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- Editing an approved question makes it a draft again; it needs a new approval.
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.stem IS DISTINCT FROM OLD.stem OR NEW.options IS DISTINCT FROM OLD.options OR NEW.correct_option IS DISTINCT FROM OLD.correct_option
          OR NEW.rubric IS DISTINCT FROM OLD.rubric OR NEW.content_sealed IS DISTINCT FROM OLD.content_sealed)
     AND NOT (OLD.content_sealed IS NULL AND NEW.content_sealed IS NOT NULL AND NEW.stem IS NULL      -- sealed by the job
              AND NEW.correct_option IS NOT DISTINCT FROM OLD.correct_option) THEN
    RAISE EXCEPTION 'quiz_items: an approved question cannot be edited; move it back to draft' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.approved_by_card_id := NULL;
    NEW.approved_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- quiz_answers
ALTER TABLE quiz_answers
  ADD COLUMN answer_sealed        bytea CHECK (octet_length(answer_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN rubric_result_sealed bytea CHECK (octet_length(rubric_result_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key           text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE quiz_answers ADD CONSTRAINT quiz_answers_sealed_form CHECK (
  (answer_sealed IS NULL AND rubric_result_sealed IS NULL) = (sealed_key IS NULL)
  AND (answer_text IS NULL OR answer_sealed IS NULL)
  AND (ai_rubric_result IS NULL OR rubric_result_sealed IS NULL));

-- migrate:down
-- Refused while anything is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE quiz_items NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE quiz_answers NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM quiz_items WHERE content_sealed IS NOT NULL) OR EXISTS (SELECT 1 FROM quiz_answers WHERE sealed_key IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed readiness questions and answers: some are sealed';
  END IF;
  ALTER TABLE quiz_items FORCE ROW LEVEL SECURITY;
  ALTER TABLE quiz_answers FORCE ROW LEVEL SECURITY;
END
$$;
ALTER TABLE quiz_answers DROP CONSTRAINT quiz_answers_sealed_form;
ALTER TABLE quiz_answers DROP COLUMN sealed_key, DROP COLUMN rubric_result_sealed, DROP COLUMN answer_sealed;
CREATE OR REPLACE FUNCTION quiz_items_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'quiz_items: a new question is a draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity
      OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'quiz_items: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'retired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'retired'))) THEN
    RAISE EXCEPTION 'quiz_items: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- Editing an approved question makes it a draft again; it needs a new approval.
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.stem <> OLD.stem OR NEW.options IS DISTINCT FROM OLD.options OR NEW.correct_option IS DISTINCT FROM OLD.correct_option
          OR NEW.rubric IS DISTINCT FROM OLD.rubric) THEN
    RAISE EXCEPTION 'quiz_items: an approved question cannot be edited; move it back to draft' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.approved_by_card_id := NULL;
    NEW.approved_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE quiz_items DROP CONSTRAINT quiz_items_content_form;
ALTER TABLE quiz_items ALTER COLUMN stem SET NOT NULL;
ALTER TABLE quiz_items ADD CONSTRAINT quiz_items_check CHECK (char_length(stem) BETWEEN 1 AND 2000 OR (erased_at IS NOT NULL AND stem = ''));
ALTER TABLE quiz_items ADD CONSTRAINT quiz_items_check1 CHECK (kind <> 'mcq' OR erased_at IS NOT NULL
  OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4 AND correct_option BETWEEN 0 AND 3));
ALTER TABLE quiz_items ADD CONSTRAINT quiz_items_check2 CHECK (kind <> 'open' OR erased_at IS NOT NULL OR jsonb_typeof(rubric) = 'array');
ALTER TABLE quiz_items DROP COLUMN sealed_key, DROP COLUMN content_sealed;
