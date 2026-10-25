-- migrate:up

-- Decision D41, step 6 part 3b: scenario texts are stored SEALED from now on.
-- - scenarios: the title and the situation, each sealed, bound to "scenario:<id>" (one key per row). They are sealed
--   separately because erasure empties the situation and keeps the title.
-- - scenario_steps: the step's question ("prompt") and its expected points ("rubric", a JSON list), each sealed, bound to
--   "scenario_step:<id>", one key per row. Separate values so that what a learner is shown never needs the points opened.
-- - scenario_answers: what the learner wrote ("answer") and what the grading model said ("rubric_result"), bound to
--   "scenario_answer:<id>", one key per row.
-- Rows written before stay readable until the housekeeping job seals them; a value is readable or sealed, never both.
-- The existing column checks pass for NULL, so they stay. Only the AI service reads these columns.

-- ---------------------------------------------------------------- scenarios
ALTER TABLE scenarios
  ADD COLUMN title_sealed     bytea CHECK (octet_length(title_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN situation_sealed bytea CHECK (octet_length(situation_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key       text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE scenarios ALTER COLUMN title DROP NOT NULL, ALTER COLUMN situation DROP NOT NULL;
ALTER TABLE scenarios ADD CONSTRAINT scenarios_text_form CHECK (
  (title_sealed IS NULL) = (sealed_key IS NULL)
  AND (situation_sealed IS NULL OR title_sealed IS NOT NULL)
  AND (title IS NULL) = (title_sealed IS NOT NULL)
  AND (situation IS NULL) = (situation_sealed IS NOT NULL));

-- An approved scenario still cannot be edited; sealing a readable one (the housekeeping job) is not an edit.
CREATE OR REPLACE FUNCTION scenarios_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'scenarios: a new scenario is a draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'retired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'retired'))) THEN
    RAISE EXCEPTION 'scenarios: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.title IS DISTINCT FROM OLD.title OR NEW.situation IS DISTINCT FROM OLD.situation OR NEW.job_role <> OLD.job_role
          OR NEW.title_sealed IS DISTINCT FROM OLD.title_sealed OR NEW.situation_sealed IS DISTINCT FROM OLD.situation_sealed)
     AND NOT (NEW.job_role = OLD.job_role AND OLD.title_sealed IS NULL AND NEW.title_sealed IS NOT NULL                -- sealed by the job
              AND (NEW.situation_sealed IS NOT NULL OR NEW.situation IS NOT DISTINCT FROM OLD.situation)) THEN
    RAISE EXCEPTION 'scenarios: an approved scenario cannot be edited; move it back to draft' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_by_card_id <> OLD.created_by_card_id OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN
    RAISE EXCEPTION 'scenarios: who created a scenario does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.approved_by_card_id := NULL;
    NEW.approved_by_person_id := NULL;
    NEW.approved_at := NULL;
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    -- Defence in depth (the rule itself is decided by the API's policy, and audited there): neither the creator nor
    -- the last editor approves - compared by card AND by person - unless the company switched the rule off.
    IF (NEW.approved_by_card_id IN (NEW.author_card_id, NEW.created_by_card_id)
        OR (NEW.approved_by_person_id IS NOT NULL AND NEW.approved_by_person_id IN (NEW.owner_person_id, NEW.created_by_person_id)))
       AND COALESCE((SELECT second_reviewer_required FROM knowledge_settings WHERE tenant_id = NEW.tenant_id), true) THEN
      RAISE EXCEPTION 'scenarios: the creator or last editor cannot approve the scenario' USING ERRCODE = 'check_violation';
    END IF;
    NEW.flag_reason := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- scenario_steps
ALTER TABLE scenario_steps
  ADD COLUMN prompt_sealed bytea CHECK (octet_length(prompt_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN rubric_sealed bytea CHECK (octet_length(rubric_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key    text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE scenario_steps ALTER COLUMN prompt DROP NOT NULL, ALTER COLUMN rubric DROP NOT NULL;
ALTER TABLE scenario_steps ADD CONSTRAINT scenario_steps_content_form CHECK (
  (prompt_sealed IS NULL) = (sealed_key IS NULL) AND (rubric_sealed IS NULL) = (sealed_key IS NULL)
  AND (prompt IS NULL) = (prompt_sealed IS NOT NULL)
  AND (rubric IS NULL) = (rubric_sealed IS NOT NULL));

-- The parts of an approved scenario still do not change; sealing a readable step (the job) is the one exception.
CREATE OR REPLACE FUNCTION scenario_parts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parent_status text;
  step uuid;
  tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN tenant := OLD.tenant_id; ELSE tenant := NEW.tenant_id; END IF;
  IF TG_TABLE_NAME = 'scenario_steps' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT s.status INTO parent_status FROM scenarios s WHERE s.tenant_id = tenant AND s.id = OLD.scenario_id;
    ELSE
      SELECT s.status INTO parent_status FROM scenarios s WHERE s.tenant_id = tenant AND s.id = NEW.scenario_id;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.sealed_key IS NULL AND NEW.prompt_sealed IS NOT NULL AND NEW.prompt IS NULL
       AND NEW.scenario_id = OLD.scenario_id AND NEW.position = OLD.position AND NEW.erased_at IS NOT DISTINCT FROM OLD.erased_at THEN
      RETURN NEW;                                                                      -- sealed by the job
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN step := OLD.step_id; ELSE step := NEW.step_id; END IF;
    SELECT s.status INTO parent_status FROM scenario_steps st JOIN scenarios s ON s.tenant_id = st.tenant_id AND s.id = st.scenario_id
     WHERE st.tenant_id = tenant AND st.id = step;
  END IF;
  -- parent_status is NULL when the step itself is being removed by a cascade: nothing left to protect
  IF parent_status = 'approved' THEN
    RAISE EXCEPTION '%: the steps of an approved scenario cannot change; move it back to draft', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- scenario_answers
ALTER TABLE scenario_answers
  ADD COLUMN answer_sealed        bytea CHECK (octet_length(answer_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN rubric_result_sealed bytea CHECK (octet_length(rubric_result_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key           text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE scenario_answers ADD CONSTRAINT scenario_answers_sealed_form CHECK (
  (answer_sealed IS NULL AND rubric_result_sealed IS NULL) = (sealed_key IS NULL)
  AND (answer_text IS NULL OR answer_sealed IS NULL)
  AND (ai_rubric_result IS NULL OR rubric_result_sealed IS NULL));

-- migrate:down
-- Refused while anything is sealed: the old schema cannot hold it.
DO $$
BEGIN
  ALTER TABLE scenarios NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE scenario_steps NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE scenario_answers NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM scenarios WHERE sealed_key IS NOT NULL) OR EXISTS (SELECT 1 FROM scenario_steps WHERE sealed_key IS NOT NULL)
     OR EXISTS (SELECT 1 FROM scenario_answers WHERE sealed_key IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed scenarios: some are sealed';
  END IF;
  ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;
  ALTER TABLE scenario_steps FORCE ROW LEVEL SECURITY;
  ALTER TABLE scenario_answers FORCE ROW LEVEL SECURITY;
END
$$;
ALTER TABLE scenario_answers DROP CONSTRAINT scenario_answers_sealed_form;
ALTER TABLE scenario_answers DROP COLUMN sealed_key, DROP COLUMN rubric_result_sealed, DROP COLUMN answer_sealed;

CREATE OR REPLACE FUNCTION scenario_parts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parent_status text;
  step uuid;
  tenant uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN tenant := OLD.tenant_id; ELSE tenant := NEW.tenant_id; END IF;
  IF TG_TABLE_NAME = 'scenario_steps' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT s.status INTO parent_status FROM scenarios s WHERE s.tenant_id = tenant AND s.id = OLD.scenario_id;
    ELSE
      SELECT s.status INTO parent_status FROM scenarios s WHERE s.tenant_id = tenant AND s.id = NEW.scenario_id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN step := OLD.step_id; ELSE step := NEW.step_id; END IF;
    SELECT s.status INTO parent_status FROM scenario_steps st JOIN scenarios s ON s.tenant_id = st.tenant_id AND s.id = st.scenario_id
     WHERE st.tenant_id = tenant AND st.id = step;
  END IF;
  -- parent_status is NULL when the step itself is being removed by a cascade: nothing left to protect
  IF parent_status = 'approved' THEN
    RAISE EXCEPTION '%: the steps of an approved scenario cannot change; move it back to draft', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
ALTER TABLE scenario_steps DROP CONSTRAINT scenario_steps_content_form;
ALTER TABLE scenario_steps ALTER COLUMN prompt SET NOT NULL, ALTER COLUMN rubric SET NOT NULL;
ALTER TABLE scenario_steps DROP COLUMN sealed_key, DROP COLUMN rubric_sealed, DROP COLUMN prompt_sealed;

CREATE OR REPLACE FUNCTION scenarios_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN RAISE EXCEPTION 'scenarios: a new scenario is a draft' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('approved', 'retired'))
    OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'retired'))) THEN
    RAISE EXCEPTION 'scenarios: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND NEW.status = 'approved'
     AND (NEW.title <> OLD.title OR NEW.situation <> OLD.situation OR NEW.job_role <> OLD.job_role) THEN
    RAISE EXCEPTION 'scenarios: an approved scenario cannot be edited; move it back to draft' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_by_card_id <> OLD.created_by_card_id OR NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN
    RAISE EXCEPTION 'scenarios: who created a scenario does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.approved_by_card_id := NULL;
    NEW.approved_by_person_id := NULL;
    NEW.approved_at := NULL;
  END IF;
  IF NEW.status = 'approved' AND OLD.status <> 'approved' THEN
    -- Defence in depth (the rule itself is decided by the API's policy, and audited there): neither the creator nor
    -- the last editor approves - compared by card AND by person - unless the company switched the rule off.
    IF (NEW.approved_by_card_id IN (NEW.author_card_id, NEW.created_by_card_id)
        OR (NEW.approved_by_person_id IS NOT NULL AND NEW.approved_by_person_id IN (NEW.owner_person_id, NEW.created_by_person_id)))
       AND COALESCE((SELECT second_reviewer_required FROM knowledge_settings WHERE tenant_id = NEW.tenant_id), true) THEN
      RAISE EXCEPTION 'scenarios: the creator or last editor cannot approve the scenario' USING ERRCODE = 'check_violation';
    END IF;
    NEW.flag_reason := NULL;
  END IF;
  RETURN NEW;
END
$$;
ALTER TABLE scenarios DROP CONSTRAINT scenarios_text_form;
ALTER TABLE scenarios ALTER COLUMN title SET NOT NULL, ALTER COLUMN situation SET NOT NULL;
ALTER TABLE scenarios DROP COLUMN sealed_key, DROP COLUMN situation_sealed, DROP COLUMN title_sealed;
