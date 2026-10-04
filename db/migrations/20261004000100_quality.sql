-- migrate:up

-- Phase 4, features 23 (contradiction and staleness detection) and 22 (answer quality monitor).
-- docs/phase4/01-contradiction-staleness-quality.md

-- 1. The answer log says WHO found that the sources conflict (the check of values in code, or the AI model) and
--    whether an answer contained a source nobody has verified.
ALTER TABLE answer_logs
  ADD COLUMN conflict_found_by text CHECK (conflict_found_by IS NULL OR conflict_found_by IN ('value_check', 'ai_model')),
  ADD COLUMN contains_unverified_sources boolean NOT NULL DEFAULT false;
-- Refusals for a conflict recorded before this migration could only have been found by the model.
-- Rows of EVERY company must be changed here. The role that runs migrations cannot bypass row-level security, and
-- the policy is FORCED on the table's owner too, so with no company set an UPDATE would match nothing and the
-- constraint below would then fail on existing rows. For the length of this one statement the owner (and only the
-- owner - the logins of the two services are not the owner) is exempted; the same transaction forces it again.
ALTER TABLE answer_logs NO FORCE ROW LEVEL SECURITY;
UPDATE answer_logs SET conflict_found_by = 'ai_model' WHERE reason = 'sources_conflict';
ALTER TABLE answer_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE answer_logs
  ADD CONSTRAINT answer_logs_conflict_found CHECK ((reason IS NOT DISTINCT FROM 'sources_conflict') = (conflict_found_by IS NOT NULL)),
  ADD CONSTRAINT answer_logs_tenant_id_key UNIQUE (tenant_id, id);

-- 2. What a reader said about an answer. One opinion per card and answer; it goes when the answer log row goes
--    (the company's retention setting), so nothing outlives the answer it is about.
CREATE TABLE answer_feedback (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  answer_log_id    uuid NOT NULL,
  card_id          uuid NOT NULL,
  verdict          text NOT NULL CHECK (verdict IN ('helpful', 'unhelpful', 'wrong')),
  comment_redacted text CHECK (comment_redacted IS NULL OR char_length(comment_redacted) BETWEEN 1 AND 500),
  -- The reader's own choice: may the people who look after quality see the (redacted) question this answer was for?
  -- Off unless the reader says so; without it the question stays as unreadable to others as it was before this feature.
  question_shared  boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, answer_log_id, card_id),
  FOREIGN KEY (tenant_id, answer_log_id) REFERENCES answer_logs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);
CREATE INDEX answer_feedback_time ON answer_feedback (tenant_id, created_at);

