-- migrate:up

-- Roles, permissions and the role -> permission matrix. GLOBAL, read-only for the app.
-- This file is also the seed: policy is data, and this is the data.

CREATE TABLE roles (
  role_key      text PRIMARY KEY,
  display_name  text NOT NULL,
  rank          integer NOT NULL,          -- used by the "cannot grant a role above your own" rule
  pilot_enabled boolean NOT NULL
);

CREATE TABLE permissions (
  permission_key text PRIMARY KEY CHECK (permission_key ~ '^[a-z_]+:[a-z_]+$'),
  description    text NOT NULL,
  is_write       boolean NOT NULL,         -- drives the read-only grace rule
  platform_only  boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permissions (
  role_key        text NOT NULL REFERENCES roles (role_key),
  permission_key  text NOT NULL REFERENCES permissions (permission_key),
  scope           text NOT NULL CHECK (scope IN ('tenant', 'department', 'own')),
  max_sensitivity smallint NOT NULL DEFAULT 0 CHECK (max_sensitivity BETWEEN 0 AND 3),
  grant_source    text NOT NULL DEFAULT 'base' CHECK (grant_source IN ('base', 'pilot_reviewer')),
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE card_roles (
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  card_id             uuid NOT NULL,
  role_key            text NOT NULL REFERENCES roles (role_key),
  department_id       uuid,
  assigned_by_card_id uuid,
  assigned_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, card_id, role_key),
  FOREIGN KEY (tenant_id, card_id) REFERENCES cards (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)
);
ALTER TABLE card_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON card_roles
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT ON roles, permissions, role_permissions TO legacyai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON card_roles TO legacyai_app;

-- ---------------------------------------------------------------- seed: roles
INSERT INTO roles (role_key, display_name, rank, pilot_enabled) VALUES
  ('company_owner',      'Company Owner',      100, true),
  ('admin',              'Admin',               80, true),
  ('department_manager', 'Department Manager',  60, false),
  ('auditor',            'Auditor',             50, false),
  ('reviewer',           'Reviewer',            40, false),
  ('expert',             'Expert',              30, true),
  ('successor',          'Successor / Learner', 20, true),
  ('contractor',         'Contractor / Guest',  10, false);

-- ---------------------------------------------------------------- seed: permissions
INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('tenant:create',            'Create a new customer tenant',                    true,  true),
  ('tenant:list',              'List all tenants',                                false, true),
  ('tenant:read',              'Read own tenant',                                 false, false),
  ('tenant_settings:read',     'Read tenant settings',                            false, false),
  ('tenant_settings:update',   'Change tenant settings',                          true,  false),
  ('tenant_usage:read',        'Read tenant usage counts',                        false, false),
  ('person:create',            'Create a person',                                 true,  false),
  ('person:read',              'Read people',                                     false, false),
  ('person:update',            'Update a person (including offboarding)',         true,  false),
  ('department:create',        'Create a department',                             true,  false),
  ('department:read',          'List departments',                                false, false),
  ('card:issue',               'Issue a card',                                    true,  false),
  ('card:read',                'Read a card',                                     false, false),
  ('card:list',                'List cards',                                      false, false),
  ('card:suspend',             'Suspend a card',                                  true,  false),
  ('card:reinstate',           'Reinstate a suspended card',                      true,  false),
  ('card:revoke',              'Revoke a card permanently',                       true,  false),
  ('card:replace',             'Replace a card with a new number and code',       true,  false),
  ('card:renew',               'Renew a card and rotate its secret code',         true,  false),
  ('card:unlock',              'Unlock a locked card and rotate its secret code', true,  false),
  ('card:reset_credentials',   'Issue an enrollment token for a card',            true,  false),
  ('card_events:read',         'Read a card''s usage history',                    false, false),
  ('card_restrictions:read',   'Read a card''s restrictions',                     false, false),
  ('card_restrictions:update', 'Change a card''s restrictions',                   true,  false),
  ('role:read',                'List roles',                                      false, false),
  ('card_roles:read',          'Read a card''s roles',                            false, false),
  ('card_roles:assign',        'Assign a role to a card',                         true,  false),
  ('card_roles:remove',        'Remove a role from a card',                       true,  false),
  ('audit:read',               'Read the audit log',                              false, false),
  ('audit:verify',             'Verify the audit hash chain',                     false, false),
  ('export:create',            'Start a tenant data export',                      true,  false),
  ('export:read',              'Read a tenant data export',                       false, false),
  ('self:read',                'Read own session and own strong factors',         false, false),
  ('self:logout',              'End own session',                                 false, false),
  ('self:credential_remove',   'Remove one of own strong factors',                true,  false),
  ('knowledge:read',           'Read knowledge items (Phase 2 placeholder)',      false, false),
  ('knowledge:contribute',     'Contribute knowledge (Phase 2 placeholder)',      true,  false),
  ('knowledge:verify',         'Verify knowledge - Reviewer capability (Phase 2 placeholder)', true, false);

-- ---------------------------------------------------------------- seed: matrix
-- Every role: own session, role list, department list.
INSERT INTO role_permissions (role_key, permission_key, scope)
SELECT r.role_key, p, 'own'
FROM roles r, unnest(ARRAY['self:read', 'self:logout', 'self:credential_remove']) AS p;

INSERT INTO role_permissions (role_key, permission_key, scope)
SELECT r.role_key, p, 'tenant'
FROM roles r, unnest(ARRAY['role:read', 'department:read']) AS p;

-- Company Owner: everything in the tenant (and platform permissions, usable only in the platform tenant).
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity)
SELECT 'company_owner', p, 'tenant', 3 FROM unnest(ARRAY[
  'tenant:create', 'tenant:list', 'tenant:read', 'tenant_settings:read', 'tenant_settings:update', 'tenant_usage:read',
  'person:create', 'person:read', 'person:update', 'department:create',
  'card:issue', 'card:read', 'card:list', 'card:suspend', 'card:reinstate', 'card:revoke', 'card:replace',
  'card:renew', 'card:unlock', 'card:reset_credentials',
  'card_events:read', 'card_restrictions:read', 'card_restrictions:update',
  'card_roles:read', 'card_roles:assign', 'card_roles:remove',
  'audit:read', 'audit:verify', 'export:create', 'export:read', 'knowledge:read']) AS p;

