-- migrate:up

-- The tenant the current transaction is working for. Unset or empty => NULL => no rows match.
-- A value that is not a UUID raises an error (fails closed).
CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE plan_limits (
  plan_code        text PRIMARY KEY,
  max_person_cards integer CHECK (max_person_cards IS NULL OR max_person_cards >= 0),
  max_admin_cards  integer CHECK (max_admin_cards IS NULL OR max_admin_cards >= 0),
  features         jsonb NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO plan_limits (plan_code, max_person_cards, max_admin_cards) VALUES ('pilot', NULL, NULL);

CREATE TABLE tenants (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  slug               text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  is_platform        boolean NOT NULL DEFAULT false,
  plan_code          text NOT NULL DEFAULT 'pilot' REFERENCES plan_limits (plan_code),
  region             text NOT NULL DEFAULT 'us' CHECK (region IN ('us', 'eu')),      -- F21 hook, design only
  encryption_key_ref text,                                                           -- F21 BYOK hook, design only
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tenants_single_platform ON tenants (is_platform) WHERE is_platform;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
-- Read-only, cross-tenant listing for the platform operator. The API switches this on
-- for one transaction only, after the policy decision point allowed tenant:list.
CREATE POLICY platform_read ON tenants FOR SELECT
  USING (current_setting('app.platform_scope', true) = 'on');

CREATE TABLE tenant_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants (id),
  card_validity_days     integer NOT NULL DEFAULT 90 CHECK (card_validity_days BETWEEN 1 AND 366),
  grace_days             integer NOT NULL DEFAULT 14 CHECK (grace_days BETWEEN 0 AND 60),
  renewal_notice_days    integer NOT NULL DEFAULT 14 CHECK (renewal_notice_days BETWEEN 0 AND 60),
  sc_lockout_threshold   integer NOT NULL DEFAULT 5 CHECK (sc_lockout_threshold BETWEEN 3 AND 5),
  session_idle_minutes   integer NOT NULL DEFAULT 30 CHECK (session_idle_minutes BETWEEN 5 AND 120),
  session_absolute_hours integer NOT NULL DEFAULT 12 CHECK (session_absolute_hours BETWEEN 1 AND 24),
  enabled_roles          text[] NOT NULL DEFAULT ARRAY['company_owner', 'admin', 'expert', 'successor'],
  pilot_reviewer_grant   boolean NOT NULL DEFAULT true,
  allowed_factor_types   text[] NOT NULL DEFAULT ARRAY['passkey', 'totp']
                         CHECK (allowed_factor_types <@ ARRAY['passkey', 'totp'] AND cardinality(allowed_factor_types) >= 1),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by_card_id     uuid
);

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings', 'departments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

GRANT SELECT ON plan_limits TO legacyai_app;
GRANT SELECT ON schema_migrations TO legacyai_app;   -- readiness check: is the schema current?
GRANT SELECT, INSERT, UPDATE ON tenants, tenant_settings TO legacyai_app;
GRANT SELECT, INSERT ON departments TO legacyai_app;

-- The LegacyAI operator tenant. Fixed id so system-level audit events have a home.
SELECT set_config('app.tenant_id', '00000000-0000-7000-8000-000000000001', true);
INSERT INTO tenants (id, name, slug, is_platform)
VALUES ('00000000-0000-7000-8000-000000000001', 'LegacyAI Platform', 'legacyai-platform', true);
INSERT INTO tenant_settings (tenant_id) VALUES ('00000000-0000-7000-8000-000000000001');

-- migrate:down
REVOKE SELECT ON schema_migrations FROM legacyai_app;
DROP TABLE departments;
DROP TABLE tenant_settings;
DROP TABLE tenants;
DROP TABLE plan_limits;
DROP FUNCTION app_current_tenant();
