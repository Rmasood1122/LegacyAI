-- migrate:up

-- Phase 2 readiness tests (feature 13), review queue (feature 24), and relabel() (docs/phase2/03).

CREATE TABLE quiz_items (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  topic_id             uuid,
  knowledge_item_id    uuid NOT NULL,
  knowledge_version_id uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('mcq', 'open')),
  stem                 text NOT NULL,
  options              jsonb,
  correct_option       smallint,
  rubric               jsonb,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  department_id        uuid,
  sensitivity          smallint NOT NULL CHECK (sensitivity BETWEEN 0 AND 3),
  owner_person_id      uuid,
  approved_by_card_id  uuid,
  approved_at          timestamptz,
  prompt_version       text,
  erased_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, topic_id) REFERENCES topics (tenant_id, id),
  FOREIGN KEY (tenant_id, knowledge_item_id) REFERENCES knowledge_items (tenant_id, id),
  FOREIGN KEY (tenant_id, knowledge_version_id) REFERENCES knowledge_versions (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK (char_length(stem) BETWEEN 1 AND 2000 OR (erased_at IS NOT NULL AND stem = '')),
  CHECK (kind <> 'mcq' OR erased_at IS NOT NULL OR (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4
                                                    AND correct_option BETWEEN 0 AND 3)),
  CHECK (kind <> 'open' OR erased_at IS NOT NULL OR jsonb_typeof(rubric) = 'array'),
  CHECK ((status = 'approved') <= (approved_by_card_id IS NOT NULL))
);
CREATE INDEX quiz_items_topic ON quiz_items (tenant_id, topic_id, status);
CREATE INDEX quiz_items_item ON quiz_items (tenant_id, knowledge_item_id);

CREATE FUNCTION quiz_items_guard() RETURNS trigger
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
CREATE TRIGGER quiz_items_guard BEFORE INSERT OR UPDATE ON quiz_items FOR EACH ROW EXECUTE FUNCTION quiz_items_guard();

CREATE TABLE quiz_attempts (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  learner_card_id   uuid NOT NULL,
  learner_person_id uuid NOT NULL,
  owner_person_id   uuid NOT NULL,
  job_role          text NOT NULL CHECK (char_length(job_role) BETWEEN 1 AND 120),
  status            text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'graded', 'expired')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  submitted_at      timestamptz,
  graded_at         timestamptz,
  scores            jsonb,
  bank_size         integer NOT NULL DEFAULT 0 CHECK (bank_size >= 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, learner_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, learner_person_id) REFERENCES people (tenant_id, id),
  CHECK (owner_person_id = learner_person_id),
  CHECK (expires_at > started_at),
  CHECK ((status IN ('submitted', 'graded')) = (submitted_at IS NOT NULL)),
  CHECK ((status = 'graded') = (graded_at IS NOT NULL))
);
CREATE INDEX quiz_attempts_learner ON quiz_attempts (tenant_id, learner_person_id, started_at);

CREATE FUNCTION quiz_attempts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'in_progress' THEN RAISE EXCEPTION 'quiz_attempts: an attempt starts in progress' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'in_progress' AND NEW.status IN ('submitted', 'expired'))
    OR (OLD.status = 'submitted' AND NEW.status = 'graded')) THEN
    RAISE EXCEPTION 'quiz_attempts: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'quiz_attempts: an attempt is submitted once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'in_progress' AND NEW.status = 'submitted' AND NEW.submitted_at > OLD.expires_at THEN
    RAISE EXCEPTION 'quiz_attempts: the time limit has passed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER quiz_attempts_guard BEFORE INSERT OR UPDATE ON quiz_attempts FOR EACH ROW EXECUTE FUNCTION quiz_attempts_guard();

