-- migrate:up

-- Decision D41, step 6 part 1: the questions people ask (answer_logs), the questions put to an expert
-- (expert_questions) and readers' comments on answers (answer_feedback) are stored SEALED from now on, like chunks,
-- versions and interview turns: encrypted with the company's content key, bound to the company, the table, the column
-- and the row ("answer:<id>", "expert_question:<id>", "feedback:<answer id>:<card id>"), with the key's name alongside.
-- Rows written before stay readable until the housekeeping job seals them; a value is readable or sealed, never both.
-- Only the AI service reads these columns (the API has no right on them).

-- ---------------------------------------------------------------- answer_logs
ALTER TABLE answer_logs
  ADD COLUMN question_sealed bytea CHECK (octet_length(question_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key      text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE answer_logs ALTER COLUMN question_redacted DROP NOT NULL;
ALTER TABLE answer_logs DROP CONSTRAINT answer_logs_question_redacted_check;
ALTER TABLE answer_logs ADD CONSTRAINT answer_logs_sealed_form CHECK (
  (question_sealed IS NULL) = (sealed_key IS NULL)
  AND (question_redacted IS NULL) = (question_sealed IS NOT NULL)
  AND (question_redacted IS NULL OR char_length(question_redacted) BETWEEN 1 AND 500));

-- The AI service may insert and delete answer logs, not change them; this seals one readable log of the caller's
-- company and nothing else (used by the housekeeping job). False when there was nothing to seal.
CREATE FUNCTION seal_answer_log(p_id uuid, p_sealed bytea, p_key text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH sealed AS (
    UPDATE answer_logs SET question_redacted = NULL, question_sealed = p_sealed, sealed_key = p_key
     WHERE id = p_id AND tenant_id = app_current_tenant() AND question_sealed IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM sealed)
$$;
REVOKE ALL ON FUNCTION seal_answer_log(uuid, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seal_answer_log(uuid, bytea, text) TO legacyai_ai;

-- ---------------------------------------------------------------- expert_questions
ALTER TABLE expert_questions
  ADD COLUMN question_sealed bytea CHECK (octet_length(question_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key      text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE expert_questions ALTER COLUMN question_redacted DROP NOT NULL;
ALTER TABLE expert_questions DROP CONSTRAINT expert_questions_check1;
ALTER TABLE expert_questions ADD CONSTRAINT expert_questions_sealed_form CHECK (
  (question_sealed IS NULL) = (sealed_key IS NULL)
  AND CASE
        WHEN erased_at IS NOT NULL THEN question_redacted = '' AND question_sealed IS NULL    -- erased: nothing left
        WHEN question_sealed IS NOT NULL THEN question_redacted IS NULL                       -- sealed
        ELSE char_length(question_redacted) BETWEEN 1 AND 1000                                -- readable (written before)
      END);

-- The question itself never changes once asked: only readable -> sealed (the job), or emptied when erased.
CREATE OR REPLACE FUNCTION expert_questions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN RAISE EXCEPTION 'expert_questions: a new question is open' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'open' AND NEW.status IN ('answered', 'declined', 'expired')) THEN
    RAISE EXCEPTION 'expert_questions: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.question_redacted IS DISTINCT FROM OLD.question_redacted OR NEW.question_sealed IS DISTINCT FROM OLD.question_sealed
      OR NEW.sealed_key IS DISTINCT FROM OLD.sealed_key)
     AND NOT (OLD.question_sealed IS NULL AND NEW.question_redacted IS NULL AND NEW.question_sealed IS NOT NULL)   -- sealed by the job
     AND NOT (NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL) THEN                                            -- erased
    RAISE EXCEPTION 'expert_questions: the question does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- answer_feedback
-- A reader's comment can be replaced (saying it again replaces the opinion) or removed; whatever is stored is sealed.
ALTER TABLE answer_feedback
  ADD COLUMN comment_sealed bytea CHECK (octet_length(comment_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key     text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE answer_feedback ADD CONSTRAINT answer_feedback_sealed_form CHECK (
  (comment_sealed IS NULL) = (sealed_key IS NULL) AND (comment_redacted IS NULL OR comment_sealed IS NULL));

-- migrate:down
-- Refused while anything is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE answer_logs NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE expert_questions NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE answer_feedback NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM answer_logs WHERE question_sealed IS NOT NULL)
     OR EXISTS (SELECT 1 FROM expert_questions WHERE question_sealed IS NOT NULL)
     OR EXISTS (SELECT 1 FROM answer_feedback WHERE comment_sealed IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed questions and feedback: some are sealed';
  END IF;
  ALTER TABLE answer_logs FORCE ROW LEVEL SECURITY;
  ALTER TABLE expert_questions FORCE ROW LEVEL SECURITY;
  ALTER TABLE answer_feedback FORCE ROW LEVEL SECURITY;
END
$$;
ALTER TABLE answer_feedback DROP CONSTRAINT answer_feedback_sealed_form;
ALTER TABLE answer_feedback DROP COLUMN sealed_key, DROP COLUMN comment_sealed;

CREATE OR REPLACE FUNCTION expert_questions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN RAISE EXCEPTION 'expert_questions: a new question is open' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'open' AND NEW.status IN ('answered', 'declined', 'expired')) THEN
    RAISE EXCEPTION 'expert_questions: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE expert_questions DROP CONSTRAINT expert_questions_sealed_form;
ALTER TABLE expert_questions ALTER COLUMN question_redacted SET NOT NULL;
ALTER TABLE expert_questions ADD CONSTRAINT expert_questions_check1
  CHECK (char_length(question_redacted) BETWEEN 1 AND 1000 OR (erased_at IS NOT NULL AND question_redacted = ''));
ALTER TABLE expert_questions DROP COLUMN sealed_key, DROP COLUMN question_sealed;

DROP FUNCTION seal_answer_log(uuid, bytea, text);
ALTER TABLE answer_logs DROP CONSTRAINT answer_logs_sealed_form;
ALTER TABLE answer_logs ALTER COLUMN question_redacted SET NOT NULL;
ALTER TABLE answer_logs ADD CONSTRAINT answer_logs_question_redacted_check CHECK (char_length(question_redacted) BETWEEN 1 AND 500);
ALTER TABLE answer_logs DROP COLUMN sealed_key, DROP COLUMN question_sealed;
