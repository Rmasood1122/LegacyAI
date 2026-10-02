-- migrate:up

-- Phase 1.1. Two actions that only the LegacyAI platform operator may take on a customer tenant:
--   * renew the tenant's company card (the subscription clock) - no longer possible for Owners/Admins;
--   * recover a locked-out Company Owner (Owners can no longer renew/unlock/replace/re-enrol each other).
-- Both are written to the customer's audit chain with a distinct actor kind, 'operator'.

INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('tenant:renew_company_card', 'Platform operator: renew a tenant''s company card',        true, true),
  ('tenant:recover_owner',      'Platform operator: recover a locked-out Company Owner',    true, true);

-- Held by Company Owners, but platform_only: usable only by an Owner card of the operator tenant.
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity) VALUES
  ('company_owner', 'tenant:renew_company_card', 'tenant', 3),
  ('company_owner', 'tenant:recover_owner',      'tenant', 3);

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('card', 'system', 'anonymous', 'service', 'operator'));

ALTER TABLE card_events DROP CONSTRAINT card_events_event_type_check;
ALTER TABLE card_events ADD CONSTRAINT card_events_event_type_check
  CHECK (event_type IN (
    'issued', 'activated', 'login_success', 'login_failed', 'sc_locked', 'unlocked',
    'suspended', 'reinstated', 'revoked', 'expired', 'renewed', 'replaced',
    'role_assigned', 'role_removed', 'restriction_denied', 'restrictions_changed',
    'credential_added', 'credential_removed', 'enrollment_token_issued', 'owner_recovered'));

-- migrate:down

-- NOT VALID: rows written while this migration was applied cannot be deleted (the audit log is
-- append-only), so the old rule is restored for NEW rows only.
ALTER TABLE card_events DROP CONSTRAINT card_events_event_type_check;
ALTER TABLE card_events ADD CONSTRAINT card_events_event_type_check
  CHECK (event_type IN (
    'issued', 'activated', 'login_success', 'login_failed', 'sc_locked', 'unlocked',
    'suspended', 'reinstated', 'revoked', 'expired', 'renewed', 'replaced',
    'role_assigned', 'role_removed', 'restriction_denied', 'restrictions_changed',
    'credential_added', 'credential_removed', 'enrollment_token_issued')) NOT VALID;

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('card', 'system', 'anonymous', 'service')) NOT VALID;

DELETE FROM role_permissions WHERE permission_key IN ('tenant:renew_company_card', 'tenant:recover_owner');
DELETE FROM permissions WHERE permission_key IN ('tenant:renew_company_card', 'tenant:recover_owner');
