-- migrate:up

-- Decision D41, step 5: the rows written before step 4b (document pieces, knowledge versions, interview turns) are
-- still readable. A background job seals them, a few hundred at a time, with the same key and the same binding as
-- new rows. The database allows exactly one change for this: readable -> sealed, with nothing else changing. It
-- does not allow sealed -> readable, a change of key, or a change of the text itself.

-- ---------------------------------------------------------------- chunks
-- The job sets app.reseal = 'on' for its own transaction (the same pattern as app.relabel); only then may the text
-- of a SOURCE chunk move from the readable column to the sealed one. Item chunks could already be rewritten.
CREATE OR REPLACE FUNCTION chunks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity
      OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'chunks: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.text IS DISTINCT FROM OLD.text OR NEW.text_sealed IS DISTINCT FROM OLD.text_sealed OR NEW.sealed_key IS DISTINCT FROM OLD.sealed_key
     OR NEW.kind <> OLD.kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.knowledge_item_id IS DISTINCT FROM OLD.knowledge_item_id THEN
    IF NOT (NEW.kind = 'item' AND NEW.knowledge_item_id = OLD.knowledge_item_id)
       AND NOT (current_setting('app.reseal', true) = 'on'
                AND OLD.text_sealed IS NULL AND NEW.text IS NULL AND NEW.text_sealed IS NOT NULL
                AND NEW.kind = OLD.kind AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
                AND NEW.knowledge_item_id IS NOT DISTINCT FROM OLD.knowledge_item_id) THEN
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

-- ---------------------------------------------------------------- knowledge versions
-- Versions never change; two exceptions, both only through a function with the owner's rights (the AI service has no
-- UPDATE right on the table): erase_version() empties a version, seal_version() seals a readable one.
CREATE OR REPLACE FUNCTION knowledge_versions_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge_versions: versions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- sealed: readable before, sealed after, every other column the same
  IF OLD.erased_at IS NULL AND OLD.body_sealed IS NULL AND NEW.body IS NULL AND NEW.body_sealed IS NOT NULL AND NEW.sealed_key IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['body', 'body_sealed', 'sealed_key']) = (to_jsonb(OLD) - ARRAY['body', 'body_sealed', 'sealed_key']) THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW.body = '' AND NEW.body_sealed IS NULL AND NEW.sealed_key IS NULL AND NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL
          AND NEW.id = OLD.id AND NEW.item_id = OLD.item_id AND NEW.version_no = OLD.version_no
          AND NEW.change_kind = OLD.change_kind) THEN
    RAISE EXCEPTION 'knowledge_versions: a version cannot be changed, only erased' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

-- Seals one readable, not erased version of the caller's company. False when there was nothing to seal (already
-- sealed, erased in the meantime, or not this company's).
CREATE FUNCTION seal_version(p_id uuid, p_sealed bytea, p_key text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH sealed AS (
    UPDATE knowledge_versions SET body = NULL, body_sealed = p_sealed, sealed_key = p_key
     WHERE id = p_id AND tenant_id = app_current_tenant() AND body_sealed IS NULL AND erased_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM sealed)
$$;
REVOKE ALL ON FUNCTION seal_version(uuid, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION seal_version(uuid, bytea, text) TO legacyai_ai;

-- Interview turns need nothing here: the AI service may already update them, and the table's check
-- (interview_turns_sealed_check) allows a turn that is wholly readable or wholly sealed.

-- migrate:down
-- Rows sealed by the job stay sealed (the previous migration's own rollback refuses while anything is sealed).
DROP FUNCTION seal_version(uuid, bytea, text);
CREATE OR REPLACE FUNCTION knowledge_versions_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge_versions: versions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (NEW.body = '' AND NEW.body_sealed IS NULL AND NEW.sealed_key IS NULL AND NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL
          AND NEW.id = OLD.id AND NEW.item_id = OLD.item_id AND NEW.version_no = OLD.version_no
          AND NEW.change_kind = OLD.change_kind) THEN
    RAISE EXCEPTION 'knowledge_versions: a version cannot be changed, only erased' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE OR REPLACE FUNCTION chunks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.sensitivity <> OLD.sensitivity
      OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND current_setting('app.relabel', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'chunks: labels change only through relabel()' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.text IS DISTINCT FROM OLD.text OR NEW.text_sealed IS DISTINCT FROM OLD.text_sealed OR NEW.sealed_key IS DISTINCT FROM OLD.sealed_key
     OR NEW.kind <> OLD.kind OR NEW.source_id IS DISTINCT FROM OLD.source_id
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
