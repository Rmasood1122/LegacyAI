-- migrate:up

-- Phase 4, feature 8 (scenario replay). docs/phase4/04-scenario-replay.md
-- A scenario is a situation ("what would you do if ...") with ordered steps. Each step is tied to verified, released
-- knowledge items and has expected points (a rubric). A learner answers the steps in free text; the answers are
-- graded by the rubric, exactly like open readiness questions. Five new tables, owned by the AI service like the
-- readiness tables. Existing tables: one more trigger on knowledge_items, one more task subject, and four columns on
-- quiz_items that record who wrote a question (so the second-person rule can apply to questions too; see the end).

CREATE TABLE scenarios (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  title               text NOT NULL,
  situation           text NOT NULL,
  job_role            text NOT NULL CHECK (char_length(job_role) BETWEEN 1 AND 120),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  -- why an approved scenario went back (or was retired) without a person doing it: a linked item changed or was withdrawn
  flag_reason         text CHECK (flag_reason IS NULL OR flag_reason IN ('item_changed', 'item_withdrawn')),
  -- labels, as on every knowledge row. They FOLLOW the linked items: the highest level of any linked item, and a
  -- department only if every linked item has that same one. A scenario is written from released knowledge (level 0);
  -- if an item is re-labelled later, the scenario's labels move with it (knowledge_items_touch_scenarios below), so
  -- the ordinary read filter hides it from readers who may not read that item.
  department_id       uuid,
  sensitivity         smallint NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 3),
  -- who CREATED it, and who wrote the CURRENT text (the last editor). Neither may approve it.
  created_by_card_id   uuid NOT NULL,
  created_by_person_id uuid,
  owner_person_id      uuid,
  author_card_id       uuid NOT NULL,
  approved_by_card_id  uuid,
  approved_by_person_id uuid,
  approved_at         timestamptz,
  erased_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, author_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK (char_length(title) BETWEEN 1 AND 200),
  CHECK (char_length(situation) BETWEEN 1 AND 2000 OR (erased_at IS NOT NULL AND situation = '')),
  CHECK ((status = 'approved') <= (approved_by_card_id IS NOT NULL))
);
CREATE INDEX scenarios_role ON scenarios (tenant_id, job_role, status);

CREATE FUNCTION scenarios_guard() RETURNS trigger
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
CREATE TRIGGER scenarios_guard BEFORE INSERT OR UPDATE ON scenarios FOR EACH ROW EXECUTE FUNCTION scenarios_guard();

CREATE TABLE scenario_steps (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  scenario_id uuid NOT NULL,
  position    smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  prompt      text NOT NULL,
  rubric      jsonb NOT NULL CHECK (jsonb_typeof(rubric) = 'array'),
  erased_at   timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, scenario_id, position),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios (tenant_id, id),
  CHECK (char_length(prompt) BETWEEN 1 AND 1000 OR (erased_at IS NOT NULL AND prompt = ''))
);

-- The knowledge a step expects. Verified, released items only (the AI service checks; the API checks the caller may read them).
CREATE TABLE scenario_step_items (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  step_id   uuid NOT NULL,
  item_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, step_id, item_id),
  FOREIGN KEY (tenant_id, step_id) REFERENCES scenario_steps (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, item_id) REFERENCES knowledge_items (tenant_id, id)
);
CREATE INDEX scenario_step_items_item ON scenario_step_items (tenant_id, item_id);

-- The steps and their items are part of what was approved: they change only while the scenario is NOT approved.
CREATE FUNCTION scenario_parts_guard() RETURNS trigger
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
CREATE TRIGGER scenario_steps_guard BEFORE INSERT OR UPDATE OR DELETE ON scenario_steps FOR EACH ROW EXECUTE FUNCTION scenario_parts_guard();
CREATE TRIGGER scenario_step_items_guard BEFORE INSERT OR UPDATE OR DELETE ON scenario_step_items FOR EACH ROW EXECUTE FUNCTION scenario_parts_guard();

