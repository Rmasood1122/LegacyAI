-- migrate:up

-- Phase 2 permissions and the role -> permission matrix (docs/phase2/03, "Permissions").
-- 'pilot_reviewer' rows count only while tenant_settings.pilot_reviewer_grant is on.

-- An Expert needs two rows for knowledge:read (own/1 base AND tenant/1 pilot): widen the key.
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_pkey;
ALTER TABLE role_permissions ADD PRIMARY KEY (role_key, permission_key, grant_source);

INSERT INTO permissions (permission_key, description, is_write, platform_only) VALUES
  ('knowledge:ask',             'Ask a question (results filtered by knowledge:read)',              false, false),
  ('knowledge:label',           'Change department / sensitivity, incl. release to learners',       true,  false),
  ('contribution:restrict',     'Make your own material less visible',                              true,  false),
  ('knowledge:revert',          'Reopen an item, or everything one card verified',                  true,  false),
  ('capture:upload',            'Upload a document',                                                true,  false),
  ('source:read',               'List and inspect documents (labels, status, counts)',              false, false),
  ('source:withdraw',           'Remove a document',                                                true,  false),
  ('source:confirm',            'Confirm a document is your contribution',                          true,  false),
  ('capture:interview',         'Be interviewed (own interview)',                                   true,  false),
  ('interview:read',            'Read interviews',                                                  false, false),
  ('interview:manage',          'Invite to and close interviews (status only, never the text)',     true,  false),
  ('consent:give',              'Give your own consent',                                            true,  false),
  ('consent:withdraw',          'Withdraw your own consent',                                        true,  false),
  ('consent:read',              'Read consents',                                                    false, false),
  ('consent:hold',              'Legal hold; record a withdrawal for someone who has left',         true,  false),
  ('topic:read',                'Read topics and role topic maps',                                  false, false),
  ('topic:manage',              'Manage topics, role topic maps and job roles',                     true,  false),
  ('gap:read',                  'Read the gap report',                                              false, false),
  ('review:read',               'Read the review queue',                                            false, false),
  ('review:resolve',            'Assign, dismiss and bulk-handle review tasks',                     true,  false),
  ('redaction:manage',          'Manage the redaction allow-list',                                  true,  false),
  ('expert_question:create',    'Send a question to an expert',                                     true,  false),
  ('expert_question:read',      'Read questions asked by or addressed to you',                      false, false),
  ('expert_question:answer',    'Reply to a question addressed to you',                             true,  false),
  ('quiz:read',                 'Read the readiness question bank',                                 false, false),
  ('quiz:manage',               'Generate, approve, edit and retire readiness questions',           true,  false),
  ('quiz:take',                 'Take a readiness test',                                            true,  false),
  ('quiz:grade',                'Override a readiness grade',                                       true,  false),
  ('quiz:read_results',         'Read readiness attempts and reports',                              false, false),
  ('knowledge_settings:read',   'Read the company knowledge settings',                              false, false),
  ('knowledge_settings:update', 'Change the company knowledge settings',                            true,  false),
  ('ai_budget:read',            'Read this month''s AI use and cap',                                false, false),
  ('ai_budget:manage',          'Platform operator: set a company''s AI cap',                       true,  true),
  ('ai_kill_switch:manage',     'Platform operator: stop all AI calls',                             true,  true),
  ('platform_storage:read',     'Platform operator: database size and per-company counts',          false, true);

INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source)
SELECT r, p, s, m, g FROM (VALUES
  -- knowledge:read (Owner tenant/3, Expert own/1, Successor tenant/0 ... exist since Phase 1)
  ('admin',              'knowledge:read',            'tenant',     1, 'pilot_reviewer'),
  ('expert',             'knowledge:read',            'tenant',     1, 'pilot_reviewer'),
  -- asking
  ('company_owner',      'knowledge:ask',             'tenant',     3, 'base'),
  ('admin',              'knowledge:ask',             'tenant',     3, 'base'),
  ('department_manager', 'knowledge:ask',             'tenant',     3, 'base'),
  ('reviewer',           'knowledge:ask',             'tenant',     3, 'base'),
  ('expert',             'knowledge:ask',             'tenant',     3, 'base'),
  ('successor',          'knowledge:ask',             'tenant',     3, 'base'),
  ('contractor',         'knowledge:ask',             'tenant',     3, 'base'),
  -- contributing, verifying, labelling
  ('admin',              'knowledge:contribute',      'tenant',     1, 'pilot_reviewer'),
  ('company_owner',      'knowledge:label',           'tenant',     3, 'base'),
  ('reviewer',           'knowledge:label',           'tenant',     1, 'base'),
  ('admin',              'knowledge:label',           'tenant',     1, 'pilot_reviewer'),
  ('expert',             'knowledge:label',           'tenant',     1, 'pilot_reviewer'),
  ('company_owner',      'knowledge:revert',          'tenant',     3, 'base'),
  -- documents
  ('company_owner',      'capture:upload',            'tenant',     3, 'base'),
  ('admin',              'capture:upload',            'tenant',     1, 'pilot_reviewer'),
  ('expert',             'capture:upload',            'own',        1, 'base'),
  ('company_owner',      'source:read',               'tenant',     3, 'base'),
  ('reviewer',           'source:read',               'tenant',     1, 'base'),
  ('department_manager', 'source:read',               'department', 1, 'base'),
  ('admin',              'source:read',               'tenant',     1, 'pilot_reviewer'),
  ('expert',             'source:read',               'own',        1, 'base'),
  ('company_owner',      'source:withdraw',           'tenant',     3, 'base'),
  ('admin',              'source:withdraw',           'tenant',     1, 'pilot_reviewer'),
  ('expert',             'source:withdraw',           'own',        1, 'base'),
  -- interviews
  ('expert',             'capture:interview',         'own',        1, 'base'),
  ('company_owner',      'interview:read',            'tenant',     3, 'base'),
  ('reviewer',           'interview:read',            'tenant',     1, 'base'),
  ('admin',              'interview:read',            'tenant',     1, 'pilot_reviewer'),
  ('expert',             'interview:read',            'own',        1, 'base'),
  ('company_owner',      'interview:manage',          'tenant',     3, 'base'),
  ('admin',              'interview:manage',          'tenant',     1, 'base'),
  -- consent
  ('company_owner',      'consent:read',              'tenant',     3, 'base'),
  ('admin',              'consent:read',              'tenant',     3, 'base'),
  ('auditor',            'consent:read',              'tenant',     3, 'base'),
  ('company_owner',      'consent:hold',              'tenant',     3, 'base'),
  -- topics, gaps
  ('company_owner',      'topic:read',                'tenant',     3, 'base'),
  ('admin',              'topic:read',                'tenant',     1, 'base'),
  ('reviewer',           'topic:read',                'tenant',     1, 'base'),
  ('department_manager', 'topic:read',                'department', 1, 'base'),
  ('expert',             'topic:read',                'tenant',     0, 'base'),
  ('successor',          'topic:read',                'tenant',     0, 'base'),
  ('contractor',         'topic:read',                'tenant',     0, 'base'),
  ('company_owner',      'topic:manage',              'tenant',     3, 'base'),
  ('admin',              'topic:manage',              'tenant',     1, 'base'),
  ('company_owner',      'gap:read',                  'tenant',     3, 'base'),
  ('admin',              'gap:read',                  'tenant',     1, 'base'),
  ('department_manager', 'gap:read',                  'department', 1, 'base'),
  -- review queue, redaction allow-list
  ('company_owner',      'review:read',               'tenant',     3, 'base'),
  ('reviewer',           'review:read',               'tenant',     1, 'base'),
  ('department_manager', 'review:read',               'department', 1, 'base'),
  ('admin',              'review:read',               'tenant',     1, 'pilot_reviewer'),
  ('expert',             'review:read',               'tenant',     1, 'pilot_reviewer'),
  ('reviewer',           'review:resolve',            'tenant',     1, 'base'),
  ('admin',              'review:resolve',            'tenant',     1, 'pilot_reviewer'),
  ('expert',             'review:resolve',            'tenant',     1, 'pilot_reviewer'),
  ('reviewer',           'redaction:manage',          'tenant',     1, 'base'),
  ('admin',              'redaction:manage',          'tenant',     1, 'pilot_reviewer'),
  ('expert',             'redaction:manage',          'tenant',     1, 'pilot_reviewer'),
  -- expert questions
  ('company_owner',      'expert_question:create',    'tenant',     3, 'base'),
  ('admin',              'expert_question:create',    'tenant',     3, 'base'),
  ('expert',             'expert_question:create',    'tenant',     3, 'base'),
  ('successor',          'expert_question:create',    'tenant',     3, 'base'),
  ('company_owner',      'expert_question:read',      'tenant',     3, 'base'),
  ('expert',             'expert_question:read',      'own',        3, 'base'),
  ('successor',          'expert_question:read',      'own',        3, 'base'),
  ('expert',             'expert_question:answer',    'own',        3, 'base'),
  -- readiness tests
  ('company_owner',      'quiz:read',                 'tenant',     3, 'base'),
  ('reviewer',           'quiz:read',                 'tenant',     1, 'base'),
  ('admin',              'quiz:read',                 'tenant',     1, 'pilot_reviewer'),
  ('expert',             'quiz:read',                 'tenant',     1, 'pilot_reviewer'),
  ('reviewer',           'quiz:manage',               'tenant',     1, 'base'),
  ('admin',              'quiz:manage',               'tenant',     1, 'pilot_reviewer'),
  ('expert',             'quiz:manage',               'tenant',     1, 'pilot_reviewer'),
  ('successor',          'quiz:take',                 'tenant',     0, 'base'),
  ('reviewer',           'quiz:grade',                'tenant',     1, 'base'),
  ('admin',              'quiz:grade',                'tenant',     1, 'pilot_reviewer'),
  ('expert',             'quiz:grade',                'tenant',     1, 'pilot_reviewer'),
  ('company_owner',      'quiz:read_results',         'tenant',     3, 'base'),
  ('admin',              'quiz:read_results',         'tenant',     3, 'base'),
  ('successor',          'quiz:read_results',         'own',        3, 'base'),
  -- settings and AI budget
  ('company_owner',      'knowledge_settings:read',   'tenant',     3, 'base'),
  ('admin',              'knowledge_settings:read',   'tenant',     3, 'base'),
  ('company_owner',      'knowledge_settings:update', 'tenant',     3, 'base'),
  ('company_owner',      'ai_budget:read',            'tenant',     3, 'base'),
  ('admin',              'ai_budget:read',            'tenant',     3, 'base'),
  ('auditor',            'ai_budget:read',            'tenant',     3, 'base'),
  -- platform operator (company_owner of the operator tenant; platform_only permissions)
  ('company_owner',      'ai_budget:manage',          'tenant',     3, 'base'),
  ('company_owner',      'ai_kill_switch:manage',     'tenant',     3, 'base'),
  ('company_owner',      'platform_storage:read',     'tenant',     3, 'base')
) AS v (r, p, s, m, g);

