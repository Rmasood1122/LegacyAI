-- migrate:up

-- DESIGN-ONLY HOOKS. These tables exist so later phases do not need a schema redesign.
-- No Phase 1 code reads or writes them, and the app role gets NO privileges on them yet.

-- F28 webhooks / connectors: transactional outbox.
CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  topic        text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_events_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE webhook_endpoints (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  url        text NOT NULL,
  secret_ref text,                       -- a Secret Manager reference, never the secret
  topics     text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- F27 outcome analytics. Separate from the audit log: analytics may be sampled and deleted.
CREATE TABLE analytics_events (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  card_id     uuid,
  event_name  text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  properties  jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- F4 QR / NFC / wallet formats. A token identifies a card; it never carries the SC
-- and never replaces the strong factor.
CREATE TABLE card_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  card_id    uuid NOT NULL,
  format     text NOT NULL CHECK (format IN ('qr', 'nfc', 'wallet')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id)
);

-- F16 SSO. An SSO assertion would count as the strong factor; it would not replace the card.
CREATE TABLE sso_connections (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  protocol   text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  issuer     text NOT NULL,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_events', 'webhook_endpoints', 'analytics_events', 'card_tokens', 'sso_connections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

-- migrate:down
DROP TABLE sso_connections;
DROP TABLE card_tokens;
DROP TABLE analytics_events;
DROP TABLE webhook_endpoints;
DROP TABLE outbox_events;
