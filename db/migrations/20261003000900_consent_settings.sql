-- migrate:up

-- Phase 2 (feature 19, settings for 12/13/18). Owner module: API knowledge-gateway.

-- ------------------------------------------------------------------ consents
CREATE TABLE consents (
  id                             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                      uuid NOT NULL REFERENCES tenants (id),
  person_id                      uuid NOT NULL,
  scope                          text NOT NULL CHECK (scope IN ('own_words', 'documents', 'named_expert')),
  purpose                        text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 500),
  policy_version                 text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 40),
  granted_at                     timestamptz NOT NULL DEFAULT now(),
  granted_by_card_id             uuid NOT NULL,
  expires_at                     timestamptz,
  superseded_at                  timestamptz,
  withdrawn_at                   timestamptz,
  withdrawn_by_card_id           uuid,
  withdrawal_recorded_for_person boolean NOT NULL DEFAULT false,
  withdrawal_reference           text CHECK (withdrawal_reference IS NULL OR withdrawal_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$'),
  withdrawal_status              text NOT NULL DEFAULT 'none' CHECK (withdrawal_status IN ('none', 'hidden', 'completed', 'held')),
  legal_hold                     boolean NOT NULL DEFAULT false,
  legal_hold_by_card_id          uuid,
  legal_hold_at                  timestamptz,
  legal_hold_reason              text CHECK (legal_hold_reason IS NULL OR char_length(legal_hold_reason) BETWEEN 1 AND 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, granted_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, withdrawn_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_hold_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > granted_at),
  CHECK ((withdrawn_at IS NULL) = (withdrawn_by_card_id IS NULL)),
  CHECK (withdrawal_status = 'none' OR withdrawn_at IS NOT NULL),
  CHECK (NOT withdrawal_recorded_for_person OR withdrawal_reference IS NOT NULL),
  CHECK (NOT legal_hold OR (legal_hold_by_card_id IS NOT NULL AND legal_hold_at IS NOT NULL AND legal_hold_reason IS NOT NULL))
);
CREATE UNIQUE INDEX consents_one_live ON consents (tenant_id, person_id, scope) WHERE withdrawn_at IS NULL AND superseded_at IS NULL;
CREATE INDEX consents_person ON consents (tenant_id, person_id);

-- The single definition of "valid": granted, not withdrawn, not superseded, not expired.
CREATE FUNCTION consent_is_valid(p_tenant uuid, p_person uuid, p_scope text, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM consents
     WHERE tenant_id = p_tenant AND person_id = p_person AND scope = p_scope
       AND withdrawn_at IS NULL AND superseded_at IS NULL
       AND granted_at <= p_at AND (expires_at IS NULL OR expires_at > p_at))
$$;

-- Consent is given by the person's OWN card; nobody ticks the box for someone else.
-- A withdrawal is recorded by the person's own card, or - flagged and with a reference - by an Owner
-- for a person who has left (the API checks that the actor is an Owner).
CREATE FUNCTION consents_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE holder uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT person_id INTO holder FROM cards WHERE tenant_id = NEW.tenant_id AND id = NEW.granted_by_card_id;
    IF holder IS DISTINCT FROM NEW.person_id THEN
      RAISE EXCEPTION 'consent can only be given with the person''s own card' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL OR NEW.superseded_at IS NOT NULL OR NEW.legal_hold THEN
      RAISE EXCEPTION 'a new consent starts live' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the content of a consent never changes; only its end and the hold.
  IF NEW.person_id <> OLD.person_id OR NEW.scope <> OLD.scope OR NEW.purpose <> OLD.purpose
     OR NEW.policy_version <> OLD.policy_version OR NEW.granted_at <> OLD.granted_at
     OR NEW.granted_by_card_id <> OLD.granted_by_card_id OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a consent cannot be edited; give a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'a withdrawal cannot be undone' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL AND NOT NEW.withdrawal_recorded_for_person THEN
    SELECT person_id INTO holder FROM cards WHERE tenant_id = NEW.tenant_id AND id = NEW.withdrawn_by_card_id;
    IF holder IS DISTINCT FROM NEW.person_id THEN
      RAISE EXCEPTION 'consent can only be withdrawn with the person''s own card, or recorded for them by an Owner'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER consents_guard BEFORE INSERT OR UPDATE ON consents FOR EACH ROW EXECUTE FUNCTION consents_guard();

