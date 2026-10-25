-- migrate:up

-- Decision D41, step 4a: the AI service searches a company in memory (services/ai/app/capture/memory_search.py) and
-- keeps that company's index for up to 5 minutes. It must notice at once when the company's chunks change - a new
-- document, a withdrawn one, a verified or stale item - whichever service or job changed them.
--
-- A per-company number that goes up with every change to chunks, kept by a trigger only. It lives in the existing
-- per-company counter table (global by design: it holds counts only, no content), which the AI service can already
-- read. The AI service compares it with the number its index was built at, and rebuilds when it moved.
ALTER TABLE tenant_usage_counters ADD COLUMN search_version bigint NOT NULL DEFAULT 0 CHECK (search_version >= 0);

CREATE FUNCTION chunks_search_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
  INSERT INTO tenant_usage_counters (tenant_id, search_version) VALUES (t, 1)
  ON CONFLICT (tenant_id) DO UPDATE SET search_version = tenant_usage_counters.search_version + 1, updated_at = now();
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION chunks_search_version() FROM PUBLIC;
CREATE TRIGGER chunks_search_version AFTER INSERT OR UPDATE OR DELETE ON chunks FOR EACH ROW EXECUTE FUNCTION chunks_search_version();

-- migrate:down
DROP TRIGGER chunks_search_version ON chunks;
DROP FUNCTION chunks_search_version();
ALTER TABLE tenant_usage_counters DROP COLUMN search_version;