-- Rights over your OWN things, for every role: give / withdraw consent, confirm a document is yours,
-- read your consents, restrict your own material.
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source)
SELECT r.role_key, p, 'own', 3, 'base'
  FROM roles r, unnest(ARRAY['consent:give', 'consent:withdraw', 'source:confirm', 'contribution:restrict']) AS p;
INSERT INTO role_permissions (role_key, permission_key, scope, max_sensitivity, grant_source)
SELECT r.role_key, 'consent:read', 'own', 3, 'base' FROM roles r
 WHERE r.role_key NOT IN ('company_owner', 'admin', 'auditor');

-- migrate:down
DELETE FROM role_permissions WHERE permission_key IN (
  'knowledge:ask', 'knowledge:label', 'contribution:restrict', 'knowledge:revert', 'capture:upload', 'source:read',
  'source:withdraw', 'source:confirm', 'capture:interview', 'interview:read', 'interview:manage', 'consent:give',
  'consent:withdraw', 'consent:read', 'consent:hold', 'topic:read', 'topic:manage', 'gap:read', 'review:read',
  'review:resolve', 'redaction:manage', 'expert_question:create', 'expert_question:read', 'expert_question:answer',
  'quiz:read', 'quiz:manage', 'quiz:take', 'quiz:grade', 'quiz:read_results', 'knowledge_settings:read',
  'knowledge_settings:update', 'ai_budget:read', 'ai_budget:manage', 'ai_kill_switch:manage', 'platform_storage:read');
DELETE FROM role_permissions WHERE (role_key, permission_key, grant_source) IN (
  ('admin', 'knowledge:read', 'pilot_reviewer'), ('expert', 'knowledge:read', 'pilot_reviewer'),
  ('admin', 'knowledge:contribute', 'pilot_reviewer'));
DELETE FROM permissions WHERE permission_key IN (
  'knowledge:ask', 'knowledge:label', 'contribution:restrict', 'knowledge:revert', 'capture:upload', 'source:read',
  'source:withdraw', 'source:confirm', 'capture:interview', 'interview:read', 'interview:manage', 'consent:give',
  'consent:withdraw', 'consent:read', 'consent:hold', 'topic:read', 'topic:manage', 'gap:read', 'review:read',
  'review:resolve', 'redaction:manage', 'expert_question:create', 'expert_question:read', 'expert_question:answer',
  'quiz:read', 'quiz:manage', 'quiz:take', 'quiz:grade', 'quiz:read_results', 'knowledge_settings:read',
  'knowledge_settings:update', 'ai_budget:read', 'ai_budget:manage', 'ai_kill_switch:manage', 'platform_storage:read');
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_pkey;
ALTER TABLE role_permissions ADD PRIMARY KEY (role_key, permission_key);
