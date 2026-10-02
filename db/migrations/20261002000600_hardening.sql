-- migrate:up

-- Hardening found by an independent review of the first five migrations.

-- 1. SECURITY DEFINER functions: put pg_temp LAST in the search path. Without this, a role
--    that can create temporary tables could shadow a table the function reads
--    (for example audit_chain_heads) and so influence the audit chain.
ALTER FUNCTION audit_log_chain() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION cards_register_directory() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION resolve_card(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION app_current_tenant() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION audit_field(text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION audit_log_reject_change() SET search_path = pg_catalog, pg_temp;

-- 2. A card's id and holder can never change either (number, kind and tenant were already fixed).
--    Also: a SUSPENDED card can no longer be replaced (that would undo the suspension): 12 legal transitions.
CREATE OR REPLACE FUNCTION cards_enforce_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'issued' THEN
      RAISE EXCEPTION 'cards must be inserted in state issued, got %', NEW.state USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state, NEW.state) IN (
      ('issued', 'active'), ('issued', 'revoked'), ('issued', 'expired'),
      ('active', 'suspended'), ('active', 'revoked'), ('active', 'expired'), ('active', 'replaced'),
      ('suspended', 'active'), ('suspended', 'revoked'),
      ('expired', 'active'), ('expired', 'revoked'), ('expired', 'replaced')
    )) THEN
      RAISE EXCEPTION 'illegal card state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    NEW.state_changed_at := now();
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.card_number <> OLD.card_number OR NEW.kind <> OLD.kind
     OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
    RAISE EXCEPTION 'id, tenant_id, card_number, kind and person_id of a card are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 3. The API never updates a tenant row (it only creates and reads them). Status, plan and the
--    platform flag can therefore only be changed by a migration / operator, not by the app role.
REVOKE UPDATE ON tenants FROM legacyai_app;

-- 4. Every "which card / credential did this" column now has a composite foreign key, so it
--    can only point at a row of the SAME tenant.
ALTER TABLE cards
  ADD CONSTRAINT cards_replaced_by_fk FOREIGN KEY (tenant_id, replaced_by_card_id) REFERENCES cards (tenant_id, id),
  ADD CONSTRAINT cards_replaces_fk FOREIGN KEY (tenant_id, replaces_card_id) REFERENCES cards (tenant_id, id),
  ADD CONSTRAINT cards_issued_by_fk FOREIGN KEY (tenant_id, issued_by_card_id) REFERENCES cards (tenant_id, id),
  ADD CONSTRAINT cards_renewal_count_nonneg CHECK (renewal_count >= 0),
  ADD CONSTRAINT cards_expires_after_issue CHECK (expires_at > issued_at);
ALTER TABLE card_secrets
  ADD CONSTRAINT card_secrets_created_by_fk FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE enrollment_tokens
  ADD CONSTRAINT enrollment_tokens_created_by_fk FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE sessions
  ADD CONSTRAINT sessions_credential_fk FOREIGN KEY (tenant_id, credential_id) REFERENCES credentials (tenant_id, id);
ALTER TABLE card_events
  ADD CONSTRAINT card_events_actor_fk FOREIGN KEY (tenant_id, actor_card_id) REFERENCES cards (tenant_id, id),
  ADD CONSTRAINT card_events_credential_fk FOREIGN KEY (tenant_id, credential_id) REFERENCES credentials (tenant_id, id);
ALTER TABLE card_restrictions
  ADD CONSTRAINT card_restrictions_created_by_fk FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE card_roles
  ADD CONSTRAINT card_roles_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE tenant_settings
  ADD CONSTRAINT tenant_settings_updated_by_fk FOREIGN KEY (tenant_id, updated_by_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_actor_fk FOREIGN KEY (tenant_id, actor_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_requested_by_fk FOREIGN KEY (tenant_id, requested_by_card_id) REFERENCES cards (tenant_id, id);
ALTER TABLE card_auth_state
  ADD CONSTRAINT card_auth_state_throttle_nonneg CHECK (factor_throttle_level >= 0);
ALTER TABLE card_usage_counters
  ADD CONSTRAINT card_usage_counters_nonneg CHECK (count >= 0);

-- 5. Housekeeping so tables that only grow cannot fill a small database.
--    The app may delete its own tenant's dead sessions and spent enrollment tokens.
GRANT DELETE ON sessions, enrollment_tokens TO legacyai_app;
--    login_attempts stays write-only for the app. This function lets it trim OLD rows only:
--    it cannot read them, and it refuses to delete anything younger than 30 days.
CREATE FUNCTION purge_login_attempts(p_keep_days integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  IF p_keep_days IS NULL OR p_keep_days < 30 THEN
    RAISE EXCEPTION 'login attempts must be kept for at least 30 days' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM login_attempts WHERE occurred_at < now() - make_interval(days => p_keep_days);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;
REVOKE ALL ON FUNCTION purge_login_attempts(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_login_attempts(integer) TO legacyai_app;

-- migrate:down
DROP FUNCTION purge_login_attempts(integer);
REVOKE DELETE ON sessions, enrollment_tokens FROM legacyai_app;
ALTER TABLE card_usage_counters DROP CONSTRAINT card_usage_counters_nonneg;
ALTER TABLE card_auth_state DROP CONSTRAINT card_auth_state_throttle_nonneg;
ALTER TABLE export_jobs DROP CONSTRAINT export_jobs_requested_by_fk;
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_actor_fk;
ALTER TABLE tenant_settings DROP CONSTRAINT tenant_settings_updated_by_fk;
ALTER TABLE card_roles DROP CONSTRAINT card_roles_assigned_by_fk;
ALTER TABLE card_restrictions DROP CONSTRAINT card_restrictions_created_by_fk;
ALTER TABLE card_events DROP CONSTRAINT card_events_credential_fk, DROP CONSTRAINT card_events_actor_fk;
ALTER TABLE sessions DROP CONSTRAINT sessions_credential_fk;
ALTER TABLE enrollment_tokens DROP CONSTRAINT enrollment_tokens_created_by_fk;
ALTER TABLE card_secrets DROP CONSTRAINT card_secrets_created_by_fk;
ALTER TABLE cards
  DROP CONSTRAINT cards_expires_after_issue, DROP CONSTRAINT cards_renewal_count_nonneg,
  DROP CONSTRAINT cards_issued_by_fk, DROP CONSTRAINT cards_replaces_fk, DROP CONSTRAINT cards_replaced_by_fk;
GRANT UPDATE ON tenants TO legacyai_app;
-- (the function changes are harmless to keep; earlier migrations drop the functions themselves)