CREATE TABLE scenario_attempts (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  scenario_id       uuid NOT NULL,
  learner_card_id   uuid NOT NULL,
  learner_person_id uuid NOT NULL,
  owner_person_id   uuid NOT NULL,
  status            text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'graded', 'expired')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  submitted_at      timestamptz,
  graded_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES scenarios (tenant_id, id),
  FOREIGN KEY (tenant_id, learner_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, learner_person_id) REFERENCES people (tenant_id, id),
  CHECK (owner_person_id = learner_person_id),
  CHECK (expires_at > started_at),
  CHECK ((status IN ('submitted', 'graded')) = (submitted_at IS NOT NULL)),
  CHECK ((status = 'graded') = (graded_at IS NOT NULL))
);
CREATE INDEX scenario_attempts_learner ON scenario_attempts (tenant_id, learner_person_id, started_at);
CREATE INDEX scenario_attempts_scenario ON scenario_attempts (tenant_id, scenario_id, status);

CREATE FUNCTION scenario_attempts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'in_progress' THEN RAISE EXCEPTION 'scenario_attempts: an attempt starts in progress' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'in_progress' AND NEW.status IN ('submitted', 'expired'))
    OR (OLD.status = 'submitted' AND NEW.status = 'graded')) THEN
    RAISE EXCEPTION 'scenario_attempts: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'scenario_attempts: an attempt is submitted once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'in_progress' AND NEW.status = 'submitted' AND NEW.submitted_at > OLD.expires_at THEN
    RAISE EXCEPTION 'scenario_attempts: the time limit has passed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scenario_attempts_guard BEFORE INSERT OR UPDATE ON scenario_attempts FOR EACH ROW EXECUTE FUNCTION scenario_attempts_guard();

