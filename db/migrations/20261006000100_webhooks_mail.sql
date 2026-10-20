-- migrate:up

-- Phase 4, Batch B: outgoing webhooks (feature 28, part B) and e-mail delivery of notices (features 11 and 33,
-- part C). docs/phase4/06-open-api-webhooks-email.md, decision D31.
--
-- Phase 1 left two design-only tables for this (`outbox_events`, `webhook_endpoints`, migration 20261002000500):
-- empty, no privileges, never read. They are replaced here by the real tables; the rollback puts the design-only
-- ones back exactly as they were.
DROP TABLE webhook_endpoints;
DROP TABLE outbox_events;

-- 1. The outbox: what happened, written IN THE SAME TRANSACTION as the change itself (by the trigger in step 4), so
--    an event exists if and only if the change was committed. Events carry identifiers and labels only - never a
--    title, a text or a name. The delivery job turns an event into one delivery per matching endpoint and marks it
--    published; published events are removed after 30 days by housekeeping.
CREATE TABLE outbox_events (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  topic        text NOT NULL CHECK (topic IN ('knowledge.item_released', 'knowledge.item_changed', 'knowledge.item_withdrawn')),
  payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 2000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_events_unpublished ON outbox_events (tenant_id, created_at) WHERE published_at IS NULL;

-- 2. Where a company's events are sent. Made by the Company Owner; `https` only (the address is checked again when
--    each delivery connects - docs/phase4/06). The signing secret is shown once and kept ENCRYPTED with the
--    credential keyring (it has to be read again to sign each delivery, so a hash would not do); it is wiped when
--    the endpoint is removed. `max_sensitivity`: events about knowledge labelled above this level are not sent.
--    The address and the maker never change: a new address is a new endpoint with a new secret.
CREATE TABLE webhook_endpoints (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  url                   text NOT NULL CHECK (url ~ '^https://' AND char_length(url) BETWEEN 9 AND 2048),
  topics                text[] NOT NULL CHECK (cardinality(topics) BETWEEN 1 AND 10
                          AND topics <@ ARRAY['knowledge.item_released', 'knowledge.item_changed', 'knowledge.item_withdrawn']),
  max_sensitivity       integer NOT NULL CHECK (max_sensitivity BETWEEN 0 AND 3),
  secret_enc            bytea,
  secret_key_id         text,
  secret_hint           text CHECK (secret_hint IS NULL OR secret_hint ~ '^[A-Za-z0-9+/=_-]{4}$'),
  -- switched on and off by the Owner
  enabled               boolean NOT NULL DEFAULT true,
  -- set by the system when deliveries keep failing; cleared when the Owner switches the endpoint on again
  paused_at             timestamptz,
  paused_reason         text CHECK (paused_reason IN ('failing')),
  consecutive_failures  integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  created_by_card_id    uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  removed_at            timestamptz,
  removed_by_card_id    uuid,
  UNIQUE (tenant_id, id),
  CHECK ((secret_enc IS NULL) = (secret_key_id IS NULL)),
  CHECK ((secret_enc IS NULL) = (secret_hint IS NULL)),
  CHECK ((removed_at IS NULL) = (secret_enc IS NOT NULL)),
  CHECK (removed_by_card_id IS NULL OR removed_at IS NOT NULL),
  CHECK ((paused_at IS NULL) = (paused_reason IS NULL)),
  FOREIGN KEY (tenant_id, created_by_card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, removed_by_card_id) REFERENCES cards (tenant_id, id)
);

CREATE FUNCTION webhook_endpoints_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.url <> OLD.url OR NEW.created_by_card_id <> OLD.created_by_card_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'webhook_endpoints: the address and the maker of an endpoint cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.removed_at IS NOT NULL AND (NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'webhook_endpoints: a removed endpoint stays removed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION webhook_endpoints_guard() FROM PUBLIC;
CREATE TRIGGER webhook_endpoints_guard BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_guard();

