-- migrate:up

-- Phase 2 capture (features 25, 7, 10, 18). Owner module: Python capture (topic lists: API).

-- --------------------------------------------------------------------- sources
CREATE TABLE sources (
  id                                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                         uuid NOT NULL REFERENCES tenants (id),
  kind                              text NOT NULL CHECK (kind IN ('document', 'interview')),
  title                             text NOT NULL,
  department_id                     uuid,
  sensitivity                       smallint NOT NULL DEFAULT 1 CHECK (sensitivity BETWEEN 0 AND 3),
  owner_person_id                   uuid,
  consent_id                        uuid,
  company_owned_attested_by_card_id uuid,
  contributor_confirmed_at          timestamptz,
  uploaded_by_card_id               uuid NOT NULL,
  status                            text NOT NULL CHECK (status IN
                                      ('awaiting_confirmation', 'awaiting_content', 'processing', 'ready', 'failed', 'withdrawn')),
  failure_code                      text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]{1,40}$'),
  mime                              text CHECK (mime IS NULL OR mime IN ('application/pdf', 'text/plain', 'text/markdown')),
  byte_size                         integer CHECK (byte_size IS NULL OR byte_size BETWEEN 0 AND 10485760),
  page_count                        integer CHECK (page_count IS NULL OR page_count BETWEEN 0 AND 200),
  char_count                        integer CHECK (char_count IS NULL OR char_count >= 0),
  chunk_count                       integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  content_sha256                    bytea CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
  language                          text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2}$'),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  ready_at                          timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES consents (tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, company_owned_attested_by_card_id) REFERENCES cards (tenant_id, id),
  -- a title may be blanked only when the source is withdrawn
  CHECK (char_length(title) BETWEEN 1 AND 200 OR (status = 'withdrawn' AND title = '')),
  -- exactly one basis for capture: a consent (named contributor) or the company-document declaration
  CHECK ((consent_id IS NULL) <> (company_owned_attested_by_card_id IS NULL)),
  CHECK ((owner_person_id IS NULL) = (consent_id IS NULL)),
  CHECK (kind = 'document' OR company_owned_attested_by_card_id IS NULL)
);
CREATE INDEX sources_status ON sources (tenant_id, status);
CREATE INDEX sources_owner ON sources (tenant_id, owner_person_id);
CREATE INDEX sources_hash ON sources (tenant_id, content_sha256);   -- not unique on purpose (see docs/phase2/03)

-- Legal status moves, and the consent gate. SECURITY DEFINER because the Python login may not read
-- cards (needed to compare uploader and contributor); row-level security still applies.
CREATE FUNCTION sources_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  uploader uuid;
  needed_scope text;
  c consents%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT ((NEW.kind = 'document' AND NEW.status IN ('awaiting_confirmation', 'awaiting_content'))
         OR (NEW.kind = 'interview' AND NEW.status = 'ready')) THEN
      RAISE EXCEPTION 'sources: a new % cannot start as %', NEW.kind, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.kind <> OLD.kind OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id OR NEW.consent_id IS DISTINCT FROM OLD.consent_id
       OR NEW.uploaded_by_card_id <> OLD.uploaded_by_card_id
       OR NEW.company_owned_attested_by_card_id IS DISTINCT FROM OLD.company_owned_attested_by_card_id THEN
      RAISE EXCEPTION 'sources: who contributed a source cannot be changed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
         (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('awaiting_content', 'withdrawn'))
      OR (OLD.status = 'awaiting_content' AND NEW.status IN ('processing', 'failed', 'withdrawn'))
      OR (OLD.status = 'processing' AND NEW.status IN ('ready', 'failed', 'withdrawn'))
      OR (OLD.status = 'ready' AND NEW.status = 'withdrawn')) THEN
      RAISE EXCEPTION 'sources: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
  END IF;

  -- The gate: nothing is processed or searchable without a valid basis for capture.
  IF NEW.status IN ('awaiting_content', 'processing', 'ready') AND NEW.owner_person_id IS NOT NULL THEN
    needed_scope := CASE WHEN NEW.kind = 'interview' THEN 'own_words' ELSE 'documents' END;
    SELECT * INTO c FROM consents WHERE tenant_id = NEW.tenant_id AND id = NEW.consent_id;
    IF c.person_id IS DISTINCT FROM NEW.owner_person_id OR c.scope IS DISTINCT FROM needed_scope THEN
      RAISE EXCEPTION 'sources: the consent does not belong to the contributor for this kind of capture' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT consent_is_valid(NEW.tenant_id, NEW.owner_person_id, needed_scope, now()) THEN
      RAISE EXCEPTION 'sources: no valid consent from the contributor' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'document' THEN
      SELECT person_id INTO uploader FROM cards WHERE tenant_id = NEW.tenant_id AND id = NEW.uploaded_by_card_id;
      IF uploader IS DISTINCT FROM NEW.owner_person_id AND NEW.contributor_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'sources: the named contributor has not confirmed this document' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION sources_guard() FROM PUBLIC;