CREATE TABLE scenario_answers (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  attempt_id            uuid NOT NULL,
  step_id               uuid NOT NULL,
  position              smallint NOT NULL CHECK (position BETWEEN 1 AND 10),
  answer_text           text CHECK (answer_text IS NULL OR char_length(answer_text) <= 4000),
  ai_score              real CHECK (ai_score IS NULL OR ai_score BETWEEN 0 AND 1),
  ai_rubric_result      jsonb,
  ai_confidence         real CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
  final_score           real CHECK (final_score IS NULL OR final_score BETWEEN 0 AND 1),
  decided_by            text CHECK (decided_by IS NULL OR decided_by IN ('auto', 'ai', 'reviewer')),
  overridden_by_card_id uuid,
  graded_at             timestamptz,
  -- set by the retention sweep when it removed the learner's words and what the model said about them (scores stay)
  text_removed_at       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, attempt_id, position),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES scenario_attempts (tenant_id, id),
  FOREIGN KEY (tenant_id, step_id) REFERENCES scenario_steps (tenant_id, id),
  FOREIGN KEY (tenant_id, overridden_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK ((decided_by = 'reviewer') = (overridden_by_card_id IS NOT NULL)),
  CHECK ((final_score IS NULL) = (decided_by IS NULL))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scenarios', 'scenario_steps', 'scenario_step_items', 'scenario_attempts', 'scenario_answers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- HIDDEN is not ERASED. A scenario is hidden - it does not exist for anybody, in either service - while ANY of its
-- linked items is withdrawn and the words that may quote that item are still there. That is the time between a
-- consent withdrawal and its erasure step, however long (a legal hold suspends erasure). Erasure removes the link
-- (scenario_erasure.erase_for_items), so the answer is computed from the links and cannot go stale: a scenario whose
-- first item was erased long ago is hidden AGAIN when a second item is withdrawn under a hold.
-- `erased_at` only says that words tied to an erased item were blanked.
CREATE FUNCTION scenario_is_hidden(p_tenant uuid, p_scenario uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM scenario_steps st
      JOIN scenario_step_items si ON si.tenant_id = st.tenant_id AND si.step_id = st.id
      JOIN knowledge_items i ON i.tenant_id = si.tenant_id AND i.id = si.item_id
     WHERE st.tenant_id = p_tenant AND st.scenario_id = p_scenario AND i.status = 'withdrawn')
$$;

-- API: labels and links only, to ask the policy decision point about a row and to check the linked items against the
-- caller. Never the text of a scenario, a step, a rubric or an answer.
GRANT SELECT (id, tenant_id, job_role, status, department_id, sensitivity, owner_person_id, author_card_id, created_by_card_id, created_by_person_id,
              flag_reason, erased_at, updated_at) ON scenarios TO legacyai_app;
GRANT SELECT (id, tenant_id, scenario_id) ON scenario_steps TO legacyai_app;
GRANT SELECT ON scenario_step_items TO legacyai_app;
GRANT SELECT (id, tenant_id, scenario_id, learner_card_id, learner_person_id, owner_person_id, status) ON scenario_attempts TO legacyai_app;
GRANT SELECT (id, tenant_id, attempt_id) ON scenario_answers TO legacyai_app;

-- Python owns the tables.
GRANT SELECT, INSERT, UPDATE ON scenarios, scenario_attempts, scenario_answers TO legacyai_ai;
GRANT SELECT, INSERT, UPDATE, DELETE ON scenario_steps, scenario_step_items TO legacyai_ai;

-- A scenario states what verified knowledge expects, so it FOLLOWS its linked items:
--   an item leaves "verified"/"corrected" (reopened, rejected, stale ...) or is RE-LABELLED (level or department)
--     -> the scenario takes the items' labels (highest level; a department only if all share it), goes back to draft
--        with flag "item_changed" and needs a new approval;
--   an item is withdrawn (its contributor withdrew consent; migration 15 does that inside the database)
--     -> the scenario is retired with flag "item_withdrawn". It is HIDDEN from that moment by scenario_is_hidden()
--        above (the item is withdrawn and still linked) until the erasure step has removed the link. Nothing is blanked here: under a legal hold erasure is suspended
--        (docs/phase2/05), and without a hold the erasure step of the same request blanks the words that may quote
--        the item, together with the item's own text (services/ai/app/knowledge/scenario_erasure.py: erase_for_items).
-- In both cases runs still in progress end (expired): they are not graded against knowledge that changed.
-- ORDER inside the function matters: the scenario leaves "approved" BEFORE anything else could touch its steps
-- (scenario_parts_guard refuses changes to the parts of an approved scenario).
-- SECURITY DEFINER with the company taken from the row and put back, exactly as knowledge_items_end_conflicts():
-- the change may come from the API login (through the withdrawal trigger), which has no right on these tables.
CREATE FUNCTION knowledge_items_touch_scenarios() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev_tenant text;
  affected uuid[];
BEGIN
  prev_tenant := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  SELECT array_agg(DISTINCT st.scenario_id) INTO affected
    FROM scenario_step_items si JOIN scenario_steps st ON st.tenant_id = si.tenant_id AND st.id = si.step_id
   WHERE si.tenant_id = NEW.tenant_id AND si.item_id = NEW.id;
  IF affected IS NOT NULL THEN
    UPDATE scenario_attempts SET status = 'expired'
     WHERE tenant_id = NEW.tenant_id AND scenario_id = ANY (affected) AND status = 'in_progress';
    IF NEW.status = 'withdrawn' THEN
      UPDATE scenarios SET status = 'retired', flag_reason = 'item_withdrawn', updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND id = ANY (affected) AND status <> 'retired';
      UPDATE scenarios SET flag_reason = 'item_withdrawn', updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND id = ANY (affected) AND status = 'retired' AND flag_reason IS DISTINCT FROM 'item_withdrawn';
    ELSE
      UPDATE scenarios sc
         SET status = CASE WHEN sc.status = 'approved' THEN 'draft' ELSE sc.status END,
             flag_reason = CASE WHEN sc.status = 'approved' THEN 'item_changed' ELSE sc.flag_reason END,
             sensitivity = l.level, department_id = l.department, updated_at = now()
        FROM (SELECT st.scenario_id, max(i.sensitivity)::smallint AS level,
                     CASE WHEN count(DISTINCT i.department_id) = 1 AND count(*) = count(i.department_id)
                          THEN (array_agg(i.department_id))[1] END AS department
                FROM scenario_step_items si JOIN scenario_steps st ON st.tenant_id = si.tenant_id AND st.id = si.step_id
                JOIN knowledge_items i ON i.tenant_id = si.tenant_id AND i.id = si.item_id
               WHERE si.tenant_id = NEW.tenant_id AND st.scenario_id = ANY (affected)
               GROUP BY st.scenario_id) l
       -- retired scenarios too: they stay readable to the people who write scenarios, so their level must follow their items
       WHERE sc.tenant_id = NEW.tenant_id AND sc.id = l.scenario_id;
    END IF;
  END IF;
  PERFORM set_config('app.tenant_id', COALESCE(prev_tenant, ''), true);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION knowledge_items_touch_scenarios() FROM PUBLIC;
CREATE TRIGGER knowledge_items_touch_scenarios AFTER UPDATE OF status, sensitivity, department_id ON knowledge_items
  FOR EACH ROW WHEN ((OLD.status IS DISTINCT FROM NEW.status AND NEW.status NOT IN ('verified', 'corrected'))
                     OR OLD.sensitivity IS DISTINCT FROM NEW.sensitivity OR OLD.department_id IS DISTINCT FROM NEW.department_id)
  EXECUTE FUNCTION knowledge_items_touch_scenarios();

-- A step the model could not grade (or graded with low confidence) waits for a person: a "grading_override" task about
-- the scenario answer, exactly as for an open readiness answer.
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_subject_type_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_subject_type_check CHECK (subject_type IN ('knowledge_item', 'source', 'expert_question',
  'quiz_item', 'quiz_answer', 'answer', 'scenario_answer'));

-- Readiness questions get the second-person rule they lacked (Phase 2 gap, decision D28): who generated a question
-- and who last edited it are recorded, and neither may approve it. NULL for questions written before this migration.
ALTER TABLE quiz_items
  ADD COLUMN written_by_card_id uuid,
  ADD COLUMN written_by_person_id uuid,
  ADD COLUMN edited_by_card_id uuid,
  ADD COLUMN edited_by_person_id uuid,
  ADD CONSTRAINT quiz_items_written_by_card_fk FOREIGN KEY (tenant_id, written_by_card_id) REFERENCES cards (tenant_id, id),
  ADD CONSTRAINT quiz_items_written_by_person_fk FOREIGN KEY (tenant_id, written_by_person_id) REFERENCES people (tenant_id, id),
  ADD CONSTRAINT quiz_items_edited_by_card_fk FOREIGN KEY (tenant_id, edited_by_card_id) REFERENCES cards (tenant_id, id),
  ADD CONSTRAINT quiz_items_edited_by_person_fk FOREIGN KEY (tenant_id, edited_by_person_id) REFERENCES people (tenant_id, id);
GRANT SELECT (written_by_card_id, written_by_person_id, edited_by_card_id, edited_by_person_id) ON quiz_items TO legacyai_app;

-- The retention sweep (quiz_answer_retention_days) also applies to readiness answers; it marks what it emptied.
ALTER TABLE quiz_answers ADD COLUMN text_removed_at timestamptz;

-- migrate:down
ALTER TABLE quiz_answers DROP COLUMN text_removed_at;
ALTER TABLE quiz_items
  DROP CONSTRAINT quiz_items_written_by_card_fk, DROP CONSTRAINT quiz_items_written_by_person_fk,
  DROP CONSTRAINT quiz_items_edited_by_card_fk, DROP CONSTRAINT quiz_items_edited_by_person_fk,
  DROP COLUMN written_by_card_id, DROP COLUMN written_by_person_id, DROP COLUMN edited_by_card_id, DROP COLUMN edited_by_person_id;
-- Tasks about scenario answers, of every company, must go before the old constraint returns. The role that runs
-- migrations cannot bypass row-level security, so FORCE is lifted for this one statement and put back (same
-- transaction; see 20261004000100_quality.sql for the reasoning).
ALTER TABLE review_tasks NO FORCE ROW LEVEL SECURITY;
DELETE FROM review_tasks WHERE subject_type = 'scenario_answer';
ALTER TABLE review_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_subject_type_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_subject_type_check CHECK (subject_type IN ('knowledge_item', 'source', 'expert_question',
  'quiz_item', 'quiz_answer', 'answer'));
DROP TRIGGER knowledge_items_touch_scenarios ON knowledge_items;
DROP FUNCTION knowledge_items_touch_scenarios();
DROP TABLE scenario_answers;
DROP TABLE scenario_attempts;
DROP FUNCTION scenario_attempts_guard();
DROP FUNCTION scenario_is_hidden(uuid, uuid);
DROP TABLE scenario_step_items;
DROP TABLE scenario_steps;
DROP FUNCTION scenario_parts_guard();
DROP TABLE scenarios;
DROP FUNCTION scenarios_guard();