CREATE TABLE quiz_answers (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  attempt_id            uuid NOT NULL,
  quiz_item_id          uuid NOT NULL,
  position              smallint NOT NULL CHECK (position >= 1),
  option_order          smallint[],
  chosen_option         smallint,
  answer_text           text CHECK (answer_text IS NULL OR char_length(answer_text) <= 4000),
  auto_score            real CHECK (auto_score IS NULL OR auto_score BETWEEN 0 AND 1),
  ai_score              real CHECK (ai_score IS NULL OR ai_score BETWEEN 0 AND 1),
  ai_rubric_result      jsonb,
  ai_confidence         real CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
  final_score           real CHECK (final_score IS NULL OR final_score BETWEEN 0 AND 1),
  decided_by            text CHECK (decided_by IS NULL OR decided_by IN ('auto', 'ai', 'reviewer')),
  overridden_by_card_id uuid,
  graded_at             timestamptz,
  UNIQUE (tenant_id, attempt_id, quiz_item_id),
  UNIQUE (tenant_id, attempt_id, position),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES quiz_attempts (tenant_id, id),
  FOREIGN KEY (tenant_id, quiz_item_id) REFERENCES quiz_items (tenant_id, id),
  FOREIGN KEY (tenant_id, overridden_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK ((decided_by = 'reviewer') = (overridden_by_card_id IS NOT NULL)),
  CHECK ((final_score IS NULL) = (decided_by IS NULL))
);

-- --------------------------------------------------------------- review queue
CREATE TABLE review_tasks (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  kind                 text NOT NULL CHECK (kind IN ('verify_item', 'redaction_review', 'expert_question', 'quiz_item_approval',
                                                     'grading_override', 'stale_item')),
  subject_type         text NOT NULL CHECK (subject_type IN ('knowledge_item', 'source', 'expert_question', 'quiz_item', 'quiz_answer')),
  subject_id           uuid NOT NULL,
  department_id        uuid,
  sensitivity          smallint NOT NULL CHECK (sensitivity BETWEEN 0 AND 3),
  owner_person_id      uuid,
  visible_to_person_id uuid,
  priority             integer NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved', 'dismissed')),
  assigned_to_card_id  uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  due_at               timestamptz NOT NULL,
  first_response_at    timestamptz,
  resolved_at          timestamptz,
  resolved_by_card_id  uuid,
  resolution           text CHECK (resolution IS NULL OR resolution ~ '^[a-z_]{1,40}$'),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, visible_to_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_to_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK ((status = 'assigned') = (assigned_to_card_id IS NOT NULL)),
  CHECK ((status IN ('resolved', 'dismissed')) = (resolved_at IS NOT NULL)),
  CHECK ((kind = 'expert_question') = (visible_to_person_id IS NOT NULL))
);
CREATE INDEX review_tasks_queue ON review_tasks (tenant_id, status, priority DESC, created_at);
CREATE UNIQUE INDEX review_tasks_one_open ON review_tasks (tenant_id, kind, subject_id) WHERE status IN ('open', 'assigned');

CREATE FUNCTION review_tasks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN RAISE EXCEPTION 'review_tasks: a new task is open' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id THEN
    RAISE EXCEPTION 'review_tasks: a task''s subject does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity
      OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'review_tasks: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('assigned', 'resolved', 'dismissed'))
    OR (OLD.status = 'assigned' AND NEW.status IN ('open', 'resolved', 'dismissed'))) THEN
    RAISE EXCEPTION 'review_tasks: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- Some tasks end only by acting on their subject, so a subject cannot be left waiting with no task.
  IF NEW.status = 'dismissed' AND NEW.kind IN ('verify_item', 'expert_question', 'quiz_item_approval') THEN
    RAISE EXCEPTION 'review_tasks: a % task cannot be dismissed', NEW.kind USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER review_tasks_guard BEFORE INSERT OR UPDATE ON review_tasks FOR EACH ROW EXECUTE FUNCTION review_tasks_guard();

-- ------------------------------------------------------------------- relabel
-- The ONLY way to change access labels. Updates every copy in one transaction (docs/phase2/03):
--   source -> its chunks -> items derived from it are raised to at least the new sensitivity
--   item   -> its search chunk, its test questions, its review tasks
CREATE FUNCTION relabel(p_kind text, p_id uuid, p_department uuid, p_sensitivity smallint) RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_tenant();
  affected integer := 0;
  item_ids uuid[];
  n integer;
