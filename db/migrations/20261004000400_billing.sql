-- migrate:up

-- Phase 4, Batch B: billing and renewal (features 29, 31, 32, 33, 34, 35).
-- docs/phase4/05-billing.md, decisions D29-D33. No payment card data is stored anywhere: the tables below hold what
-- was due, what was paid and a reference given by the payment provider - never a card number.

-- 1. One subscription per company. No row = the company has not been touched by billing yet: its plan is
--    tenants.plan_code, no seat limit applies and nothing renews by itself (exactly the behaviour before this
--    migration). The renewal date itself is NOT stored here: it is the company card's expiry date (decision D19/D29).
--    Seats: `seats` is what the Owner ASKED for (for the next renewal, or as an addition now); `seat_limit` is what
--    was PAID for this term and limits how many person cards exist; `unlimited` can be set by the platform operator
--    only. A new company has no limit during its first term: its first paid renewal sets it.
CREATE TABLE subscriptions (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants (id),
  seats                integer CHECK (seats IS NULL OR seats BETWEEN 1 AND 100000),
  seat_limit           integer CHECK (seat_limit IS NULL OR seat_limit BETWEEN 1 AND 100000),
  unlimited            boolean NOT NULL DEFAULT false,
  auto_renew           boolean NOT NULL DEFAULT false,
  -- attempts of the automatic renewal for the CURRENT term (reset when a renewal is applied)
  auto_renew_attempts  integer NOT NULL DEFAULT 0 CHECK (auto_renew_attempts BETWEEN 0 AND 10),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_card_id   uuid,
  CHECK (NOT unlimited OR seat_limit IS NULL),
  FOREIGN KEY (tenant_id, updated_by_card_id) REFERENCES cards (tenant_id, id)
);

-- 2. Invoices: what was due and what happened to it. An invoice never changes what it says was due; only its
--    status moves, and only as the guard below allows (the same table as nextStatus() in billing.ts).
--    kind: 'renewal' = the next term; 'seats' = seats added to the running term (`seats` is then the number ADDED).
--    status: open -> paid | failed | void;  failed -> paid_late;  void -> paid_late;  paid and paid_late are final.
--    'paid_late' = money arrived for an invoice that had been declined or closed: it is on record and takes effect
--    only if the platform operator applies it.
--    settlement: who settled it - the payment provider, the operator by hand, or nobody (nothing was due).
CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  number            integer NOT NULL CHECK (number >= 1),           -- counts up per company
  kind              text NOT NULL CHECK (kind IN ('renewal', 'seats')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'failed', 'void', 'paid_late')),
  plan_code         text NOT NULL REFERENCES plan_limits (plan_code),
  seats             integer NOT NULL CHECK (seats >= 1),
  term_days         integer NOT NULL CHECK (term_days BETWEEN 1 AND 366),
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),      -- in the smallest unit of the currency; never a fraction
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  automatic         boolean NOT NULL DEFAULT false,                 -- created by the auto-renew sweep
  settlement        text CHECK (settlement IS NULL OR settlement IN ('provider', 'operator', 'no_charge')),
  provider_reference text CHECK (provider_reference IS NULL OR char_length(provider_reference) BETWEEN 1 AND 200),
  note              text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  issued_at         timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  closed_at         timestamptz,                                     -- failed or void
  applied_at        timestamptz,                                     -- the moment the invoice took effect (term renewed / seats added)
  attention_at      timestamptz,                                     -- the moment people were told that the payment did NOT take effect by itself
  created_by_card_id uuid,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id),
  CHECK ((status IN ('paid', 'paid_late')) = (paid_at IS NOT NULL)),
  CHECK ((status IN ('paid', 'paid_late')) = (settlement IS NOT NULL)),
  CHECK (applied_at IS NULL OR status IN ('paid', 'paid_late')),
  CHECK (attention_at IS NULL OR status IN ('paid', 'paid_late'))
);
-- At most ONE payable invoice per company at any time. The code closes the old one before issuing a new one; this
-- index makes the database refuse anything else.
CREATE UNIQUE INDEX invoices_one_open ON invoices (tenant_id) WHERE status = 'open';

