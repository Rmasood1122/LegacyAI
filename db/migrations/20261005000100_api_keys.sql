-- migrate:up

-- Phase 4, Batch B: API keys for machines (feature 28, part A). docs/phase4/06-open-api-webhooks-email.md, D30.
--
-- A key acts ON BEHALF OF the card that created it and can never do more than that card can do at the moment of
-- the request: what a key may do is the overlap of (1) what its creator's card may do right now, (2) the
-- permissions written into the key when it was made, and (3) the short list of permissions a key may ever carry
-- (kept in code: read and ask only). A key does not survive a change of its maker's sign-in or rights: when the
-- maker's secret code is rotated, its sign-in factors are reset, its roles change, or its card is replaced,
-- revoked, suspended or locked, every key that card made is REVOKED in the same transaction - for good. While
-- none of that has happened, the maker's card state still decides on every request (an expired card: read-only
-- grace, then nothing).
--
-- The secret is shown once. Only its SHA-256 is stored (the secret is 32 random bytes, so a plain hash is enough;
-- there is nothing to guess). `secret_hint` is the last four characters, to tell keys apart on a screen.
CREATE TABLE api_keys (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_by_card_id  uuid NOT NULL,
  secret_hash         bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  secret_hint         text NOT NULL CHECK (secret_hint ~ '^[A-Za-z0-9_-]{4}$'),
  scope               text[] NOT NULL CHECK (cardinality(scope) BETWEEN 1 AND 20),
  max_sensitivity     integer NOT NULL CHECK (max_sensitivity BETWEEN 0 AND 3),
  -- how many questions the key may ask per hour (each one costs the company's AI allowance, which all share)
  asks_per_hour       integer NOT NULL DEFAULT 30 CHECK (asks_per_hour BETWEEN 1 AND 600),
  -- optional: the key works only from these networks (CIDR notation); NULL = from anywhere
  allowed_cidrs       text[] CHECK (allowed_cidrs IS NULL OR cardinality(allowed_cidrs) BETWEEN 1 AND 20),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  -- who revoked it by hand; NULL when the system did (see revoked_reason)
  revoked_by_card_id  uuid,
  revoked_reason      text CHECK (revoked_reason IN (
                        'by_owner', 'maker_code_rotated', 'maker_credentials_reset', 'maker_privilege_change',
                        'maker_card_replaced', 'maker_card_revoked', 'maker_card_suspended', 'maker_card_locked')),
  -- set by the system: the key itself asked for too many things it may not have ('denials': the anomaly rule,
  -- counted per KEY - the creator's card is never locked for what its key did). Final: only revoking remains
  -- possible afterwards. WRONG SECRETS NEVER SUSPEND A KEY: the key's id is not secret, so anybody who has seen it
  -- could otherwise stop somebody else's integration; a 256-bit secret cannot be guessed. Wrong secrets are
  -- counted, written to the audit log (bounded) and reported to the Owners once per window.
  suspended_at        timestamptz,
  suspended_reason    text CHECK (suspended_reason IN ('denials')),
  denial_window_start timestamptz,
  denial_count        integer NOT NULL DEFAULT 0 CHECK (denial_count >= 0),
  -- attempts to use the key that were refused before the policy was asked (wrong secret, revoked, suspended,
  -- expired, wrong network, maker cannot act): counted per window; the audit log gets at most one row per key,
  -- reason and window (failed_reasons = the reasons already written in this window)
  failed_window_start timestamptz,
  failed_count        integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  wrong_secret_count  integer NOT NULL DEFAULT 0 CHECK (wrong_secret_count >= 0),
  failed_reasons      text[] NOT NULL DEFAULT '{}' CHECK (cardinality(failed_reasons) <= 10),
  UNIQUE (tenant_id, id),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (revoked_by_card_id IS NULL OR revoked_reason = 'by_owner'),
  CHECK ((suspended_at IS NULL) = (suspended_reason IS NULL)),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by_card_id) REFERENCES cards (tenant_id, id)
);
CREATE INDEX api_keys_by_creator ON api_keys (tenant_id, created_by_card_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_keys USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- What a key is never changes, and stopping it is final. The application never tries to do otherwise; this makes
-- the database refuse it too (a mistake in code, or a statement typed by hand under the app's role).
CREATE FUNCTION api_keys_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- whose key it is, what it may do and its secret: frozen from the moment it is made
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by_card_id <> OLD.created_by_card_id
     OR NEW.secret_hash <> OLD.secret_hash OR NEW.secret_hint <> OLD.secret_hint OR NEW.scope <> OLD.scope
     OR NEW.max_sensitivity <> OLD.max_sensitivity OR NEW.asks_per_hour <> OLD.asks_per_hour OR NEW.name <> OLD.name
     OR NEW.allowed_cidrs IS DISTINCT FROM OLD.allowed_cidrs OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'api_keys: what a key is cannot change after it was made' USING ERRCODE = 'check_violation';
  END IF;
  -- revoking is final
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
                                     OR NEW.revoked_by_card_id IS DISTINCT FROM OLD.revoked_by_card_id) THEN
    RAISE EXCEPTION 'api_keys: a revoked key stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  -- so is a suspension
  IF OLD.suspended_at IS NOT NULL AND (NEW.suspended_at IS DISTINCT FROM OLD.suspended_at OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason) THEN
    RAISE EXCEPTION 'api_keys: a suspended key stays suspended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION api_keys_guard() FROM PUBLIC;
CREATE TRIGGER api_keys_guard BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION api_keys_guard();

-- The table belongs to the API. No DELETE: a revoked key stays as a record. The AI service gets nothing.
GRANT SELECT, INSERT, UPDATE ON api_keys TO legacyai_app;

-- Making, listing and revoking keys is for the Company Owner only (decision D30).
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('api_key:read',   'List the API keys of the company (never their secrets)', false, false),
  ('api_key:manage', 'Create and revoke API keys',                             true,  false);
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('company_owner', 'api_key:read',   'tenant', 3, 'base'),
  ('company_owner', 'api_key:manage', 'tenant', 3, 'base');

-- The audit trail may name the key that made a request (its id, never its secret).
INSERT INTO audit_detail_keys (key) VALUES ('api_key_id');

-- A repeated request ("Idempotency-Key") is answered from the record of whoever made it. Until now that was
-- always a card. A key gets records of its OWN: not its maker's, not another key's. The actor is therefore a card
-- OR a key - exactly one of the two - and each has its own foreign key (a key's id in the card column would break
-- the foreign key to cards, and would let a key and a card be confused).
-- The primary key (tenant, card, key string) cannot hold a row without a card, so it becomes two unique indexes.
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ALTER COLUMN actor_card_id DROP NOT NULL;
ALTER TABLE idempotency_keys ADD COLUMN actor_api_key_id uuid;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_one_actor CHECK ((actor_card_id IS NULL) <> (actor_api_key_id IS NULL)),
  ADD CONSTRAINT idempotency_keys_api_key_fk FOREIGN KEY (tenant_id, actor_api_key_id) REFERENCES api_keys (tenant_id, id);
CREATE UNIQUE INDEX idempotency_keys_by_card ON idempotency_keys (tenant_id, actor_card_id, key) WHERE actor_card_id IS NOT NULL;
CREATE UNIQUE INDEX idempotency_keys_by_api_key ON idempotency_keys (tenant_id, actor_api_key_id, key) WHERE actor_api_key_id IS NOT NULL;

-- migrate:down
-- Records of repeated requests made with a key go first (of EVERY company: the role that runs migrations cannot
-- bypass row-level security, so FORCE is lifted for the table's owner for this one statement and put back at once;
-- a failure rolls the whole migration back). They are short-lived replay records, nothing else refers to them.
ALTER TABLE idempotency_keys NO FORCE ROW LEVEL SECURITY;
DELETE FROM idempotency_keys WHERE actor_api_key_id IS NOT NULL;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
DROP INDEX idempotency_keys_by_api_key;
DROP INDEX idempotency_keys_by_card;
ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_api_key_fk,
  DROP CONSTRAINT idempotency_keys_one_actor,
  DROP COLUMN actor_api_key_id;
ALTER TABLE idempotency_keys ALTER COLUMN actor_card_id SET NOT NULL;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, actor_card_id, key);
DELETE FROM audit_detail_keys WHERE key = 'api_key_id';
DELETE FROM role_permissions WHERE permission_key IN ('api_key:read', 'api_key:manage');
DELETE FROM permissions WHERE permission_key IN ('api_key:read', 'api_key:manage');
-- Dropping the table removes the keys of every company with it (DROP is not subject to row-level security);
-- every key stops working. Audit rows that name a key keep its id.
DROP TABLE api_keys;
DROP FUNCTION api_keys_guard();
