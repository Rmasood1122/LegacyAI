-- migrate:up

-- ------------------------------------------------------------------ audit log
-- Append-only, hash-chained per tenant. TAMPER-EVIDENT, not tamper-proof:
-- a database superuser can disable the triggers; the chain makes that detectable.

CREATE TABLE audit_chain_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id),
  last_seq  bigint NOT NULL,
  last_hash bytea NOT NULL
);

CREATE TABLE audit_log (
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  seq           bigint NOT NULL,
  occurred_at   timestamptz NOT NULL,
  actor_card_id uuid,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('card', 'system', 'anonymous', 'service')),
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  decision      text NOT NULL CHECK (decision IN ('allow', 'deny', 'event')),
  reason_code   text NOT NULL,
  request_id    text,
  ip            text,
  details       text NOT NULL DEFAULT '{}',   -- canonical JSON text; whitelisted keys only
  prev_hash     bytea NOT NULL,
  row_hash      bytea NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX audit_log_time ON audit_log (tenant_id, occurred_at);
CREATE INDEX audit_log_actor ON audit_log (tenant_id, actor_card_id, seq);
CREATE INDEX audit_log_resource ON audit_log (tenant_id, resource_type, resource_id);

-- One field of the hash input: "<byte length>:<value>", or "-1:" for NULL.
-- FROZEN FORMAT: the verifier in the API re-implements this independently. Do not change.
CREATE FUNCTION audit_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT CASE WHEN v IS NULL THEN '-1:' ELSE octet_length(v)::text || ':' || v END $$;

CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_seq  bigint;
  v_hash bytea;
  v_us   bigint;
BEGIN
  INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash)
  VALUES (NEW.tenant_id, 0, decode(repeat('00', 32), 'hex'))
  ON CONFLICT (tenant_id) DO NOTHING;

  -- Locks the tenant's head row: concurrent inserts queue up, the chain cannot fork.
  SELECT last_seq, last_hash INTO STRICT v_seq, v_hash
  FROM audit_chain_heads WHERE tenant_id = NEW.tenant_id FOR UPDATE;

  NEW.seq := v_seq + 1;
  NEW.occurred_at := date_trunc('microseconds', clock_timestamp());
  NEW.prev_hash := v_hash;
  v_us := (extract(epoch FROM NEW.occurred_at) * 1000000)::bigint;
  NEW.row_hash := sha256(NEW.prev_hash || convert_to(
       audit_field(NEW.tenant_id::text) || audit_field(NEW.seq::text) || audit_field(v_us::text)
    || audit_field(NEW.actor_card_id::text) || audit_field(NEW.actor_kind) || audit_field(NEW.action)
    || audit_field(NEW.resource_type) || audit_field(NEW.resource_id) || audit_field(NEW.decision)
    || audit_field(NEW.reason_code) || audit_field(NEW.request_id) || audit_field(NEW.ip)
    || audit_field(NEW.details), 'UTF8'));

  UPDATE audit_chain_heads SET last_seq = NEW.seq, last_hash = NEW.row_hash WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION audit_log_chain() FROM PUBLIC;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();

-- Record of each time a chain head was copied to the external write-once-style bucket.
CREATE TABLE audit_anchors (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  seq         bigint NOT NULL,
  row_hash    bytea NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT now(),
  object_uri  text NOT NULL
);
CREATE INDEX audit_anchors_latest ON audit_anchors (tenant_id, seq DESC);

-- ------------------------------------------------------------ idempotency keys
CREATE TABLE idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  actor_card_id   uuid NOT NULL,
  key             text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 128),
  operation_id    text NOT NULL,
  request_hash    bytea NOT NULL,
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  response_status integer,
  response_body   jsonb,           -- one-time secrets are stripped before storing
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, actor_card_id, key)
);

-- ------------------------------------------------------------- rate limiting (GLOBAL)
CREATE TABLE rate_limit_buckets (
  bucket_key   bytea NOT NULL,     -- HMAC of e.g. "ip:<addr>:login"; never the raw value
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX rate_limit_buckets_time ON rate_limit_buckets (window_start);

-- ---------------------------------------------------------------- export jobs
CREATE TABLE export_jobs (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  requested_by_card_id uuid NOT NULL,
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  format               text NOT NULL DEFAULT 'jsonl+csv',
  manifest             jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_chain_heads', 'audit_log', 'audit_anchors', 'idempotency_keys', 'export_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

GRANT SELECT, INSERT ON audit_log TO legacyai_app;                 -- no UPDATE, no DELETE, no TRUNCATE
GRANT SELECT ON audit_chain_heads TO legacyai_app;                 -- written only by the trigger
GRANT SELECT, INSERT ON audit_anchors TO legacyai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys, rate_limit_buckets TO legacyai_app;
GRANT SELECT, INSERT, UPDATE ON export_jobs TO legacyai_app;

-- migrate:down
DROP TABLE export_jobs;
DROP TABLE rate_limit_buckets;
DROP TABLE idempotency_keys;
DROP TABLE audit_anchors;
DROP TABLE audit_log;
DROP FUNCTION audit_log_reject_change();
DROP FUNCTION audit_log_chain();
DROP FUNCTION audit_field(text);
DROP TABLE audit_chain_heads;