CREATE TRIGGER sources_guard BEFORE INSERT OR UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION sources_guard();

-- ---------------------------------------------------------------------- chunks
CREATE TABLE chunks (
  id                        uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id),
  kind                      text NOT NULL CHECK (kind IN ('source', 'item')),
  source_id                 uuid,
  knowledge_item_id         uuid,           -- foreign key added with the knowledge tables (migration 11)
  ordinal                   integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  text                      text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  token_estimate            integer NOT NULL CHECK (token_estimate >= 0),
  embedding                 halfvec(384),
  embedding_model           text CHECK (embedding_model IS NULL OR char_length(embedding_model) BETWEEN 1 AND 100),
  department_id             uuid,
  sensitivity               smallint NOT NULL CHECK (sensitivity BETWEEN 0 AND 3),
  owner_person_id           uuid,
  verification_status       text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'corrected', 'stale')),
  page_from                 integer CHECK (page_from IS NULL OR page_from >= 0),
  page_to                   integer CHECK (page_to IS NULL OR page_to >= 0),
  redaction_count           integer NOT NULL DEFAULT 0 CHECK (redaction_count >= 0),
  low_confidence_redactions boolean NOT NULL DEFAULT false,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'withdrawn')),
  interview_turn_id         uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES sources (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_person_id) REFERENCES people (tenant_id, id),
  CHECK ((kind = 'source') = (source_id IS NOT NULL)),
  CHECK ((kind = 'item') = (knowledge_item_id IS NOT NULL)),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL),
  CHECK (status <> 'active' OR embedding IS NOT NULL),
  CHECK (kind = 'item' OR verification_status = 'unverified'),
  CHECK (kind = 'source' OR verification_status IN ('verified', 'corrected', 'stale'))
);
CREATE UNIQUE INDEX chunks_source_ordinal ON chunks (tenant_id, source_id, ordinal) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX chunks_item ON chunks (tenant_id, knowledge_item_id) WHERE knowledge_item_id IS NOT NULL;
CREATE INDEX chunks_visible ON chunks (tenant_id, status, sensitivity);
CREATE INDEX chunks_owner ON chunks (tenant_id, owner_person_id);
-- Deliberately NO vector index and NO keyword index (docs/phase2/03, "No vector index and no keyword index").

-- Chunk counts per company, readable without seeing other companies' rows. Maintained by a trigger only.
CREATE TABLE tenant_usage_counters (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants (id),
  chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION chunks_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tenant_usage_counters (tenant_id, chunk_count) VALUES (NEW.tenant_id, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET chunk_count = tenant_usage_counters.chunk_count + 1, updated_at = now();
    RETURN NEW;
  END IF;
  UPDATE tenant_usage_counters SET chunk_count = greatest(chunk_count - 1, 0), updated_at = now() WHERE tenant_id = OLD.tenant_id;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION chunks_count() FROM PUBLIC;
CREATE TRIGGER chunks_count AFTER INSERT OR DELETE ON chunks FOR EACH ROW EXECUTE FUNCTION chunks_count();

-- Labels never change by a plain UPDATE: only relabel() may (migration 12). Pending chunks become
-- active only when their source is ready (interview sources are ready from the start).
CREATE FUNCTION chunks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity
      OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'chunks: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.text <> OLD.text OR NEW.kind <> OLD.kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.knowledge_item_id IS DISTINCT FROM OLD.knowledge_item_id THEN
    IF NOT (NEW.kind = 'item' AND NEW.knowledge_item_id = OLD.knowledge_item_id) THEN
      RAISE EXCEPTION 'chunks: text and origin of a source chunk do not change' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'chunks: a withdrawn chunk does not come back' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'active' AND OLD.status = 'pending' AND NEW.kind = 'source'
     AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.source_id AND s.status IN ('processing', 'ready')) THEN
    RAISE EXCEPTION 'chunks: cannot become searchable before its source is processed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chunks_guard BEFORE UPDATE ON chunks FOR EACH ROW EXECUTE FUNCTION chunks_guard();

-- --------------------------------------------------------- redaction findings
CREATE TABLE redaction_findings (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  source_id      uuid,
  chunk_id       uuid,
  entity_type    text NOT NULL CHECK (entity_type ~ '^[A-Z_]{2,40}$'),
  detector       text NOT NULL CHECK (detector IN ('pattern', 'checksum', 'ner', 'secret_pattern')),
  confidence     real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  placeholder    text NOT NULL CHECK (placeholder ~ '^\[[A-Z_]{2,40}_[0-9]{1,5}\]$'),
  char_length    integer NOT NULL CHECK (char_length > 0),
  low_confidence boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES sources (tenant_id, id),
  FOREIGN KEY (tenant_id, chunk_id) REFERENCES chunks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX redaction_findings_source ON redaction_findings (tenant_id, source_id);

-- --------------------------------------------------------------------- topics
CREATE TABLE topics (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                uuid NOT NULL REFERENCES tenants (id),
  name                     text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description              text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  department_id            uuid,
  sensitivity              smallint NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 3),
  origin                   text NOT NULL CHECK (origin IN ('admin', 'extracted')),
  extracted_from_source_id uuid,
  status                   text NOT NULL CHECK (status IN ('active', 'proposed', 'retired')),
  embedding                halfvec(384),
  embedding_model          text,
  created_by_card_id       uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id),
  FOREIGN KEY (tenant_id, extracted_from_source_id) REFERENCES sources (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK ((origin = 'extracted') = (extracted_from_source_id IS NOT NULL)),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL)
);
CREATE UNIQUE INDEX topics_name ON topics (tenant_id, lower(name));

