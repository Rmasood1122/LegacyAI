-- migrate:up

-- Phase 2: ONE path into the audit log for both services.
-- Every row goes through audit_write(), which enforces the detail-key allow-list in the database.
-- Sequence number, time and hashes are still assigned only by the chain trigger (migration 4).
-- The Python service's login may only call this function; when it does, the row is forced to the
-- actor kind 'service' and may only be an 'event' - it cannot look like a card's own decision.

CREATE TABLE audit_detail_keys (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,40}$')
);
INSERT INTO audit_detail_keys (key) VALUES
  -- Phase 1 / 1.1
  ('outcome'), ('status'), ('state_from'), ('state_to'), ('role_key'), ('reason'), ('scope'), ('resource_type'),
  ('operation'), ('factor_type'), ('credential_id'), ('new_card_id'), ('old_card_id'), ('person_id'), ('export_id'),
  ('rows'), ('idempotent_replay'), ('restriction_type'), ('limit_key'), ('changed'), ('target_tenant_id'),
  ('session_reason'), ('count'), ('anchor_seq'), ('obligations'), ('verification_ref'), ('target_card_id'),
  -- Phase 2
  ('source_id'), ('chunk_count'), ('redactions'), ('item_id'), ('version_no'), ('feature'), ('model'),
  ('cost_micro_usd'), ('task_id'), ('consent_id'), ('attempt_id'), ('candidates'), ('approved'),
  ('policy_disagreements'), ('sensitivity_from'), ('sensitivity_to'), ('department_from'), ('department_to'),
  ('interview_id'), ('topic_id');

GRANT SELECT ON audit_detail_keys TO legacyai_app, legacyai_ai;

CREATE FUNCTION audit_write(
  p_tenant uuid, p_actor_card uuid, p_actor_kind text, p_action text, p_resource_type text, p_resource_id text,
  p_decision text, p_reason_code text, p_request_id text, p_ip text, p_details text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d jsonb;
  k text;
  v jsonb;
  kind text := p_actor_kind;
BEGIN
  -- Only for the company this transaction works for (row-level security would refuse it anyway).
  IF p_tenant IS NULL OR p_tenant IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'audit_write: the row must belong to the current tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- session_user is the login that called us (inside this function current_user is the owner).
  IF session_user = 'legacyai_ai' THEN
    kind := 'service';
    IF p_decision IS DISTINCT FROM 'event' THEN
      RAISE EXCEPTION 'audit_write: the Python service may only record events' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  BEGIN
    d := COALESCE(p_details, '{}')::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'audit_write: details are not valid JSON' USING ERRCODE = 'invalid_parameter_value';
  END;
  IF jsonb_typeof(d) <> 'object' THEN
    RAISE EXCEPTION 'audit_write: details must be a JSON object' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(d) LOOP
    IF NOT EXISTS (SELECT 1 FROM audit_detail_keys WHERE key = k) THEN
      RAISE EXCEPTION 'audit_write: detail key "%" is not on the allow-list', k USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v) NOT IN ('string', 'number', 'boolean', 'null') THEN
      RAISE EXCEPTION 'audit_write: detail "%" must be a plain value', k USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF jsonb_typeof(v) = 'string' AND (char_length(v #>> '{}') > 200 OR (v #>> '{}') ~ '\m[0-9]{16}\M') THEN
      RAISE EXCEPTION 'audit_write: detail "%" is too long or looks like a card number', k USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END LOOP;

  INSERT INTO audit_log (tenant_id, seq, occurred_at, actor_card_id, actor_kind, action, resource_type, resource_id,
                         decision, reason_code, request_id, ip, details, prev_hash, row_hash)
  VALUES (p_tenant, 0, now(), p_actor_card, kind, p_action, p_resource_type, p_resource_id,
          p_decision, p_reason_code, p_request_id, p_ip, COALESCE(p_details, '{}'), ''::bytea, ''::bytea);
END
$$;

REVOKE ALL ON FUNCTION audit_write(uuid, uuid, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_write(uuid, uuid, text, text, text, text, text, text, text, text, text) TO legacyai_app, legacyai_ai;

-- From now on nobody inserts into the audit log directly.
REVOKE INSERT ON audit_log FROM legacyai_app;

-- migrate:down
GRANT INSERT ON audit_log TO legacyai_app;
DROP FUNCTION audit_write(uuid, uuid, text, text, text, text, text, text, text, text, text);
DROP TABLE audit_detail_keys;
