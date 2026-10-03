-- migrate:up

-- Consent withdrawal, step 1 (docs/phase2/05 §1): the material is HIDDEN in the same transaction that
-- records the withdrawal - whoever records it (the person's own card, or an Owner for someone who left).
-- Nothing of it is searched, cited, shown or sent to a model afterwards. Erasure (step 2) follows in the
-- same request, done by the Python service; a legal hold suspends only the erasure, never the hiding.
-- SECURITY DEFINER: the API login, which records withdrawals, may not change capture or knowledge tables.

CREATE FUNCTION consents_hide_on_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  item_ids uuid[];
  source_ids uuid[];
BEGIN
  IF NOT (OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF NEW.scope IN ('documents', 'own_words') THEN
    SELECT array_agg(id) INTO source_ids FROM sources
     WHERE tenant_id = NEW.tenant_id AND consent_id = NEW.id AND status NOT IN ('withdrawn', 'failed');
    IF source_ids IS NOT NULL THEN
      UPDATE sources SET status = 'withdrawn' WHERE tenant_id = NEW.tenant_id AND id = ANY (source_ids);
      UPDATE chunks SET status = 'withdrawn' WHERE tenant_id = NEW.tenant_id AND source_id = ANY (source_ids) AND status <> 'withdrawn';
    END IF;
    -- items given under this consent (interview answers, items they wrote, their replies) ...
    SELECT array_agg(id) INTO item_ids FROM knowledge_items
     WHERE tenant_id = NEW.tenant_id AND consent_id = NEW.id AND status <> 'withdrawn';
    -- ... and items derived ONLY from the withdrawn sources (mixed provenance is handled by the erasure step)
    IF source_ids IS NOT NULL THEN
      SELECT array_agg(DISTINCT v.item_id) || COALESCE(item_ids, '{}') INTO item_ids
        FROM knowledge_versions v
        JOIN knowledge_items i ON i.tenant_id = v.tenant_id AND i.id = v.item_id AND i.current_version_id = v.id
       WHERE v.tenant_id = NEW.tenant_id AND i.status <> 'withdrawn'
         AND EXISTS (SELECT 1 FROM citations ci JOIN chunks c ON c.tenant_id = ci.tenant_id AND c.id = ci.chunk_id
                      WHERE ci.tenant_id = v.tenant_id AND ci.subject_type = 'knowledge_version' AND ci.subject_id = v.id
                        AND c.source_id = ANY (source_ids))
         AND NOT EXISTS (SELECT 1 FROM citations ci JOIN chunks c ON c.tenant_id = ci.tenant_id AND c.id = ci.chunk_id
                          WHERE ci.tenant_id = v.tenant_id AND ci.subject_type = 'knowledge_version' AND ci.subject_id = v.id
                            AND (c.source_id IS NULL OR NOT (c.source_id = ANY (source_ids))));
    END IF;
    IF item_ids IS NOT NULL THEN
      UPDATE knowledge_items SET status = 'withdrawn' WHERE tenant_id = NEW.tenant_id AND id = ANY (item_ids) AND status <> 'withdrawn';
      DELETE FROM chunks WHERE tenant_id = NEW.tenant_id AND knowledge_item_id = ANY (item_ids);
      UPDATE quiz_items SET status = 'retired' WHERE tenant_id = NEW.tenant_id AND knowledge_item_id = ANY (item_ids) AND status <> 'retired';
    END IF;
    UPDATE expert_questions SET status = 'expired' WHERE tenant_id = NEW.tenant_id AND expert_person_id = NEW.person_id AND status = 'open';
  END IF;
  NEW.withdrawal_status := CASE WHEN NEW.legal_hold THEN 'held' ELSE 'hidden' END;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION consents_hide_on_withdrawal() FROM PUBLIC;
CREATE TRIGGER consents_hide_on_withdrawal BEFORE UPDATE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_hide_on_withdrawal();

-- Erasure (step 2) by the Python service: it records how far it got, and may delete topics that were only
-- ever SUGGESTED from a withdrawn document (accepted topics are the company's own list and stay).
GRANT UPDATE (withdrawal_status) ON consents TO legacyai_ai;
GRANT DELETE ON topics TO legacyai_ai;
CREATE FUNCTION topics_delete_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user = 'legacyai_ai' AND OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'topics: the AI service may only delete proposed topics' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER topics_delete_guard BEFORE DELETE ON topics FOR EACH ROW EXECUTE FUNCTION topics_delete_guard();

-- migrate:down
DROP TRIGGER topics_delete_guard ON topics;
DROP FUNCTION topics_delete_guard();
REVOKE DELETE ON topics FROM legacyai_ai;
REVOKE UPDATE (withdrawal_status) ON consents FROM legacyai_ai;
DROP TRIGGER consents_hide_on_withdrawal ON consents;
DROP FUNCTION consents_hide_on_withdrawal();
