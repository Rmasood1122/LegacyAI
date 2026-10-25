-- migrate:up

-- Decision D41, step 4b part 2: document pieces, interview answers' search copies and items' search copies (chunks)
-- are stored SEALED from now on: the text and the vector encrypted with the company's content key (AES-256-GCM, bound
-- to the company, the chunk and the column), and the name of the key ("company:3", "platform:1"). Older chunks stay
-- readable until the background job of step 5 seals them; a chunk is either readable or sealed, never both.
ALTER TABLE chunks
  ADD COLUMN text_sealed      bytea CHECK (octet_length(text_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN embedding_sealed bytea CHECK (octet_length(embedding_sealed) BETWEEN 29 AND 65536),
  ADD COLUMN sealed_key       text CHECK (sealed_key ~ '^(company|platform):[1-9][0-9]{0,5}$');
ALTER TABLE chunks ALTER COLUMN text DROP NOT NULL;
ALTER TABLE chunks ADD CONSTRAINT chunks_readable_or_sealed CHECK (
  (text IS NULL) = (text_sealed IS NOT NULL)                -- exactly one form of the text
  AND (text_sealed IS NULL) = (sealed_key IS NULL)          -- a sealed chunk names its key
  AND (embedding_sealed IS NULL OR text_sealed IS NOT NULL) -- a sealed vector only on a sealed chunk
  AND (embedding IS NULL OR text_sealed IS NULL)            -- a sealed chunk never keeps a readable vector
);
-- searchable chunks have a vector, in one form or the other (was: embedding IS NOT NULL)
ALTER TABLE chunks DROP CONSTRAINT chunks_check3;
ALTER TABLE chunks ADD CONSTRAINT chunks_active_has_vector CHECK (status <> 'active' OR embedding IS NOT NULL OR embedding_sealed IS NOT NULL);

-- The guard: the text of a source chunk never changes, sealed or not (NULL-safe comparisons now that text can be NULL).
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

-- migrate:down
-- Refused while any chunk is sealed: going back would leave chunks the old schema cannot hold.
DO $$
BEGIN
  ALTER TABLE chunks NO FORCE ROW LEVEL SECURITY;
  IF EXISTS (SELECT 1 FROM chunks WHERE text_sealed IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot roll back sealed chunks: % chunk(s) are sealed', (SELECT count(*) FROM chunks WHERE text_sealed IS NOT NULL);
  END IF;
  ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
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
ALTER TABLE chunks DROP CONSTRAINT chunks_active_has_vector;
ALTER TABLE chunks ADD CONSTRAINT chunks_check3 CHECK (status <> 'active' OR embedding IS NOT NULL);
ALTER TABLE chunks DROP CONSTRAINT chunks_readable_or_sealed;
ALTER TABLE chunks ALTER COLUMN text SET NOT NULL;
ALTER TABLE chunks DROP COLUMN sealed_key, DROP COLUMN embedding_sealed, DROP COLUMN text_sealed;
