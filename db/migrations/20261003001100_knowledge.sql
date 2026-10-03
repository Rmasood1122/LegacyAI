-- migrate:up

-- Phase 2 knowledge (features 12, 14, 15, 22). Owner module: Python knowledge.

CREATE TABLE knowledge_items (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  title               text NOT NULL,
  current_version_id  uuid,                -- set right after the first version is written
  status              text NOT NULL DEFAULT 'candidate'
                        CHECK (status IN ('candidate', 'in_review', 'verified', 'corrected', 'rejected', 'stale', 'withdrawn')),
  origin              text NOT NULL CHECK (origin IN ('interview', 'document', 'expert_reply', 'manual')),
  ai_extracted        boolean NOT NULL DEFAULT false,
  department_id       uuid,
  sensitivity         smallint NOT NULL DEFAULT 1 CHECK (sensitivity BETWEEN 0 AND 3),
  owner_person_id     uuid,
  consent_id          uuid,
  created_by_card_id  uuid,
  verified_by_card_id uuid,
  verified_at         timestamptz,
  self_verified       boolean NOT NULL DEFAULT false,
  stale_after         timestamptz,
  usage_count         integer NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES consents (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, verified_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK (char_length(title) BETWEEN 1 AND 200 OR (status = 'withdrawn' AND title = '')),
  CHECK ((owner_person_id IS NULL) = (consent_id IS NULL)),
  CHECK ((verified_by_card_id IS NULL) = (verified_at IS NULL)),
  CHECK (status NOT IN ('verified', 'corrected') OR verified_by_card_id IS NOT NULL)
);
CREATE INDEX knowledge_items_status ON knowledge_items (tenant_id, status);
CREATE INDEX knowledge_items_owner ON knowledge_items (tenant_id, owner_person_id);
CREATE INDEX knowledge_items_usage ON knowledge_items (tenant_id, status, usage_count DESC);

CREATE TABLE knowledge_versions (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  item_id          uuid NOT NULL,
  version_no       integer NOT NULL CHECK (version_no >= 1),
  body             text NOT NULL,
  change_kind      text NOT NULL CHECK (change_kind IN ('extracted', 'written', 'corrected', 'expert_reply', 'rollback')),
  author_card_id   uuid,
  author_person_id uuid,
  prompt_version   text,
  erased_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, item_id, version_no),
  FOREIGN KEY (tenant_id, item_id) REFERENCES knowledge_items (tenant_id, id),
  FOREIGN KEY (tenant_id, author_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, author_person_id) REFERENCES people (tenant_id, id),
  CHECK (char_length(body) BETWEEN 1 AND 2000 OR (erased_at IS NOT NULL AND body = ''))
);

ALTER TABLE knowledge_items ADD FOREIGN KEY (tenant_id, current_version_id) REFERENCES knowledge_versions (tenant_id, id);
ALTER TABLE chunks ADD FOREIGN KEY (tenant_id, knowledge_item_id) REFERENCES knowledge_items (tenant_id, id);

-- Versions never change. The only exception is erase_version(), used by consent withdrawal.
CREATE FUNCTION knowledge_versions_immutable() RETURNS trigger
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
CREATE TRIGGER knowledge_versions_immutable BEFORE UPDATE OR DELETE ON knowledge_versions
  FOR EACH ROW EXECUTE FUNCTION knowledge_versions_immutable();

