-- migrate:up

CREATE TABLE people (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  display_name  text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  email         text CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email = lower(email))),
  department_id uuid,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'departed')),
  external_id   text,                              -- F16 SCIM hook, design only
  scim_managed  boolean NOT NULL DEFAULT false,    -- F16 SCIM hook, design only
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, external_id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);

CREATE TABLE cards (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  kind                text NOT NULL CHECK (kind IN ('person', 'company')),
  person_id           uuid,
  card_number         text NOT NULL UNIQUE CHECK (card_number ~ '^[0-9]{16}$'),
  state               text NOT NULL DEFAULT 'issued'
                      CHECK (state IN ('issued', 'active', 'suspended', 'revoked', 'expired', 'replaced')),
  state_changed_at    timestamptz NOT NULL DEFAULT now(),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  activated_at        timestamptz,
  expires_at          timestamptz NOT NULL,
  grace_until         timestamptz NOT NULL,
  renewal_due         timestamptz NOT NULL,
  renewal_count       integer NOT NULL DEFAULT 0,
  last_renewed_at     timestamptz,
  replaced_by_card_id uuid,
  replaces_card_id    uuid,
  suspended_reason    text,
  revoked_reason      text,
  issued_by_card_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id),
  CHECK ((kind = 'person') = (person_id IS NOT NULL)),
  CHECK (grace_until >= expires_at AND renewal_due <= expires_at)
);
CREATE INDEX cards_tenant_state ON cards (tenant_id, state);
CREATE INDEX cards_tenant_expiry ON cards (tenant_id, expires_at);
CREATE UNIQUE INDEX cards_one_live_per_person ON cards (tenant_id, person_id)
  WHERE kind = 'person' AND state NOT IN ('revoked', 'replaced');
CREATE UNIQUE INDEX cards_one_live_company ON cards (tenant_id)
  WHERE kind = 'company' AND state NOT IN ('revoked', 'replaced');

-- Second line of defence for the lifecycle state machine (the first is in the API code).
CREATE FUNCTION cards_enforce_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
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
      ('suspended', 'active'), ('suspended', 'revoked'), ('suspended', 'replaced'),
      ('expired', 'active'), ('expired', 'revoked'), ('expired', 'replaced')
    )) THEN
      RAISE EXCEPTION 'illegal card state transition % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
    END IF;
    NEW.state_changed_at := now();
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.card_number <> OLD.card_number OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'tenant_id, card_number and kind of a card are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cards_lifecycle BEFORE INSERT OR UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION cards_enforce_lifecycle();

-- Global map card number -> tenant, so login can start before the tenant is known.
-- The app role has NO privileges on this table; it can only call resolve_card().
CREATE TABLE card_directory (
  card_number text PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  card_id     uuid NOT NULL UNIQUE
);