BEGIN
  IF p_sensitivity IS NULL OR p_sensitivity < 0 OR p_sensitivity > 3 THEN
    RAISE EXCEPTION 'relabel: sensitivity must be 0-3' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('app.relabel', 'on', true);
  IF p_kind = 'source' THEN
    UPDATE sources SET department_id = p_department, sensitivity = p_sensitivity WHERE tenant_id = tenant AND id = p_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'relabel: no such source' USING ERRCODE = 'no_data_found'; END IF;
    UPDATE chunks SET department_id = p_department, sensitivity = p_sensitivity
     WHERE tenant_id = tenant AND kind = 'source' AND source_id = p_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    affected := affected + n;
    -- items derived from this source never stay less restricted than it
    SELECT array_agg(DISTINCT v.item_id) INTO item_ids
      FROM citations ci
      JOIN chunks c ON c.tenant_id = ci.tenant_id AND c.id = ci.chunk_id
      JOIN knowledge_versions v ON v.tenant_id = ci.tenant_id AND v.id = ci.subject_id
     WHERE ci.tenant_id = tenant AND ci.subject_type = 'knowledge_version' AND c.source_id = p_id;
    IF item_ids IS NOT NULL THEN
      UPDATE knowledge_items SET sensitivity = p_sensitivity
       WHERE tenant_id = tenant AND id = ANY (item_ids) AND sensitivity < p_sensitivity;
      GET DIAGNOSTICS n = ROW_COUNT;
      affected := affected + n;
    END IF;
  ELSIF p_kind = 'item' THEN
    UPDATE knowledge_items SET department_id = p_department, sensitivity = p_sensitivity WHERE tenant_id = tenant AND id = p_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'relabel: no such item' USING ERRCODE = 'no_data_found'; END IF;
    item_ids := ARRAY[p_id];
  ELSE
    RAISE EXCEPTION 'relabel: kind must be source or item' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF item_ids IS NOT NULL THEN
    UPDATE chunks c SET department_id = i.department_id, sensitivity = i.sensitivity
      FROM knowledge_items i
     WHERE c.tenant_id = tenant AND c.kind = 'item' AND i.tenant_id = tenant AND i.id = c.knowledge_item_id AND i.id = ANY (item_ids)
       AND (c.department_id IS DISTINCT FROM i.department_id OR c.sensitivity <> i.sensitivity);
    GET DIAGNOSTICS n = ROW_COUNT;
    affected := affected + n;
    UPDATE quiz_items q SET department_id = i.department_id, sensitivity = i.sensitivity
      FROM knowledge_items i
     WHERE q.tenant_id = tenant AND i.tenant_id = tenant AND i.id = q.knowledge_item_id AND i.id = ANY (item_ids)
       AND (q.department_id IS DISTINCT FROM i.department_id OR q.sensitivity <> i.sensitivity);
    GET DIAGNOSTICS n = ROW_COUNT;
    affected := affected + n;
    UPDATE review_tasks r SET department_id = i.department_id, sensitivity = i.sensitivity
      FROM knowledge_items i
     WHERE r.tenant_id = tenant AND r.subject_type = 'knowledge_item' AND i.tenant_id = tenant AND i.id = r.subject_id
       AND i.id = ANY (item_ids) AND (r.department_id IS DISTINCT FROM i.department_id OR r.sensitivity <> i.sensitivity);
    GET DIAGNOSTICS n = ROW_COUNT;
    affected := affected + n;
  END IF;
  PERFORM set_config('app.relabel', 'off', true);
  RETURN affected;
END
$$;
REVOKE ALL ON FUNCTION relabel(text, uuid, uuid, smallint) FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quiz_items', 'quiz_attempts', 'quiz_answers', 'review_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- API: never the questions' content or answers.
GRANT SELECT (id, tenant_id, topic_id, knowledge_item_id, kind, status, department_id, sensitivity, owner_person_id,
              approved_by_card_id, approved_at, created_at) ON quiz_items TO legacyai_app;
GRANT SELECT (id, tenant_id, learner_card_id, learner_person_id, owner_person_id, job_role, status, started_at, expires_at,
              submitted_at, graded_at, bank_size) ON quiz_attempts TO legacyai_app;
GRANT SELECT ON review_tasks TO legacyai_app;
GRANT UPDATE (status, assigned_to_card_id, first_response_at, resolved_at, resolved_by_card_id, resolution) ON review_tasks TO legacyai_app;

-- Python.
GRANT SELECT, INSERT, UPDATE ON quiz_items, quiz_attempts, quiz_answers, review_tasks TO legacyai_ai;
GRANT EXECUTE ON FUNCTION relabel(text, uuid, uuid, smallint) TO legacyai_ai;

-- migrate:down
DROP FUNCTION relabel(text, uuid, uuid, smallint);
DROP TABLE review_tasks;
DROP FUNCTION review_tasks_guard();
DROP TABLE quiz_answers;
DROP TABLE quiz_attempts;
DROP FUNCTION quiz_attempts_guard();
DROP TABLE quiz_items;
DROP FUNCTION quiz_items_guard();
