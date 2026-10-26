-- migrate:up

-- Decision D41, section 4 of the plan ("moving existing content"), part 1: when a company CLEARS its own key (or
-- changes to another one), the API retires that key's data-key version; new content is then sealed with the
-- company's current key (the platform's content key, or its new own key). What was sealed before stays sealed with
-- the retired version - readable only as long as the company's old key still works. The housekeeping job seals it
-- again with the current key ("re-keying"), a batch at a time. This part covers document pieces (chunks), knowledge
-- versions and interview turns; the other sealed columns follow in part 2.
--
-- The database allows exactly this change: a sealed value replaced by a sealed value, when the old key is a RETIRED
-- version of the company's own data key and the new one is the key the company seals with now. It cannot check that
-- the text inside is the same (it cannot open either); it does check that nothing else changes.

-- The key id a company's new content is sealed with: its live own data key, else its live platform content data key.
-- The same choice as the AI service's ContentKeys.for_writing (services/ai/app/platform/content_keys.py).
CREATE FUNCTION content_write_key(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT 'company:' || version FROM company_data_keys WHERE tenant_id = p_tenant AND retired_at IS NULL),
    (SELECT 'platform:' || version FROM content_data_keys WHERE tenant_id = p_tenant AND retired_at IS NULL))
$$;

-- Whether a value sealed with p_old may be sealed again with p_new: p_old is a retired version of the company's own
-- data key, and p_new is the key the company seals with now.
CREATE FUNCTION content_rekey_allowed(p_tenant uuid, p_old text, p_new text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_old IS NOT NULL AND p_new IS NOT NULL AND p_old <> p_new
     AND EXISTS (SELECT 1 FROM company_data_keys WHERE tenant_id = p_tenant AND 'company:' || version = p_old AND retired_at IS NOT NULL)
     AND p_new = public.content_write_key(p_tenant)
$$;
GRANT EXECUTE ON FUNCTION content_write_key(uuid), content_rekey_allowed(uuid, text, text) TO legacyai_ai;

-- ---------------------------------------------------------------- chunks
-- Under the job's flag app.reseal: also sealed -> sealed again, under the rule above (text and vector together).
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
                AND NEW.knowledge_item_id IS NOT DISTINCT FROM OLD.knowledge_item_id)
       AND NOT (current_setting('app.reseal', true) = 'on'
                AND OLD.text_sealed IS NOT NULL AND NEW.text IS NULL AND NEW.text_sealed IS NOT NULL
                AND public.content_rekey_allowed(NEW.tenant_id, OLD.sealed_key, NEW.sealed_key)
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
  -- sealed again with the company's current key, its own key having been retired (re-keying), every other column the same
  IF OLD.erased_at IS NULL AND OLD.body_sealed IS NOT NULL AND NEW.body IS NULL AND NEW.body_sealed IS NOT NULL
     AND public.content_rekey_allowed(NEW.tenant_id, OLD.sealed_key, NEW.sealed_key)
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

-- Seals one version of the caller's company again with the company's current key. False when there was nothing to do
-- (not sealed with p_old any more, erased, or not this company's); the trigger refuses a key change it does not allow.
CREATE FUNCTION reseal_version(p_id uuid, p_old text, p_sealed bytea, p_key text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH resealed AS (
    UPDATE knowledge_versions SET body_sealed = p_sealed, sealed_key = p_key
     WHERE id = p_id AND tenant_id = app_current_tenant() AND sealed_key = p_old AND erased_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM resealed)
$$;
REVOKE ALL ON FUNCTION reseal_version(uuid, text, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reseal_version(uuid, text, bytea, text) TO legacyai_ai;

-- Interview turns need nothing here: the AI service may already update them (question and answer together).

-- migrate:down
-- Values sealed again stay as they are: they are sealed with a key the company still has.
DROP FUNCTION reseal_version(uuid, text, bytea, text);
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

DROP FUNCTION content_rekey_allowed(uuid, text, text);
DROP FUNCTION content_write_key(uuid);