CREATE FUNCTION cards_register_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO card_directory (card_number, tenant_id, card_id) VALUES (NEW.card_number, NEW.tenant_id, NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER cards_directory AFTER INSERT ON cards
  FOR EACH ROW EXECUTE FUNCTION cards_register_directory();

CREATE FUNCTION resolve_card(p_card_number text) RETURNS TABLE (tenant_id uuid, card_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$ SELECT d.tenant_id, d.card_id FROM card_directory d WHERE d.card_number = p_card_number $$;
REVOKE ALL ON FUNCTION resolve_card(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cards_register_directory() FROM PUBLIC;

CREATE TABLE card_secrets (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  card_id            uuid NOT NULL,
  sc_hash            text,            -- Argon2id PHC string of HMAC(pepper, card_id:SC). Never the SC.
  pepper_id          text NOT NULL,
  status             text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'retired')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz,
  created_by_card_id uuid,
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  CHECK ((status = 'current') = (sc_hash IS NOT NULL)),
  CHECK (sc_hash IS NULL OR sc_hash LIKE '$argon2id$%')
);
CREATE UNIQUE INDEX card_secrets_one_current ON card_secrets (tenant_id, card_id) WHERE status = 'current';

CREATE TABLE card_auth_state (
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  card_id                uuid NOT NULL,
  sc_failed_count        integer NOT NULL DEFAULT 0 CHECK (sc_failed_count >= 0),
  locked_at              timestamptz,
  lock_reason            text CHECK (lock_reason IN ('sc_attempts', 'admin', 'anomaly')),  -- anomaly: F5 design only
  factor_failed_count    integer NOT NULL DEFAULT 0 CHECK (factor_failed_count >= 0),
  factor_window_start    timestamptz,
  factor_throttle_level  integer NOT NULL DEFAULT 0,
  factor_throttled_until timestamptz,
  last_totp_step         bigint,
  last_login_at          timestamptz,
  PRIMARY KEY (tenant_id, card_id),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  CHECK ((locked_at IS NULL) = (lock_reason IS NULL))
);

CREATE TABLE credentials (
  id                     uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  card_id                uuid NOT NULL,
  type                   text NOT NULL CHECK (type IN ('passkey', 'totp')),
  label                  text NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  webauthn_credential_id text UNIQUE,     -- base64url
  webauthn_public_key    bytea,
  webauthn_sign_count    bigint,
  webauthn_transports    text[],
  totp_secret_enc        bytea,           -- AES-256-GCM ciphertext of the seed
  totp_key_id            text,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_used_at           timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  CHECK (
    (type = 'passkey' AND webauthn_credential_id IS NOT NULL AND webauthn_public_key IS NOT NULL
       AND totp_secret_enc IS NULL AND totp_key_id IS NULL)
    OR
    (type = 'totp' AND totp_secret_enc IS NOT NULL AND totp_key_id IS NOT NULL
       AND webauthn_credential_id IS NULL AND webauthn_public_key IS NULL)
  )
);
CREATE INDEX credentials_card ON credentials (tenant_id, card_id) WHERE status = 'active';

CREATE TABLE enrollment_tokens (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  card_id            uuid NOT NULL,
  token_hash         bytea NOT NULL UNIQUE,   -- SHA-256 of the token; the token is never stored
  purpose            text NOT NULL CHECK (purpose IN ('initial', 'reset')),
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  created_by_card_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);
CREATE INDEX enrollment_tokens_by_card ON enrollment_tokens (tenant_id, card_id);

-- Short-lived state for one login or enrollment in progress. GLOBAL on purpose:
-- a login for an unknown card number has no tenant, and the transaction token must
-- look the same for known and unknown cards (no enumeration).
CREATE TABLE auth_transactions (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  txn_hash    bytea NOT NULL UNIQUE,
  purpose     text NOT NULL CHECK (purpose IN ('login', 'enroll')),
  tenant_id   uuid,
  card_id     uuid,
  challenge   text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash     bytea,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_transactions_expiry ON auth_transactions (expires_at);

CREATE TABLE sessions (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  card_id                 uuid NOT NULL,
  token_hash              bytea NOT NULL UNIQUE,   -- SHA-256 of the session token; the token is never stored
  csrf_hash               bytea NOT NULL,
  credential_id           uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  idle_expires_at         timestamptz NOT NULL,
  absolute_expires_at     timestamptz NOT NULL,
  revoked_at              timestamptz,
  revoked_reason          text,
  rotated_from_session_id uuid,
  ip_hash                 bytea,
  user_agent_hash         bytea,
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX sessions_live_by_card ON sessions (tenant_id, card_id) WHERE revoked_at IS NULL;

CREATE TABLE card_events (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  card_id       uuid NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  event_type    text NOT NULL CHECK (event_type IN (
                  'issued', 'activated', 'login_success', 'login_failed', 'sc_locked', 'unlocked',
                  'suspended', 'reinstated', 'revoked', 'expired', 'renewed', 'replaced',
                  'role_assigned', 'role_removed', 'restriction_denied', 'restrictions_changed',
                  'credential_added', 'credential_removed', 'enrollment_token_issued')),
  actor_card_id uuid,
  credential_id uuid,
  device_hash   bytea,
  ip_hash       bytea,
  request_id    text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);
CREATE INDEX card_events_by_card ON card_events (tenant_id, card_id, id DESC);

CREATE TABLE card_restrictions (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  card_id            uuid NOT NULL,
  type               text NOT NULL CHECK (type IN ('usage_cap', 'time_window', 'network_allowlist', 'read_only')),
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  created_by_card_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);
CREATE INDEX card_restrictions_by_card ON card_restrictions (tenant_id, card_id);

CREATE TABLE card_usage_counters (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  card_id      uuid NOT NULL,
  limit_key    text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, card_id, limit_key, window_start),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);

-- Internal record of every login attempt, including unknown card numbers. GLOBAL.
-- The app role may only INSERT. real_reason is never returned to any caller.
CREATE TABLE login_attempts (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  card_number_hmac bytea NOT NULL,
  tenant_id        uuid,
  card_id          uuid,
  ip_hash          bytea,
  outcome          text NOT NULL CHECK (outcome IN ('success', 'fail')),
  real_reason      text NOT NULL,
  request_id       text
);
CREATE INDEX login_attempts_time ON login_attempts (occurred_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people', 'cards', 'card_secrets', 'card_auth_state', 'credentials', 'enrollment_tokens',
                           'sessions', 'card_events', 'card_restrictions', 'card_usage_counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON people, cards, card_secrets, card_auth_state, credentials,
  enrollment_tokens, sessions TO legacyai_app;
GRANT SELECT, INSERT ON card_events TO legacyai_app;                      -- append-only for the app
GRANT SELECT, INSERT, UPDATE, DELETE ON card_restrictions, card_usage_counters, auth_transactions TO legacyai_app;
GRANT INSERT ON login_attempts TO legacyai_app;                           -- write-only for the app
GRANT EXECUTE ON FUNCTION resolve_card(text) TO legacyai_app;

-- migrate:down
DROP TABLE login_attempts;
DROP TABLE card_usage_counters;
DROP TABLE card_restrictions;
DROP TABLE card_events;
DROP TABLE sessions;
DROP TABLE auth_transactions;
DROP TABLE enrollment_tokens;
DROP TABLE credentials;
DROP TABLE card_auth_state;
DROP TABLE card_secrets;
DROP FUNCTION resolve_card(text);
DROP TABLE card_directory;
DROP TABLE cards;
DROP FUNCTION cards_register_directory();
DROP FUNCTION cards_enforce_lifecycle();
DROP TABLE people;