-- 3. One delivery = one event for one endpoint (a test message from the Owner has no outbox event). `body` is the
--    exact JSON that is sent (and signed) on every attempt, so a retry sends the same bytes. 'sending' is held for a
--    short time (locked_until); a delivery whose sender died is tried again after that - so a receiver may see the
--    same `webhook-id` twice and must ignore the second (documented). Removed by housekeeping after 30 days.
CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  endpoint_id      uuid NOT NULL,
  event_id         uuid NOT NULL,
  topic            text NOT NULL CHECK (topic ~ '^[a-z_]+\.[a-z_]+$'),
  body             jsonb NOT NULL CHECK (octet_length(body::text) <= 4000),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'cancelled')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_attempt_at  timestamptz,
  last_status_code integer CHECK (last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  last_error       text CHECK (last_error IN ('address_refused', 'dns', 'connect', 'tls', 'timeout', 'http_status', 'secret_unreadable')),
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, endpoint_id, event_id),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'sending') = (locked_until IS NOT NULL)),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (tenant_id, next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX webhook_deliveries_by_endpoint ON webhook_deliveries (tenant_id, endpoint_id, id);

-- 4. Knowledge events. A trigger, so that EVERY way an item changes - through the API, the AI service, the consent
--    withdrawal trigger, a housekeeping job - writes its event in the same transaction, and no new code path can
--    forget to. "Released" = usable in answers (verified or corrected).
--      knowledge.item_released  - an item became verified or corrected
--      knowledge.item_changed   - a released item stayed released but its version, label, department or title changed
--      knowledge.item_withdrawn - a released item stopped being released (back in review, stale, rejected, withdrawn)
--    The payload holds the item's id, status, department and label (before and after); never its title or text.
--    The function runs as the table owner so that neither service needs any privilege on the outbox for it.
CREATE FUNCTION knowledge_items_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  was_released boolean := TG_OP = 'UPDATE' AND OLD.status IN ('verified', 'corrected');
  is_released  boolean := NEW.status IN ('verified', 'corrected');
  event_topic  text;
BEGIN
  IF is_released AND NOT was_released THEN
    event_topic := 'knowledge.item_released';
  ELSIF was_released AND NOT is_released THEN
    event_topic := 'knowledge.item_withdrawn';
  ELSIF was_released AND is_released AND (NEW.status <> OLD.status OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
        OR NEW.sensitivity <> OLD.sensitivity OR NEW.department_id IS DISTINCT FROM OLD.department_id OR NEW.title <> OLD.title) THEN
    event_topic := 'knowledge.item_changed';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO outbox_events (tenant_id, topic, payload) VALUES (NEW.tenant_id, event_topic, jsonb_build_object(
    'item_id', NEW.id, 'status', NEW.status, 'department_id', NEW.department_id, 'sensitivity', NEW.sensitivity,
    'previous_sensitivity', CASE WHEN TG_OP = 'UPDATE' THEN OLD.sensitivity ELSE NEW.sensitivity END));
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION knowledge_items_outbox() FROM PUBLIC;
CREATE TRIGGER knowledge_items_outbox AFTER INSERT OR UPDATE ON knowledge_items FOR EACH ROW EXECUTE FUNCTION knowledge_items_outbox();

-- 5. E-mail (part C). A notice (the same events the log notifier has always written) is queued ONLY when an e-mail
--    sender is configured; with the default ('none') this table stays empty. Who receives it is decided when it is
--    sent, from the company's records at that moment: the queue keeps people's ids, never their addresses, and the
--    text is rendered from fixed templates when it is sent. No foreign key to cards: a notice can name a card of a
--    request that was rolled back afterwards - it then finds nobody to tell (docs/phase4/06).
CREATE TABLE mail_notices (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  type              text NOT NULL CHECK (type ~ '^[a-z_]{1,40}$'),
  card_id           uuid,
  recipient_card_id uuid,
  audience          text CHECK (audience IN ('owners')),
  about_tenant_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- when the recipients were worked out (one mail_messages row each)
  expanded_at       timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX mail_notices_open ON mail_notices (tenant_id, created_at) WHERE expanded_at IS NULL;

CREATE TABLE mail_messages (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  notice_id       uuid NOT NULL,
  person_id       uuid NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'no_address')),
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text CHECK (last_error IN ('rejected', 'unavailable', 'timeout')),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, notice_id, person_id),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK ((status = 'sending') = (locked_until IS NOT NULL)),
  FOREIGN KEY (tenant_id, notice_id) REFERENCES mail_notices (tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES people (tenant_id, id)
);
CREATE INDEX mail_messages_due ON mail_messages (tenant_id, next_attempt_at) WHERE status IN ('pending', 'sending');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_events', 'webhook_endpoints', 'webhook_deliveries', 'mail_notices', 'mail_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;
-- The knowledge trigger runs as the table owner (the role running this migration). An item can be changed in a
-- transaction that set no company (a test's superuser, a repair typed by hand), and the event must still be
-- written - so the owner, and only the owner, may add outbox rows for any company. Nothing else runs as the owner.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY trigger_insert ON outbox_events FOR INSERT TO %I WITH CHECK (true)', current_user);
END
$$;

-- All five belong to the API. The AI service gets nothing (its changes reach the outbox through the trigger).
-- No DELETE on endpoints: a removed endpoint stays as a record (its secret wiped).
GRANT SELECT, UPDATE, DELETE ON outbox_events TO legacyai_app;
GRANT SELECT, INSERT, UPDATE ON webhook_endpoints TO legacyai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries, mail_notices, mail_messages TO legacyai_app;

-- 6. Making, listing and removing endpoints is for the Company Owner only, like API keys (decision D31).
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('webhook:read',   'List the webhook endpoints of the company and their deliveries (never their secrets)', false, false),
  ('webhook:manage', 'Create, change and remove webhook endpoints; send a test message',                    true,  false);
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('company_owner', 'webhook:read',   'tenant', 3, 'base'),
  ('company_owner', 'webhook:manage', 'tenant', 3, 'base');

-- The audit trail may name the endpoint (its id, never its address or secret).
INSERT INTO audit_detail_keys (key) VALUES ('webhook_id');

-- migrate:down
DELETE FROM audit_detail_keys WHERE key = 'webhook_id';
DELETE FROM role_permissions WHERE permission_key IN ('webhook:read', 'webhook:manage');
DELETE FROM permissions WHERE permission_key IN ('webhook:read', 'webhook:manage');
-- Dropping the tables removes the rows of every company with them (DROP is not subject to row-level security):
-- queued e-mails and webhook deliveries that were not sent are lost, endpoints and their secrets are gone.
DROP TRIGGER knowledge_items_outbox ON knowledge_items;
DROP FUNCTION knowledge_items_outbox();
DROP TABLE mail_messages;
DROP TABLE mail_notices;
DROP TABLE webhook_deliveries;
DROP TRIGGER webhook_endpoints_guard ON webhook_endpoints;
DROP TABLE webhook_endpoints;
DROP FUNCTION webhook_endpoints_guard();
DROP TABLE outbox_events;

-- The design-only tables of migration 20261002000500, exactly as they were.
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

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outbox_events', 'webhook_endpoints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;