CREATE FUNCTION erase_version(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$ UPDATE knowledge_versions SET body = '', erased_at = now() WHERE id = p_id AND erased_at IS NULL $$;
REVOKE ALL ON FUNCTION erase_version(uuid) FROM PUBLIC;

-- The item state machine (docs/phase2/06), the consent rule, and - as a second line behind the policy
-- decision point - the no-self-review rule. SECURITY DEFINER: the Python login may not read cards.
CREATE FUNCTION knowledge_items_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v knowledge_versions%ROWTYPE;
  c consents%ROWTYPE;
  verifier uuid;
  four_eyes boolean;
  needed_scope text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'candidate' OR NEW.verified_by_card_id IS NOT NULL THEN
      RAISE EXCEPTION 'knowledge_items: a new item starts as an unverified candidate' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.owner_person_id IS NOT NULL THEN
      needed_scope := CASE WHEN NEW.origin = 'document' THEN 'documents' ELSE 'own_words' END;
      SELECT * INTO c FROM consents WHERE tenant_id = NEW.tenant_id AND id = NEW.consent_id;
      IF c.person_id IS DISTINCT FROM NEW.owner_person_id OR c.scope IS DISTINCT FROM needed_scope
         OR NOT consent_is_valid(NEW.tenant_id, NEW.owner_person_id, needed_scope, now()) THEN
        RAISE EXCEPTION 'knowledge_items: no valid consent from the contributor' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.origin <> OLD.origin OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.consent_id IS DISTINCT FROM OLD.consent_id THEN
    RAISE EXCEPTION 'knowledge_items: origin and contributor do not change' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'knowledge_items: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'candidate' AND NEW.status IN ('in_review', 'rejected', 'withdrawn'))
    OR (OLD.status = 'in_review' AND NEW.status IN ('verified', 'corrected', 'rejected', 'withdrawn'))
    OR (OLD.status IN ('verified', 'corrected') AND NEW.status IN ('stale', 'in_review', 'withdrawn'))
    OR (OLD.status = 'stale' AND NEW.status IN ('in_review', 'rejected', 'withdrawn'))
    OR (OLD.status = 'rejected' AND NEW.status IN ('in_review', 'withdrawn'))) THEN
    RAISE EXCEPTION 'knowledge_items: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IN ('verified', 'corrected') AND OLD.status = 'in_review' THEN
    SELECT * INTO v FROM knowledge_versions WHERE tenant_id = NEW.tenant_id AND id = NEW.current_version_id;
    IF v.id IS NULL THEN
      RAISE EXCEPTION 'knowledge_items: nothing to verify' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.status = 'corrected') <> (v.change_kind = 'corrected') THEN
      RAISE EXCEPTION 'knowledge_items: "corrected" is for a corrected version, "verified" for the original text' USING ERRCODE = 'check_violation';
    END IF;
    SELECT person_id INTO verifier FROM cards WHERE tenant_id = NEW.tenant_id AND id = NEW.verified_by_card_id;
    SELECT COALESCE((SELECT second_reviewer_required FROM knowledge_settings WHERE tenant_id = NEW.tenant_id), true) INTO four_eyes;
    IF verifier IS NOT NULL AND (verifier = NEW.owner_person_id OR verifier = v.author_person_id) THEN
      IF four_eyes THEN
        RAISE EXCEPTION 'knowledge_items: the verifier must be neither the contributor nor the author of this version'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.self_verified := true;
    ELSE
      NEW.self_verified := false;
    END IF;
  END IF;
  IF NEW.status IN ('candidate', 'in_review', 'rejected') THEN
    NEW.verified_by_card_id := NULL;
    NEW.verified_at := NULL;
    NEW.self_verified := false;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION knowledge_items_guard() FROM PUBLIC;
CREATE TRIGGER knowledge_items_guard BEFORE INSERT OR UPDATE ON knowledge_items FOR EACH ROW EXECUTE FUNCTION knowledge_items_guard();

CREATE TABLE knowledge_item_topics (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  item_id     uuid NOT NULL,
  topic_id    uuid NOT NULL,
  link_source text NOT NULL CHECK (link_source IN ('similarity', 'reviewer')),
  score       real CHECK (score IS NULL OR score BETWEEN -1 AND 1),
  PRIMARY KEY (tenant_id, item_id, topic_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES knowledge_items (tenant_id, id),
  FOREIGN KEY (tenant_id, topic_id) REFERENCES topics (tenant_id, id)
);

CREATE TABLE citations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  subject_type text NOT NULL CHECK (subject_type IN ('knowledge_version', 'answer', 'quiz_item')),
  subject_id   uuid NOT NULL,
  chunk_id     uuid NOT NULL,
  quote_start  integer NOT NULL CHECK (quote_start >= 0),
  quote_end    integer NOT NULL,
  quote_sha256 bytea NOT NULL CHECK (octet_length(quote_sha256) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES chunks (tenant_id, id) ON DELETE CASCADE,
  CHECK (quote_end > quote_start)
);
CREATE INDEX citations_subject ON citations (tenant_id, subject_type, subject_id);
CREATE INDEX citations_chunk ON citations (tenant_id, chunk_id);

-- An item is never less restricted than what it was derived from (docs/phase2/03).
CREATE FUNCTION citations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE item_sens smallint; chunk_sens smallint;
BEGIN
  IF NEW.subject_type = 'knowledge_version' THEN
    SELECT i.sensitivity INTO item_sens FROM knowledge_versions v JOIN knowledge_items i ON i.tenant_id = v.tenant_id AND i.id = v.item_id
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.subject_id;
    SELECT sensitivity INTO chunk_sens FROM chunks WHERE tenant_id = NEW.tenant_id AND id = NEW.chunk_id;
    IF item_sens IS NULL OR chunk_sens IS NULL THEN
      RAISE EXCEPTION 'citations: unknown version or chunk' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF item_sens < chunk_sens THEN
      RAISE EXCEPTION 'citations: an item may not be less restricted than its source (% < %)', item_sens, chunk_sens
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER citations_guard BEFORE INSERT ON citations FOR EACH ROW EXECUTE FUNCTION citations_guard();

CREATE TABLE answer_logs (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  card_id              uuid NOT NULL,
  question_redacted    text NOT NULL CHECK (char_length(question_redacted) BETWEEN 1 AND 500),
  expert_person_id     uuid,
  outcome              text NOT NULL CHECK (outcome IN ('answered', 'dont_know', 'search_only')),
  reason               text CHECK (reason IS NULL OR reason IN ('no_relevant_sources', 'not_grounded', 'sources_conflict',
                         'low_confidence', 'budget_exhausted', 'ai_disabled', 'ai_unavailable', 'grace')),
  confidence           text CHECK (confidence IS NULL OR confidence IN ('high', 'medium')),
  candidates           integer NOT NULL DEFAULT 0,
  approved             integer NOT NULL DEFAULT 0,
  policy_disagreements integer NOT NULL DEFAULT 0,
  claims_valid         integer NOT NULL DEFAULT 0,
  claims_rejected      integer NOT NULL DEFAULT 0,
  fabricated_citation  boolean NOT NULL DEFAULT false,
  prompt_version       text,
  ledger_id            uuid,
  latency_ms           integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, expert_person_id) REFERENCES people (tenant_id, id),
  CHECK ((outcome = 'answered') = (confidence IS NOT NULL))
);
CREATE INDEX answer_logs_time ON answer_logs (tenant_id, created_at);