-- Admin: users, cards, security. No settings changes, no export, no knowledge by default.
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity)
SELECT 'admin', p, 'tenant', 2 FROM unnest(ARRAY[
  'tenant:read', 'tenant_settings:read', 'tenant_usage:read',
  'person:create', 'person:read', 'person:update', 'department:create',
  'card:issue', 'card:read', 'card:list', 'card:suspend', 'card:reinstate', 'card:revoke', 'card:replace',
  'card:renew', 'card:unlock', 'card:reset_credentials',
  'card_events:read', 'card_restrictions:read', 'card_restrictions:update',
  'card_roles:read', 'card_roles:assign', 'card_roles:remove',
  'audit:read', 'audit:verify']) AS p;

-- Department Manager: their department only.
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity)
SELECT 'department_manager', p, 'department', 1 FROM unnest(ARRAY[
  'person:read', 'card:read', 'card:list', 'card_events:read', 'card_roles:read', 'knowledge:read']) AS p;

-- Auditor: read-only, tenant-wide. No knowledge.
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity)
SELECT 'auditor', p, 'tenant', 2 FROM unnest(ARRAY[
  'tenant:read', 'tenant_settings:read', 'tenant_usage:read', 'person:read',
  'card:read', 'card:list', 'card_events:read', 'card_restrictions:read', 'card_roles:read',
  'audit:read', 'audit:verify']) AS p;

-- Expert, Successor, Reviewer, Contractor: their own card and person.
INSERT INTO role_permissions (role_key, permission_key, scope)
SELECT r, p, 'own'
FROM unnest(ARRAY['expert', 'successor', 'reviewer', 'contractor']) AS r,
     unnest(ARRAY['person:read', 'card:read', 'card:list', 'card_events:read', 'card_roles:read']) AS p;

-- Knowledge placeholders (no endpoints in Phase 1).
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity) VALUES
  ('expert',     'knowledge:read',       'own',    1),
  ('expert',     'knowledge:contribute', 'own',    1),
  ('successor',  'knowledge:read',       'tenant', 0),
  ('reviewer',   'knowledge:read',       'tenant', 1),
  ('reviewer',   'knowledge:verify',     'tenant', 1),
  ('contractor', 'knowledge:read',       'own',    0);

-- Pilot: Reviewer capability temporarily granted to Admin and Expert.
-- These rows count only while tenant_settings.pilot_reviewer_grant is true.
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source) VALUES
  ('admin',  'knowledge:verify', 'tenant', 1, 'pilot_reviewer'),
  ('expert', 'knowledge:verify', 'tenant', 1, 'pilot_reviewer');

-- migrate:down
DROP TABLE card_roles;
DROP TABLE role_permissions;
DROP TABLE permissions;
DROP TABLE roles;
