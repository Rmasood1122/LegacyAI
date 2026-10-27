-- migrate:up

-- Decision D41, re-keying part 2 (part 1: 20261026000100): what a company sealed with its own key before it CLEARED
-- (or changed) that key is sealed again with the company's current key by the housekeeping job - now also the step-6
-- columns: questions people asked, questions to experts, readers' comments, item titles, the words stored conflicts
-- quote, readiness questions and answers, scenario texts and answers, document titles, topic names and descriptions.
--
-- The rule is the one of part 1 (content_rekey_allowed): a sealed value replaced by a sealed value, away from a RETIRED
-- version of the company's own data key, to the key it seals with now, nothing else changing. The guards that so far
-- allowed only readable -> sealed allow this too; an answer log, which the AI service may not change, goes through
-- reseal_answer_log(), which checks the rule itself. Tables the AI service may already update (comments, conflicts,
-- answers, item and document titles, topics) need nothing here.

-- Seals one answer log's question again with the company's current key. False when there was nothing to do (not
-- sealed with p_old any more, or not this company's); refused when the key change is not allowed.
CREATE FUNCTION reseal_answer_log(p_id uuid, p_old text, p_sealed bytea, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  done boolean;
BEGIN
  IF NOT public.content_rekey_allowed(app_current_tenant(), p_old, p_key) THEN
    RAISE EXCEPTION 'answer_logs: this key change is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  WITH resealed AS (
    UPDATE answer_logs SET question_sealed = p_sealed, sealed_key = p_key
     WHERE id = p_id AND tenant_id = app_current_tenant() AND sealed_key = p_old
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM resealed) INTO done;
  RETURN done;
END
$$;
REVOKE ALL ON FUNCTION reseal_answer_log(uuid, text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reseal_answer_log(uuid, text, bytea, text) TO legacyai_ai;

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
     AND NOT (OLD.question_sealed IS NOT NULL AND NEW.question_redacted IS NULL AND NEW.question_sealed IS NOT NULL
              AND OLD.erased_at IS NULL AND NEW.erased_at IS NULL AND public.content_rekey_allowed(NEW.tenant_id, OLD.sealed_key, NEW.sealed_key))                             -- sealed again (re-keying)
     AND NOT (NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL) THEN                                            -- erased
    RAISE EXCEPTION 'expert_questions: the question does not change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

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
              AND NEW.correct_option IS NOT DISTINCT FROM OLD.correct_option)
     AND NOT (OLD.content_sealed IS NOT NULL AND NEW.content_sealed IS NOT NULL AND NEW.stem IS NULL  -- sealed again (re-keying)
              AND NEW.correct_option IS NOT DISTINCT FROM OLD.correct_option AND public.content_rekey_allowed(NEW.tenant_id, OLD.sealed_key, NEW.sealed_key)) THEN
    RAISE EXCEPTION 'quiz_items: an approved question cannot be edited; move it back to draft' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'draft' THEN
    NEW.approved_by_card_id := NULL;
    NEW.approved_at := NULL;
  END IF;
  RETURN NEW;
END
$$;

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
              AND (NEW.situation_sealed IS NOT NULL OR NEW.situation IS NOT DISTINCT FROM OLD.situation))
     AND NOT (NEW.job_role = OLD.job_role AND OLD.title_sealed IS NOT NULL AND NEW.title_sealed IS NOT NULL          -- sealed again (re-keying)
              AND (NEW.situation_sealed IS NULL) = (OLD.situation_sealed IS NULL) AND NEW.situation IS NOT DISTINCT FROM OLD.situation
              AND public.content_rekey_allowed(NEW.tenant_id, OLD.sealed_key, NEW.sealed_key)) THEN
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
    IF TG_OP = 'UPDATE' AND OLD.sealed_key IS NOT NULL AND NEW.prompt_sealed IS NOT NULL AND NEW.prompt IS NULL AND NEW.rubric IS NULL
       AND NEW.scenario_id = OLD.scenario_id AND NEW.position = OLD.position AND NEW.erased_at IS NOT DISTINCT FROM OLD.erased_at
       AND public.content_rekey_allowed(tenant, OLD.sealed_key, NEW.sealed_key) THEN
      RETURN NEW;                                                                      -- sealed again (re-keying)
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

-- migrate:down
-- Values sealed again stay as they are: they are sealed with a key the company still has.
DROP FUNCTION reseal_answer_log(uuid, text, bytea, text);
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