CREATE TABLE expert_questions (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  asked_by_card_id  uuid NOT NULL,
  expert_person_id  uuid NOT NULL,
  owner_person_id   uuid NOT NULL,
  question_redacted text NOT NULL,
  department_id     uuid,
  sensitivity       smallint NOT NULL DEFAULT 1 CHECK (sensitivity BETWEEN 0 AND 3),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'declined', 'expired')),
  decline_reason    text CHECK (decline_reason IS NULL OR decline_reason IN ('not_my_area', 'not_allowed_to_share', 'unclear', 'other')),
  answer_item_id    uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  answered_at       timestamptz,
  expires_at        timestamptz NOT NULL,
  erased_at         timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, asked_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, expert_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, answer_item_id) REFERENCES knowledge_items (tenant_id, id),
  CHECK (owner_person_id = expert_person_id),
  CHECK (char_length(question_redacted) BETWEEN 1 AND 1000 OR (erased_at IS NOT NULL AND question_redacted = '')),
  CHECK ((status = 'answered') = (answer_item_id IS NOT NULL)),
  CHECK ((status = 'declined') = (decline_reason IS NOT NULL))
);
CREATE INDEX expert_questions_expert ON expert_questions (tenant_id, expert_person_id, status);

CREATE FUNCTION expert_questions_guard() RETURNS trigger
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
CREATE TRIGGER expert_questions_guard BEFORE INSERT OR UPDATE ON expert_questions FOR EACH ROW EXECUTE FUNCTION expert_questions_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_items', 'knowledge_versions', 'knowledge_item_topics', 'citations', 'answer_logs', 'expert_questions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- API: labels and status only.
GRANT SELECT (id, tenant_id, status, origin, ai_extracted, department_id, sensitivity, owner_person_id, current_version_id,
              created_by_card_id, verified_by_card_id, verified_at, stale_after, usage_count) ON knowledge_items TO legacyai_app;
GRANT SELECT (id, tenant_id, item_id, version_no, change_kind, author_card_id, author_person_id) ON knowledge_versions TO legacyai_app;
GRANT SELECT (id, tenant_id, asked_by_card_id, expert_person_id, owner_person_id, department_id, sensitivity, status,
              answer_item_id, created_at, answered_at, expires_at) ON expert_questions TO legacyai_app;

-- Python.
GRANT SELECT, INSERT, UPDATE ON knowledge_items, expert_questions TO legacyai_ai;
GRANT SELECT, INSERT ON knowledge_versions TO legacyai_ai;
GRANT SELECT, INSERT, DELETE ON knowledge_item_topics, citations, answer_logs TO legacyai_ai;
GRANT EXECUTE ON FUNCTION erase_version(uuid) TO legacyai_ai;

-- migrate:down
DROP TABLE expert_questions;
DROP FUNCTION expert_questions_guard();
DROP TABLE answer_logs;
DROP TABLE citations;
DROP FUNCTION citations_guard();
DROP TABLE knowledge_item_topics;
ALTER TABLE chunks DROP CONSTRAINT chunks_tenant_id_knowledge_item_id_fkey;
ALTER TABLE knowledge_items DROP CONSTRAINT knowledge_items_tenant_id_current_version_id_fkey;
DROP TABLE knowledge_versions;
DROP FUNCTION erase_version(uuid);
DROP FUNCTION knowledge_versions_immutable();
DROP TABLE knowledge_items;
DROP FUNCTION knowledge_items_guard();