-- The Python login may only add PROPOSED, extracted topics; accepting one is a person's act (API).
CREATE FUNCTION topics_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'legacyai_ai' AND TG_OP = 'INSERT' AND (NEW.status <> 'proposed' OR NEW.origin <> 'extracted') THEN
    RAISE EXCEPTION 'topics: the AI service may only propose topics' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER topics_guard BEFORE INSERT ON topics FOR EACH ROW EXECUTE FUNCTION topics_guard();

CREATE TABLE role_topic_maps (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  job_role           text NOT NULL CHECK (char_length(job_role) BETWEEN 1 AND 120),
  topic_id           uuid NOT NULL,
  required           boolean NOT NULL DEFAULT true,
  importance         smallint NOT NULL DEFAULT 2 CHECK (importance BETWEEN 1 AND 3),
  created_by_card_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, topic_id) REFERENCES topics (tenant_id, id),
  UNIQUE (tenant_id, job_role, topic_id)
);

CREATE TABLE person_job_roles (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  person_id uuid NOT NULL,
  job_role  text NOT NULL CHECK (char_length(job_role) BETWEEN 1 AND 120),
  relation  text NOT NULL CHECK (relation IN ('holder', 'successor')),
  PRIMARY KEY (tenant_id, person_id, job_role, relation),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);

-- ----------------------------------------------------------------- interviews
CREATE TABLE interviews (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  expert_person_id   uuid NOT NULL,
  source_id          uuid,                 -- created when the interview becomes active
  consent_id         uuid,
  job_role           text NOT NULL CHECK (char_length(job_role) BETWEEN 1 AND 120),
  status             text NOT NULL DEFAULT 'invited'
                       CHECK (status IN ('invited', 'active', 'paused', 'stopped_budget', 'completed', 'abandoned')),
  turn_count         integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  max_turns          integer NOT NULL CHECK (max_turns BETWEEN 1 AND 100),
  cost_micro_usd     bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  invited_by_card_id uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_turn_at       timestamptz,
  completed_at       timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, expert_person_id) REFERENCES people (tenant_id, id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES sources (tenant_id, id),
  FOREIGN KEY (tenant_id, consent_id) REFERENCES consents (tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK (status = 'invited' OR status = 'abandoned' OR (source_id IS NOT NULL AND consent_id IS NOT NULL))
);
CREATE INDEX interviews_expert ON interviews (tenant_id, expert_person_id, status);

CREATE FUNCTION interviews_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE c consents%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'invited' THEN
      RAISE EXCEPTION 'interviews: a new interview starts as invited' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.expert_person_id <> OLD.expert_person_id OR NEW.job_role <> OLD.job_role THEN
    RAISE EXCEPTION 'interviews: who is interviewed for what does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'invited' AND NEW.status IN ('active', 'abandoned'))
    OR (OLD.status = 'active' AND NEW.status IN ('paused', 'stopped_budget', 'completed'))
    OR (OLD.status = 'paused' AND NEW.status IN ('active', 'abandoned'))
    OR (OLD.status = 'stopped_budget' AND NEW.status IN ('active', 'completed', 'abandoned'))) THEN
    RAISE EXCEPTION 'interviews: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- Capture happens only while active: entering or staying active needs the expert's valid own_words consent.
  IF NEW.status = 'active' THEN
    SELECT * INTO c FROM consents WHERE tenant_id = NEW.tenant_id AND id = NEW.consent_id;
    IF c.person_id IS DISTINCT FROM NEW.expert_person_id OR c.scope IS DISTINCT FROM 'own_words'
       OR NOT consent_is_valid(NEW.tenant_id, NEW.expert_person_id, 'own_words', now()) THEN
      RAISE EXCEPTION 'interviews: no valid consent from the expert' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER interviews_guard BEFORE INSERT OR UPDATE ON interviews FOR EACH ROW EXECUTE FUNCTION interviews_guard();