-- --------------------------------------------------------- knowledge settings
CREATE TABLE knowledge_settings (
  tenant_id                        uuid PRIMARY KEY REFERENCES tenants (id),
  chunk_quota                      integer NOT NULL DEFAULT 5000 CHECK (chunk_quota BETWEEN 0 AND 50000),
  max_upload_bytes                 integer NOT NULL DEFAULT 5242880 CHECK (max_upload_bytes BETWEEN 1024 AND 10485760),
  max_pdf_pages                    integer NOT NULL DEFAULT 50 CHECK (max_pdf_pages BETWEEN 1 AND 200),
  store_originals                  boolean NOT NULL DEFAULT false CHECK (store_originals = false),
  second_reviewer_required         boolean NOT NULL DEFAULT true,
  verifications_per_hour           integer NOT NULL DEFAULT 30 CHECK (verifications_per_hour BETWEEN 1 AND 1000),
  verifications_per_day            integer NOT NULL DEFAULT 100 CHECK (verifications_per_day BETWEEN 1 AND 10000),
  learner_sources                  text NOT NULL DEFAULT 'verified_only' CHECK (learner_sources IN ('verified_only', 'all_marked')),
  stale_after_days                 integer NOT NULL DEFAULT 365 CHECK (stale_after_days BETWEEN 7 AND 3650),
  review_sla_days                  integer NOT NULL DEFAULT 5 CHECK (review_sla_days BETWEEN 1 AND 90),
  answer_log_retention_days        integer NOT NULL DEFAULT 90 CHECK (answer_log_retention_days BETWEEN 1 AND 365),
  quiz_answer_retention_days       integer NOT NULL DEFAULT 365 CHECK (quiz_answer_retention_days BETWEEN 30 AND 3650),
  interview_max_turns              integer NOT NULL DEFAULT 30 CHECK (interview_max_turns BETWEEN 1 AND 100),
  interview_max_cost_micro_usd     bigint NOT NULL DEFAULT 250000 CHECK (interview_max_cost_micro_usd BETWEEN 0 AND 10000000),
  expert_question_expiry_days      integer NOT NULL DEFAULT 30 CHECK (expert_question_expiry_days BETWEEN 1 AND 365),
  quiz_questions_per_attempt       integer NOT NULL DEFAULT 10 CHECK (quiz_questions_per_attempt BETWEEN 1 AND 50),
  quiz_time_limit_minutes          integer NOT NULL DEFAULT 45 CHECK (quiz_time_limit_minutes BETWEEN 5 AND 240),
  quiz_min_questions_per_topic     integer NOT NULL DEFAULT 3 CHECK (quiz_min_questions_per_topic BETWEEN 1 AND 20),
  quiz_show_answers_after_grading  boolean NOT NULL DEFAULT false,
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  updated_by_card_id               uuid
);
-- A tenant without a row gets these defaults: the row is created on first use (the migration role
-- cannot see other tenants, so existing tenants are not back-filled here).

-- -------------------------------------------------------- redaction allow-list
CREATE TABLE redaction_allowlist (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  term             text NOT NULL CHECK (char_length(term) BETWEEN 1 AND 80
                                        AND term !~ '@' AND term !~ '[0-9]{4}'),   -- never an email or a number
  entity_type      text NOT NULL CHECK (entity_type IN ('PERSON', 'LOCATION', 'ORGANIZATION', 'OTHER')),
  added_by_card_id uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, added_by_card_id) REFERENCES cards (tenant_id, id)
);
CREATE UNIQUE INDEX redaction_allowlist_term ON redaction_allowlist (tenant_id, lower(term), entity_type);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['consents', 'knowledge_settings', 'redaction_allowlist'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON consents, knowledge_settings TO legacyai_app;
GRANT SELECT, INSERT, DELETE ON redaction_allowlist TO legacyai_app;
GRANT SELECT ON consents, knowledge_settings, redaction_allowlist TO legacyai_ai;
GRANT EXECUTE ON FUNCTION consent_is_valid(uuid, uuid, text, timestamptz) TO legacyai_app, legacyai_ai;

-- migrate:down
DROP TABLE redaction_allowlist;
DROP TABLE knowledge_settings;
DROP TABLE consents;
DROP FUNCTION consents_guard();
DROP FUNCTION consent_is_valid(uuid, uuid, text, timestamptz);
