-- migrate:up

-- Decision D41, step 6 part 4b (the founder's choice of 2026-10-25: through the AI service), first half: topic names
-- and descriptions are written and read ONLY by the AI service, so the next half can store them sealed without the
-- API noticing. Creating, renaming, accepting or retiring a topic and applying a department template go through the
-- AI service (/internal/topics...); the topic list asks it for the names of the topics it shows. Nothing about how
-- they are stored changes here.

-- The AI service may now also add an ACTIVE topic made by a person (origin 'admin', with the card that made it):
-- the API checked that person's right to do so and sends the request with a signed token naming them.
CREATE OR REPLACE FUNCTION topics_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'legacyai_ai' AND TG_OP = 'INSERT'
     AND NOT ((NEW.status = 'proposed' AND NEW.origin = 'extracted')
              OR (NEW.status = 'active' AND NEW.origin = 'admin' AND NEW.created_by_card_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'topics: the AI service may only propose topics or add one a person made' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;

GRANT UPDATE (name, description, status) ON topics TO legacyai_ai;
-- a template links its topics to job roles in the same step
GRANT INSERT ON role_topic_maps TO legacyai_ai;

-- The API login loses the names and descriptions: it no longer writes topics, and reads every column but those two.
REVOKE SELECT, INSERT, UPDATE ON topics FROM legacyai_app;
GRANT SELECT (id, tenant_id, department_id, sensitivity, origin, extracted_from_source_id, status, embedding, embedding_model,
              created_by_card_id, created_at) ON topics TO legacyai_app;

-- migrate:down
REVOKE SELECT ON topics FROM legacyai_app;
GRANT SELECT, INSERT, UPDATE ON topics TO legacyai_app;
REVOKE INSERT ON role_topic_maps FROM legacyai_ai;
REVOKE UPDATE (name, description, status) ON topics FROM legacyai_ai;
CREATE OR REPLACE FUNCTION topics_guard() RETURNS trigger
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
