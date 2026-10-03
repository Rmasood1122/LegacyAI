-- migrate:up

-- Phase 2 AI cost control (docs/phase2/04). Money is in whole micro-dollars (millionths of a dollar).

INSERT INTO plan_limits (plan_code, max_person_cards, max_admin_cards) VALUES ('free', NULL, NULL);

CREATE TABLE ai_plan_defaults (
  plan_code             text PRIMARY KEY REFERENCES plan_limits (plan_code),
  monthly_cap_micro_usd bigint NOT NULL CHECK (monthly_cap_micro_usd >= 0),
  max_input_tokens      integer NOT NULL CHECK (max_input_tokens BETWEEN 100 AND 100000),
  max_output_tokens     integer NOT NULL CHECK (max_output_tokens BETWEEN 50 AND 20000),
  calls_per_hour        integer NOT NULL CHECK (calls_per_hour BETWEEN 1 AND 100000)
);
-- Suggested defaults (docs/phase2/11, decision 7); the founder confirms the numbers at Gate 2.
INSERT INTO ai_plan_defaults VALUES
  ('pilot', 5000000, 4000, 600, 300),
  ('free',  1000000, 4000, 600, 60);

CREATE TABLE ai_global (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),      -- exactly one row
  kill_switch           boolean NOT NULL DEFAULT false,
  kill_switch_reason    text CHECK (kill_switch_reason IS NULL OR char_length(kill_switch_reason) <= 200),
  monthly_cap_micro_usd bigint NOT NULL DEFAULT 20000000 CHECK (monthly_cap_micro_usd >= 0),
  period                char(7) NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'),
  spent_micro_usd       bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  reserved_micro_usd    bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_global DEFAULT VALUES;

CREATE TABLE ai_budgets (
  tenant_id             uuid PRIMARY KEY REFERENCES tenants (id),
  monthly_cap_micro_usd bigint NOT NULL CHECK (monthly_cap_micro_usd >= 0),
  updated_by_card_id    uuid,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_budget_periods (
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  period             char(7) NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  spent_micro_usd    bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  calls              integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE ai_usage_ledger (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id                   uuid NOT NULL REFERENCES tenants (id),
  card_id                     uuid,
  feature                     text NOT NULL CHECK (feature IN ('answer', 'interview_question', 'item_extract', 'topic_extract',
                                                               'quiz_generate', 'quiz_grade', 'eval_judge')),
  provider                    text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  model                       text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 100),
  prompt_version              text,
  attempt                     smallint NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 5),
  status                      text NOT NULL CHECK (status IN ('reserved', 'settled', 'failed_charged', 'failed_free', 'expired_charged',
                                'refused_budget', 'refused_global', 'refused_kill_switch', 'refused_limits', 'refused_rate')),
  input_tokens                integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens               integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reserved_micro_usd          bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  cost_micro_usd              bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  price_input_micro_per_mtok  bigint NOT NULL DEFAULT 0 CHECK (price_input_micro_per_mtok >= 0),
  price_output_micro_per_mtok bigint NOT NULL DEFAULT 0 CHECK (price_output_micro_per_mtok >= 0),
  request_id                  text,
  latency_ms                  integer,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  settled_at                  timestamptz,
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  CHECK ((status = 'reserved') = (settled_at IS NULL)),
  CHECK (status NOT LIKE 'refused%' OR (cost_micro_usd = 0 AND reserved_micro_usd = 0))
);
CREATE INDEX ai_usage_ledger_time ON ai_usage_ledger (tenant_id, created_at);
CREATE INDEX ai_usage_ledger_open ON ai_usage_ledger (tenant_id, created_at) WHERE status = 'reserved';

-- A ledger row is written once, then settled once. Nothing else about it changes.
CREATE FUNCTION ai_usage_ledger_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'reserved' THEN
    RAISE EXCEPTION 'ai_usage_ledger: a settled row does not change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status NOT IN ('settled', 'failed_charged', 'failed_free', 'expired_charged') THEN
    RAISE EXCEPTION 'ai_usage_ledger: a reservation can only be settled' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.feature <> OLD.feature OR NEW.model <> OLD.model OR NEW.reserved_micro_usd <> OLD.reserved_micro_usd
     OR NEW.created_at <> OLD.created_at OR NEW.attempt <> OLD.attempt THEN
    RAISE EXCEPTION 'ai_usage_ledger: only the outcome of a reservation is recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER ai_usage_ledger_guard BEFORE UPDATE ON ai_usage_ledger FOR EACH ROW EXECUTE FUNCTION ai_usage_ledger_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_budgets', 'ai_budget_periods', 'ai_usage_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

GRANT SELECT ON ai_plan_defaults TO legacyai_app, legacyai_ai;
GRANT SELECT ON ai_global TO legacyai_app, legacyai_ai;
GRANT UPDATE (kill_switch, kill_switch_reason, monthly_cap_micro_usd, updated_at) ON ai_global TO legacyai_app;
GRANT UPDATE (period, spent_micro_usd, reserved_micro_usd, updated_at) ON ai_global TO legacyai_ai;
GRANT SELECT, INSERT, UPDATE ON ai_budgets TO legacyai_app;
GRANT SELECT ON ai_budgets TO legacyai_ai;
GRANT SELECT ON ai_budget_periods, ai_usage_ledger TO legacyai_app;
GRANT SELECT, INSERT, UPDATE ON ai_budget_periods TO legacyai_ai;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_usage_ledger TO legacyai_ai;

-- migrate:down
DROP TABLE ai_usage_ledger;
DROP FUNCTION ai_usage_ledger_guard();
DROP TABLE ai_budget_periods;
DROP TABLE ai_budgets;
DROP TABLE ai_global;
DROP TABLE ai_plan_defaults;
DELETE FROM plan_limits WHERE plan_code = 'free';