-- 3. Verified items that state different values for the same thing. One row per pair (lower id first).
--    The values are words from the items' own (already redacted) text; the rows go when either item leaves the
--    verified state, is corrected so that the conflict no longer holds, or is erased.
CREATE TABLE knowledge_item_conflicts (
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  item_id       uuid NOT NULL,
  other_item_id uuid NOT NULL,
  measure       text NOT NULL CHECK (char_length(measure) BETWEEN 1 AND 60),
  item_value    text NOT NULL CHECK (char_length(item_value) BETWEEN 1 AND 200),
  other_value   text NOT NULL CHECK (char_length(other_value) BETWEEN 1 AND 200),
  detected_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id, other_item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES knowledge_items (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, other_item_id) REFERENCES knowledge_items (tenant_id, id) ON DELETE CASCADE,
  CHECK (item_id < other_item_id)
);
CREATE INDEX knowledge_item_conflicts_other ON knowledge_item_conflicts (tenant_id, other_item_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['answer_feedback', 'knowledge_item_conflicts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- Python owns both tables (as it owns the answer log and the items). The API login gets nothing: it reads them
-- through the AI service, like every other knowledge content.
GRANT SELECT, INSERT, UPDATE, DELETE ON answer_feedback, knowledge_item_conflicts TO legacyai_ai;

-- A conflict is a statement about two VERIFIED items. When an item stops being one - reopened, rejected, stale,
-- retired, or withdrawn because its contributor withdrew consent (migration 15 does that inside the database, in
-- the transaction that records the withdrawal) - its stored conflicts go in the same statement, with the words they
-- quoted from it, and a partner left without any conflict loses its task. Also under a legal hold: the hold keeps
-- the held material itself, not copies of its words in another table.
-- SECURITY DEFINER, and the company taken from the row and put back afterwards, exactly as in migration 15: the
-- status may be changed by the API login (through that withdrawal trigger), which has no right on these tables.
CREATE FUNCTION knowledge_items_end_conflicts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev_tenant text;
BEGIN
  prev_tenant := current_setting('app.tenant_id', true);
  PERFORM set_config('app.tenant_id', NEW.tenant_id::text, true);
  DELETE FROM knowledge_item_conflicts WHERE tenant_id = NEW.tenant_id AND (item_id = NEW.id OR other_item_id = NEW.id);
  UPDATE review_tasks t
     SET status = 'resolved', resolved_at = now(), resolution = 'conflict_cleared', assigned_to_card_id = NULL,
         first_response_at = COALESCE(first_response_at, now())
   WHERE t.tenant_id = NEW.tenant_id AND t.kind = 'item_conflict' AND t.status IN ('open', 'assigned')
     AND NOT EXISTS (SELECT 1 FROM knowledge_item_conflicts c
                      WHERE c.tenant_id = t.tenant_id AND (c.item_id = t.subject_id OR c.other_item_id = t.subject_id));
  PERFORM set_config('app.tenant_id', COALESCE(prev_tenant, ''), true);
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION knowledge_items_end_conflicts() FROM PUBLIC;
CREATE TRIGGER knowledge_items_end_conflicts AFTER UPDATE OF status ON knowledge_items
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status NOT IN ('verified', 'corrected'))
  EXECUTE FUNCTION knowledge_items_end_conflicts();

-- 4. Two new kinds of review task: two verified items disagree; a reader marked an answer wrong.
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_kind_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_kind_check CHECK (kind IN ('verify_item', 'redaction_review', 'expert_question',
  'quiz_item_approval', 'grading_override', 'stale_item', 'item_conflict', 'answer_feedback'));
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_subject_type_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_subject_type_check CHECK (subject_type IN ('knowledge_item', 'source', 'expert_question',
  'quiz_item', 'quiz_answer', 'answer'));

-- The audit trail may now say what a reader's opinion was and whether the question was shared (never the comment or
-- the question itself). audit_write() refuses any detail key that is not listed here.
INSERT INTO audit_detail_keys (key) VALUES ('verdict'), ('question_shared');

-- migrate:down
DELETE FROM audit_detail_keys WHERE key IN ('verdict', 'question_shared');
-- Tasks of the two new kinds, of every company, must go before the old constraints return (see the note in "up").
ALTER TABLE review_tasks NO FORCE ROW LEVEL SECURITY;
DELETE FROM review_tasks WHERE kind IN ('item_conflict', 'answer_feedback') OR subject_type = 'answer';
ALTER TABLE review_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_subject_type_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_subject_type_check CHECK (subject_type IN ('knowledge_item', 'source', 'expert_question',
  'quiz_item', 'quiz_answer'));
ALTER TABLE review_tasks DROP CONSTRAINT review_tasks_kind_check;
ALTER TABLE review_tasks ADD CONSTRAINT review_tasks_kind_check CHECK (kind IN ('verify_item', 'redaction_review', 'expert_question',
  'quiz_item_approval', 'grading_override', 'stale_item'));
DROP TRIGGER knowledge_items_end_conflicts ON knowledge_items;
DROP FUNCTION knowledge_items_end_conflicts();
DROP TABLE knowledge_item_conflicts;
DROP TABLE answer_feedback;
ALTER TABLE answer_logs
  DROP CONSTRAINT answer_logs_tenant_id_key,
  DROP CONSTRAINT answer_logs_conflict_found,
  DROP COLUMN contains_unverified_sources,
  DROP COLUMN conflict_found_by;