CREATE TABLE interview_turns (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  interview_id   uuid NOT NULL,
  ordinal        integer NOT NULL CHECK (ordinal >= 1),
  topic_id       uuid,
  question_text  text NOT NULL,
  question_kind  text NOT NULL CHECK (question_kind IN ('topic', 'follow_up', 'template')),
  answer_text    text,
  answered_at    timestamptz,
  erased_at      timestamptz,
  prompt_version text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, interview_id, ordinal),
  FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews (tenant_id, id),
  FOREIGN KEY (tenant_id, topic_id) REFERENCES topics (tenant_id, id),
  CHECK (char_length(question_text) BETWEEN 1 AND 1000 OR (erased_at IS NOT NULL AND question_text = '')),
  CHECK (answer_text IS NULL OR char_length(answer_text) BETWEEN 1 AND 4000 OR (erased_at IS NOT NULL AND answer_text = '')),
  CHECK ((answer_text IS NULL) = (answered_at IS NULL))
);

ALTER TABLE chunks ADD FOREIGN KEY (tenant_id, interview_turn_id) REFERENCES interview_turns (tenant_id, id);

-- ------------------------------------------------------------------------ jobs
CREATE TABLE jobs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  kind            text NOT NULL CHECK (kind IN ('embed', 'erase_withdrawn', 'reembed', 'expire', 'prune')),
  subject_id      uuid,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  locked_until    timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,40}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs (tenant_id, status, created_at);
CREATE UNIQUE INDEX jobs_one_open ON jobs (tenant_id, kind, subject_id) WHERE status IN ('queued', 'running');

-- ------------------------------------------------------- row-level security, grants
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sources', 'chunks', 'redaction_findings', 'topics', 'role_topic_maps', 'person_job_roles',
                           'interviews', 'interview_turns', 'jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- API (legacyai_app): labels and status, never captured text.
GRANT SELECT, INSERT ON sources TO legacyai_app;
GRANT UPDATE (status, contributor_confirmed_at, updated_at) ON sources TO legacyai_app;
GRANT SELECT (id, tenant_id, kind, source_id, knowledge_item_id, department_id, sensitivity, owner_person_id,
              verification_status, status) ON chunks TO legacyai_app;
GRANT SELECT ON redaction_findings TO legacyai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON topics, role_topic_maps, person_job_roles TO legacyai_app;
GRANT SELECT (id, tenant_id, expert_person_id, source_id, consent_id, job_role, status, turn_count, max_turns,
              invited_by_card_id, created_at, last_turn_at, completed_at) ON interviews TO legacyai_app;
GRANT INSERT ON interviews TO legacyai_app;
GRANT SELECT (id, tenant_id, interview_id, ordinal, answered_at, erased_at) ON interview_turns TO legacyai_app;
GRANT SELECT, INSERT ON jobs TO legacyai_app;
GRANT SELECT ON tenant_usage_counters TO legacyai_app;

-- Python service (legacyai_ai).
GRANT SELECT, INSERT, UPDATE ON sources TO legacyai_ai;
GRANT SELECT, INSERT, UPDATE, DELETE ON chunks TO legacyai_ai;
GRANT SELECT, INSERT, DELETE ON redaction_findings TO legacyai_ai;
GRANT SELECT, INSERT ON topics TO legacyai_ai;
GRANT UPDATE (embedding, embedding_model) ON topics TO legacyai_ai;
GRANT SELECT ON role_topic_maps, person_job_roles TO legacyai_ai;
GRANT SELECT, INSERT, UPDATE ON interviews, interview_turns TO legacyai_ai;
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs TO legacyai_ai;
GRANT SELECT ON tenant_usage_counters TO legacyai_ai;
GRANT SELECT (id, tenant_id, department_id, status) ON people TO legacyai_ai;
GRANT SELECT (id, tenant_id) ON departments TO legacyai_ai;

-- migrate:down
REVOKE SELECT (id, tenant_id, department_id, status) ON people FROM legacyai_ai;
REVOKE SELECT (id, tenant_id) ON departments FROM legacyai_ai;
DROP TABLE jobs;
ALTER TABLE chunks DROP CONSTRAINT chunks_tenant_id_interview_turn_id_fkey;
DROP TABLE interview_turns;
DROP TABLE interviews;
DROP FUNCTION interviews_guard();
DROP TABLE person_job_roles;
DROP TABLE role_topic_maps;
DROP TABLE topics;
DROP FUNCTION topics_guard();
DROP TABLE redaction_findings;
DROP TABLE chunks;
DROP FUNCTION chunks_guard();
DROP FUNCTION chunks_count();
DROP TABLE tenant_usage_counters;
DROP TABLE sources;
DROP FUNCTION sources_guard();