CREATE FUNCTION invoices_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices: an invoice is never deleted' USING ERRCODE = 'check_violation';
  END IF;
  -- what was due, for whom and by whom it was issued: frozen
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.number <> OLD.number OR NEW.kind <> OLD.kind OR NEW.plan_code <> OLD.plan_code
     OR NEW.seats <> OLD.seats OR NEW.term_days <> OLD.term_days OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency OR NEW.issued_at <> OLD.issued_at OR NEW.automatic <> OLD.automatic
     OR NEW.created_by_card_id IS DISTINCT FROM OLD.created_by_card_id THEN
    RAISE EXCEPTION 'invoices: what was due cannot change after the invoice was issued' USING ERRCODE = 'check_violation';
  END IF;
  -- status: the transition table (billing.ts nextStatus)
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('paid', 'failed', 'void'))
    OR (OLD.status IN ('failed', 'void') AND NEW.status = 'paid_late')) THEN
    RAISE EXCEPTION 'invoices: illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  -- every other column changes once, and only together with the step it belongs to
  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at AND NOT (OLD.paid_at IS NULL AND NEW.status <> OLD.status AND NEW.status IN ('paid', 'paid_late')) THEN
    RAISE EXCEPTION 'invoices: paid_at is set once, when the invoice is paid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.settlement IS DISTINCT FROM OLD.settlement AND NOT (OLD.settlement IS NULL AND NEW.status <> OLD.status AND NEW.status IN ('paid', 'paid_late')) THEN
    RAISE EXCEPTION 'invoices: the settlement is set once, when the invoice is paid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.closed_at IS DISTINCT FROM OLD.closed_at AND NOT (OLD.closed_at IS NULL AND NEW.status <> OLD.status AND NEW.status IN ('failed', 'void')) THEN
    RAISE EXCEPTION 'invoices: closed_at is set once, when the invoice is closed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.provider_reference IS DISTINCT FROM OLD.provider_reference AND NOT (OLD.provider_reference IS NULL AND OLD.status = 'open' AND NEW.status = 'open') THEN
    RAISE EXCEPTION 'invoices: the provider reference is set once, while the invoice is open' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.note IS DISTINCT FROM OLD.note AND OLD.note IS NOT NULL THEN
    RAISE EXCEPTION 'invoices: the note is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.applied_at IS DISTINCT FROM OLD.applied_at AND OLD.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoices: an invoice takes effect once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attention_at IS DISTINCT FROM OLD.attention_at AND OLD.attention_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoices: a payment that did not take effect is reported once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION invoices_guard() FROM PUBLIC;
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_guard();

-- 3. Every message of the payment provider that passed the signature check, by the provider's own event id: the
--    same message arriving twice changes nothing the second time. A message is kept even when it changed nothing
--    (unknown invoice, another amount, an invoice that was already final) - `result` says what became of it.
--    No foreign key to invoices: a message about an invoice the company does not have must be storable too.
CREATE TABLE payment_events (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  event_id     text NOT NULL CHECK (char_length(event_id) BETWEEN 8 AND 100),
  invoice_id   uuid NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('paid', 'declined')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  result       text NOT NULL CHECK (result IN ('paid', 'declined', 'paid_late', 'no_change', 'amount_mismatch', 'unknown_invoice')),
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id)
);

-- 4. A reminder is created once per company, renewal date and stage.
CREATE TABLE billing_notices (
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  term_end    timestamptz NOT NULL,
  stage       text NOT NULL CHECK (stage IN ('30_days', '14_days', '3_days', 'in_grace', 'auto_renew_failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, term_end, stage)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'invoices', 'payment_events', 'billing_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- All four belong to the API. The AI service gets nothing. No DELETE on invoices or payment events.
GRANT SELECT, INSERT, UPDATE ON subscriptions, invoices TO legacyai_app;
GRANT SELECT, INSERT ON payment_events, billing_notices TO legacyai_app;

-- 5. Permissions. Reading and managing the company's own subscription is for the Company Owner; recording a payment
--    by hand is for the platform operator only (usable only in the operator's own company, like the other
--    platform permissions).
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('billing:read',    'Read the subscription and the invoices of the company', false, false),
  ('billing:manage',  'Change seats and auto-renew; start a renewal',          true,  false),
  ('billing:operate', 'Platform operator: read any company''s billing and record a payment by hand', true, true);
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('company_owner', 'billing:read',    'tenant', 3, 'base'),
  ('company_owner', 'billing:manage',  'tenant', 3, 'base'),
  ('company_owner', 'billing:operate', 'tenant', 3, 'base');

-- 6. The audit trail may name the invoice, the amount (a number), the currency, the seats and the outcome.
INSERT INTO audit_detail_keys (key) VALUES ('invoice_id'), ('amount_minor'), ('currency'), ('seats'), ('auto_renew'), ('payment_outcome');

-- migrate:down
DELETE FROM audit_detail_keys WHERE key IN ('invoice_id', 'amount_minor', 'currency', 'seats', 'auto_renew', 'payment_outcome');
DELETE FROM role_permissions WHERE permission_key IN ('billing:read', 'billing:manage', 'billing:operate');
DELETE FROM permissions WHERE permission_key IN ('billing:read', 'billing:manage', 'billing:operate');
-- Dropping the tables removes the rows of every company with them (DROP is not subject to row-level security).
-- Terms already renewed stay renewed: the company card keeps its dates.
DROP TABLE billing_notices;
DROP TABLE payment_events;
DROP TRIGGER invoices_guard ON invoices;
DROP TABLE invoices;
DROP FUNCTION invoices_guard();
DROP TABLE subscriptions;
