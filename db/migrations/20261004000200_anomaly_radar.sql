-- migrate:up

-- Phase 4, features 5 (anomaly lock) and 11 (retirement radar).
-- docs/phase4/02-anomaly-radar-templates.md. Feature 26 (department templates) needs no table.

-- 1. Anomaly lock: the company's rules. No row = the defaults written here. "Off" is always a switch, never a
--    special number, so every number in a row is a usable value.
CREATE TABLE anomaly_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants (id),
  -- the master switch: off = no rule is evaluated
  enabled                       boolean NOT NULL DEFAULT true,
  -- rule 1: this many refused actions of ONE signed-in card inside the window lock the card
  denials_enabled               boolean NOT NULL DEFAULT true,
  denials_threshold             integer NOT NULL DEFAULT 20 CHECK (denials_threshold BETWEEN 5 AND 500),
  denials_window_minutes        integer NOT NULL DEFAULT 10 CHECK (denials_window_minutes BETWEEN 1 AND 60),
  -- rule 2: a sign-in from another network address while a session of the card was used from a different one
  -- within this many minutes. Off by default: two devices on two networks are common.
  second_address_enabled        boolean NOT NULL DEFAULT false,
  second_address_window_minutes integer NOT NULL DEFAULT 15 CHECK (second_address_window_minutes BETWEEN 1 AND 120),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by_card_id     uuid,
  FOREIGN KEY (tenant_id, updated_by_card_id) REFERENCES cards (tenant_id, id)
);

-- One small counter per card (a fixed window), so counting a refusal costs one row write and never a scan.
CREATE TABLE card_anomaly_counters (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  card_id      uuid NOT NULL,
  window_start timestamptz NOT NULL,
  denials      integer NOT NULL CHECK (denials >= 0),
  PRIMARY KEY (tenant_id, card_id),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);

-- 2. Retirement radar: when a person plans to leave. Personal data, kept apart from the people table so that no
--    list of people ever carries it. It goes with the person.
CREATE TABLE person_leaving (
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  person_id          uuid NOT NULL,
  leaving_on         date NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_card_id uuid,
  PRIMARY KEY (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, updated_by_card_id) REFERENCES cards (tenant_id, id)
);
CREATE INDEX person_leaving_by_date ON person_leaving (tenant_id, leaving_on);

-- A nudge is created once per person and stage (24, 12, 6 months before the date) and goes with the date.
CREATE TABLE retirement_nudges (
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  person_id  uuid NOT NULL,
  stage      smallint NOT NULL CHECK (stage IN (24, 12, 6)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, person_id, stage),
  FOREIGN KEY (tenant_id, person_id) REFERENCES person_leaving (tenant_id, person_id) ON DELETE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['anomaly_settings', 'card_anomaly_counters', 'person_leaving', 'retirement_nudges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- All four belong to the API (cards and people are its tables). The AI service gets nothing.
GRANT SELECT, INSERT, UPDATE ON anomaly_settings TO legacyai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON card_anomaly_counters, person_leaving, retirement_nudges TO legacyai_app;

-- 3. Two new entries in a card's usage history: an anomaly rule locked the card; a rule fired but the card was
--    NOT locked because it is the last usable Owner card.
ALTER TABLE card_events DROP CONSTRAINT card_events_event_type_check;
ALTER TABLE card_events ADD CONSTRAINT card_events_event_type_check
  CHECK (event_type IN (
    'issued', 'activated', 'login_success', 'login_failed', 'sc_locked', 'unlocked',
    'suspended', 'reinstated', 'revoked', 'expired', 'renewed', 'replaced',
    'role_assigned', 'role_removed', 'restriction_denied', 'restrictions_changed',
    'credential_added', 'credential_removed', 'enrollment_token_issued', 'owner_recovered',
    'anomaly_locked', 'anomaly_not_locked'));

-- The audit trail may name the rule that fired and the stage of a nudge (never an address, never the date).
INSERT INTO audit_detail_keys (key) VALUES ('rule'), ('stage'), ('template_key');

-- migrate:down
DELETE FROM audit_detail_keys WHERE key IN ('rule', 'stage', 'template_key');
-- Usage-history rows of the two new kinds, of EVERY company, must go before the old constraint returns. The role
-- that runs migrations cannot bypass row-level security and the policy is forced on the owner too, so for this one
-- statement the owner (only the owner; the service logins are not the owner) is exempted. Same transaction.
ALTER TABLE card_events NO FORCE ROW LEVEL SECURITY;
DELETE FROM card_events WHERE event_type IN ('anomaly_locked', 'anomaly_not_locked');
ALTER TABLE card_events FORCE ROW LEVEL SECURITY;
ALTER TABLE card_events DROP CONSTRAINT card_events_event_type_check;
ALTER TABLE card_events ADD CONSTRAINT card_events_event_type_check
  CHECK (event_type IN (
    'issued', 'activated', 'login_success', 'login_failed', 'sc_locked', 'unlocked',
    'suspended', 'reinstated', 'revoked', 'expired', 'renewed', 'replaced',
    'role_assigned', 'role_removed', 'restriction_denied', 'restrictions_changed',
    'credential_added', 'credential_removed', 'enrollment_token_issued', 'owner_recovered'));
-- A card locked by an anomaly rule stays locked (the lock reason 'anomaly' has been allowed since the first
-- identity migration); an admin unlocks it as before.
DROP TABLE retirement_nudges;
DROP TABLE person_leaving;
DROP TABLE card_anomaly_counters;
DROP TABLE anomaly_settings;
