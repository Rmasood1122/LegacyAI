// Table-driven tests of the policy decision point. `decide` is a pure function, so every
// row below is one (subject, action, resource, context) -> expected decision.
import { describe, expect, it } from 'vitest';
import {
  decide, usageKey, type Grant, type Matrix, type PermissionDef, type PolicyContext, type Restriction,
} from '../../src/modules/identity-access/index.ts';
import type { ResourceRef, RoleKey, Subject, SubjectRole } from '../../src/shared/policy-types.ts';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEPT_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEPT_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 86_400_000;

const perms: PermissionDef[] = [
  { permission_key: 'card:read', is_write: false, platform_only: false },
  { permission_key: 'card:list', is_write: false, platform_only: false },
  { permission_key: 'card:issue', is_write: true, platform_only: false },
  { permission_key: 'card:suspend', is_write: true, platform_only: false },
  { permission_key: 'card_roles:assign', is_write: true, platform_only: false },
  { permission_key: 'export:create', is_write: true, platform_only: false },
  { permission_key: 'export:read', is_write: false, platform_only: false },
  { permission_key: 'self:read', is_write: false, platform_only: false },
  { permission_key: 'self:logout', is_write: false, platform_only: false },
  { permission_key: 'tenant:create', is_write: true, platform_only: true },
  { permission_key: 'knowledge:read', is_write: false, platform_only: false },
  { permission_key: 'knowledge:verify', is_write: true, platform_only: false },
];
const g = (role_key: RoleKey, permission_key: string, scope: Grant['scope'], max_sensitivity = 0, grant_source: Grant['grant_source'] = 'base'): Grant =>
  ({ role_key, permission_key, scope, max_sensitivity, grant_source });
const grants: Grant[] = [
  ...['card:read', 'card:list', 'card:issue', 'card:suspend', 'card_roles:assign', 'export:create', 'export:read', 'tenant:create'].map((p) => g('company_owner', p, 'tenant', 3)),
  ...['card:read', 'card:list', 'card:issue', 'card:suspend', 'card_roles:assign'].map((p) => g('admin', p, 'tenant', 2)),
  g('department_manager', 'card:read', 'department', 1), g('department_manager', 'card:list', 'department', 1),
  g('department_manager', 'knowledge:read', 'department', 1),
  g('expert', 'card:read', 'own'), g('expert', 'card:list', 'own'), g('expert', 'knowledge:read', 'own', 1),
  g('reviewer', 'knowledge:verify', 'tenant', 1),
  g('admin', 'knowledge:verify', 'tenant', 1, 'pilot_reviewer'),
  g('expert', 'knowledge:verify', 'tenant', 1, 'pilot_reviewer'),
  ...(['company_owner', 'admin', 'department_manager', 'expert', 'reviewer', 'successor'] as RoleKey[]).flatMap((r) => [g(r, 'self:read', 'own'), g(r, 'self:logout', 'own')]),
];
const matrix: Matrix = { permissions: new Map(perms.map((p) => [p.permission_key, p])), grants };

const RANK: Record<string, number> = { company_owner: 100, admin: 80, department_manager: 60, reviewer: 40, expert: 30, successor: 20 };
const role = (role_key: RoleKey, department_id: string | null = null): SubjectRole => ({ role_key, department_id, rank: RANK[role_key] ?? 0 });

function subject(roles: SubjectRole[], over: Partial<Subject> = {}): Subject {
  return {
    kind: 'card', tenant_id: T1, card_id: CARD, card_number: '0000000000000000', person_id: PERSON, department_id: null,
    card_state: 'active', activated_at: new Date(NOW.getTime() - 10 * DAY), expires_at: new Date(NOW.getTime() + 30 * DAY),
    grace_until: new Date(NOW.getTime() + 44 * DAY), renewal_due: new Date(NOW.getTime() + 16 * DAY), locked: false, roles,
    is_platform_tenant: false, session_id: 's', session_idle_expires_at: NOW, session_absolute_expires_at: NOW, ...over,
  };
}
function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: NOW, ip: '10.0.0.5', tenant: { status: 'active' },
    settings: { enabled_roles: ['company_owner', 'admin', 'expert', 'successor'], pilot_reviewer_grant: true },
    matrix, companyCard: null, restrictions: [], usage: new Map(), planAllows: true, ...over,
  };
}
const res = (over: Partial<ResourceRef> = {}): ResourceRef => ({ type: 'card', id: OTHER_CARD, tenant_id: T1, owner_card_id: OTHER_CARD, ...over });
const allRoles = (): PolicyContext['settings'] => ({ enabled_roles: ['company_owner', 'admin', 'department_manager', 'expert', 'successor', 'reviewer'], pilot_reviewer_grant: true });

interface Row {
  name: string;
  s: Subject;
  action: string;
  r: ResourceRef;
  c?: PolicyContext;
  effect: 'allow' | 'deny';
  reason: string;
  obligations?: string[];
}

const expired = { expires_at: new Date(NOW.getTime() - DAY), grace_until: new Date(NOW.getTime() + 13 * DAY) };
const lapsed = { expires_at: new Date(NOW.getTime() - 20 * DAY), grace_until: new Date(NOW.getTime() - 6 * DAY) };
const restriction = (type: string, config: Record<string, unknown>, enabled = true): Restriction => ({ type, config, enabled });

const rows: Row[] = [
  // ---- deny by default
  { name: 'no roles at all', s: subject([]), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_DEFAULT' },
  { name: 'role without the permission', s: subject([role('successor')]), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_DEFAULT' },
  { name: 'unknown action', s: subject([role('company_owner')]), action: 'card:teleport', r: res(), effect: 'deny', reason: 'DENY_UNKNOWN_ACTION' },
  { name: 'empty action', s: subject([role('company_owner')]), action: '', r: res(), effect: 'deny', reason: 'DENY_UNKNOWN_ACTION' },
  { name: 'subject is not a card', s: { ...subject([role('company_owner')]), kind: 'robot' as never }, action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_UNAUTHENTICATED' },

  // ---- matrix + tenant
  { name: 'owner reads any card in the tenant', s: subject([role('company_owner')]), action: 'card:read', r: res(), effect: 'allow', reason: 'ALLOW' },
  { name: 'admin suspends another card', s: subject([role('admin')]), action: 'card:suspend', r: res({ target_rank: 30 }), effect: 'allow', reason: 'ALLOW' },
  { name: 'cross-tenant resource', s: subject([role('company_owner')]), action: 'card:read', r: res({ tenant_id: T2 }), effect: 'deny', reason: 'DENY_TENANT_MISMATCH' },
  { name: 'resource without a tenant', s: subject([role('company_owner')]), action: 'card:read', r: res({ tenant_id: undefined as never }), effect: 'deny', reason: 'DENY_TENANT_MISMATCH' },
  { name: 'tenant suspended', s: subject([role('company_owner')]), action: 'card:read', r: res(), c: ctx({ tenant: { status: 'suspended' } }), effect: 'deny', reason: 'DENY_TENANT_INACTIVE' },
  { name: 'platform-only permission outside the platform tenant', s: subject([role('company_owner')]), action: 'tenant:create', r: res({ type: 'tenant', collection: true }), effect: 'deny', reason: 'DENY_PLATFORM_ONLY' },
  { name: 'platform-only permission inside the platform tenant', s: subject([role('company_owner')], { is_platform_tenant: true }), action: 'tenant:create', r: res({ type: 'tenant', collection: true }), effect: 'allow', reason: 'ALLOW' },

  // ---- roles disabled for the tenant
  { name: 'disabled role is ignored', s: subject([role('department_manager', DEPT_A)]), action: 'card:read', r: res({ department_id: DEPT_A }), effect: 'deny', reason: 'DENY_DEFAULT' },
  { name: 'same role once enabled', s: subject([role('department_manager', DEPT_A)]), action: 'card:read', r: res({ department_id: DEPT_A }), c: ctx({ settings: allRoles() }), effect: 'allow', reason: 'ALLOW' },

  // ---- pilot reviewer grant
  { name: 'pilot: admin may verify knowledge', s: subject([role('admin')]), action: 'knowledge:verify', r: res({ type: 'knowledge', sensitivity: 1 }), effect: 'allow', reason: 'ALLOW' },
  { name: 'pilot: expert may verify knowledge', s: subject([role('expert')]), action: 'knowledge:verify', r: res({ type: 'knowledge', sensitivity: 1 }), effect: 'allow', reason: 'ALLOW' },
  { name: 'pilot grant switched off', s: subject([role('admin')]), action: 'knowledge:verify', r: res({ type: 'knowledge' }), c: ctx({ settings: { enabled_roles: ['admin'], pilot_reviewer_grant: false } }), effect: 'deny', reason: 'DENY_DEFAULT' },

  // ---- scope
  { name: 'own scope: own card', s: subject([role('expert')]), action: 'card:read', r: res({ id: CARD, owner_card_id: CARD }), effect: 'allow', reason: 'ALLOW' },
  { name: 'own scope: own person', s: subject([role('expert')]), action: 'card:read', r: res({ owner_card_id: null, owner_person_id: PERSON }), effect: 'allow', reason: 'ALLOW' },
  { name: 'own scope: someone else', s: subject([role('expert')]), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_SCOPE' },
  { name: 'own scope: resource with no owner', s: subject([role('expert')]), action: 'card:read', r: res({ owner_card_id: undefined }), effect: 'deny', reason: 'DENY_SCOPE' },
  { name: 'department scope: same department', s: subject([role('department_manager', DEPT_A)]), action: 'card:read', r: res({ department_id: DEPT_A }), c: ctx({ settings: allRoles() }), effect: 'allow', reason: 'ALLOW' },
  { name: 'department scope: other department', s: subject([role('department_manager', DEPT_A)]), action: 'card:read', r: res({ department_id: DEPT_B }), c: ctx({ settings: allRoles() }), effect: 'deny', reason: 'DENY_SCOPE' },
  { name: 'department scope: role has no department', s: subject([role('department_manager', null)]), action: 'card:read', r: res({ department_id: null }), c: ctx({ settings: allRoles() }), effect: 'deny', reason: 'DENY_SCOPE' },
  { name: 'listing with only an own-scope grant: allowed but must filter', s: subject([role('expert')]), action: 'card:list', r: res({ id: undefined, collection: true }), effect: 'allow', reason: 'ALLOW', obligations: ['filter'] },
  { name: 'listing with a tenant grant: no filter needed', s: subject([role('admin')]), action: 'card:list', r: res({ id: undefined, collection: true }), effect: 'allow', reason: 'ALLOW', obligations: [] },
  { name: 'creating needs a tenant-wide grant', s: subject([role('admin')]), action: 'card:issue', r: res({ id: undefined, collection: true, role_rank: 30 }), effect: 'allow', reason: 'ALLOW' },

  // ---- sensitivity
  { name: 'sensitivity within the grant', s: subject([role('admin')]), action: 'card:read', r: res({ sensitivity: 2 }), effect: 'allow', reason: 'ALLOW' },
  { name: 'sensitivity above the grant', s: subject([role('admin')]), action: 'card:read', r: res({ sensitivity: 3 }), effect: 'deny', reason: 'DENY_SENSITIVITY' },
  { name: 'sensitivity NaN', s: subject([role('company_owner')]), action: 'card:read', r: res({ sensitivity: Number.NaN }), effect: 'deny', reason: 'DENY_SENSITIVITY' },
  { name: 'sensitivity negative', s: subject([role('company_owner')]), action: 'card:read', r: res({ sensitivity: -1 }), effect: 'deny', reason: 'DENY_SENSITIVITY' },
  { name: 'sensitivity as a string', s: subject([role('company_owner')]), action: 'card:read', r: res({ sensitivity: '1' as never }), effect: 'deny', reason: 'DENY_SENSITIVITY' },

  // ---- card state
  { name: 'suspended card', s: subject([role('company_owner')], { card_state: 'suspended' }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_STATE' },
  { name: 'revoked card', s: subject([role('company_owner')], { card_state: 'revoked' }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_STATE' },
  { name: 'replaced card', s: subject([role('company_owner')], { card_state: 'replaced' }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_STATE' },
  { name: 'issued (never activated) card', s: subject([role('company_owner')], { card_state: 'issued', activated_at: null }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_STATE' },
  { name: 'locked card', s: subject([role('company_owner')], { locked: true }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_LOCKED' },
  { name: 'locked flag missing', s: subject([role('company_owner')], { locked: undefined as never }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_LOCKED' },

  // ---- expiry and grace
  { name: 'grace: reads still work, flagged read-only', s: subject([role('admin')], expired), action: 'card:read', r: res(), effect: 'allow', reason: 'ALLOW', obligations: ['read_only'] },
  { name: 'grace: writes are denied', s: subject([role('admin')], expired), action: 'card:suspend', r: res(), effect: 'deny', reason: 'DENY_GRACE_READ_ONLY' },
  { name: 'grace: export is still allowed', s: subject([role('company_owner')], expired), action: 'export:create', r: res({ type: 'export', id: undefined, collection: true }), effect: 'allow', reason: 'ALLOW', obligations: ['read_only'] },
  { name: 'after grace: non-owner is denied everything', s: subject([role('admin')], lapsed), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_EXPIRED' },
  { name: 'after grace: owner may still export', s: subject([role('company_owner')], lapsed), action: 'export:create', r: res({ type: 'export', id: undefined, collection: true }), effect: 'allow', reason: 'ALLOW', obligations: ['export_only'] },
  { name: 'after grace: owner may not read cards', s: subject([role('company_owner')], lapsed), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_EXPIRED' },
  { name: 'stored state expired counts even if dates look fine', s: subject([role('admin')], { card_state: 'expired' }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_EXPIRED' },
  { name: 'invalid expiry date fails closed', s: subject([role('admin')], { expires_at: new Date(Number.NaN) }), action: 'card:read', r: res(), effect: 'deny', reason: 'DENY_CARD_EXPIRED' },
  { name: 'company card in grace: whole tenant is read-only', s: subject([role('admin')]), action: 'card:suspend', r: res(), c: ctx({ companyCard: { state: 'active', ...expired } }), effect: 'deny', reason: 'DENY_TENANT_GRACE_READ_ONLY' },
  { name: 'company card in grace: reads continue', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ companyCard: { state: 'active', ...expired } }), effect: 'allow', reason: 'ALLOW', obligations: ['read_only'] },
  { name: 'company card lapsed: non-owner denied', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ companyCard: { state: 'active', ...lapsed } }), effect: 'deny', reason: 'DENY_TENANT_EXPIRED' },
  { name: 'company card lapsed: owner exports', s: subject([role('company_owner')]), action: 'export:create', r: res({ type: 'export', id: undefined, collection: true }), c: ctx({ companyCard: { state: 'active', ...lapsed } }), effect: 'allow', reason: 'ALLOW', obligations: ['export_only'] },
  { name: 'company card suspended', s: subject([role('company_owner')]), action: 'card:read', r: res(), c: ctx({ companyCard: { state: 'suspended', expires_at: NOW, grace_until: NOW } }), effect: 'deny', reason: 'DENY_TENANT_INACTIVE' },

  // ---- guard rules
  { name: 'cannot suspend own card', s: subject([role('company_owner')]), action: 'card:suspend', r: res({ id: CARD, owner_card_id: CARD }), effect: 'deny', reason: 'DENY_SELF_ACTION' },
  { name: 'cannot change own roles', s: subject([role('company_owner')]), action: 'card_roles:assign', r: res({ id: CARD, owner_card_id: CARD, role_rank: 30 }), effect: 'deny', reason: 'DENY_SELF_ACTION' },
  { name: 'admin cannot grant the owner role', s: subject([role('admin')]), action: 'card_roles:assign', r: res({ role_rank: 100, target_rank: 30 }), effect: 'deny', reason: 'DENY_RANK' },
  { name: 'admin cannot suspend an owner', s: subject([role('admin')]), action: 'card:suspend', r: res({ target_rank: 100 }), effect: 'deny', reason: 'DENY_RANK' },
  { name: 'admin may grant a role at its own rank', s: subject([role('admin')]), action: 'card_roles:assign', r: res({ role_rank: 80, target_rank: 30 }), effect: 'allow', reason: 'ALLOW' },
  { name: 'rank NaN fails closed', s: subject([role('company_owner')]), action: 'card:suspend', r: res({ target_rank: Number.NaN }), effect: 'deny', reason: 'DENY_RANK' },
  { name: 'unknown role (huge rank) is refused', s: subject([role('company_owner')]), action: 'card_roles:assign', r: res({ role_rank: Number.MAX_SAFE_INTEGER }), effect: 'deny', reason: 'DENY_RANK' },
  { name: 'cannot remove the last owner', s: subject([role('company_owner')]), action: 'card:suspend', r: res({ target_rank: 100, removes_last_owner: true }), effect: 'deny', reason: 'DENY_LAST_OWNER' },
  { name: 'last-owner flag of the wrong type fails closed', s: subject([role('company_owner')]), action: 'card:suspend', r: res({ target_rank: 100, removes_last_owner: 'no' as never }), effect: 'deny', reason: 'DENY_LAST_OWNER' },

  // ---- plan limit hook
  { name: 'plan limit reached', s: subject([role('company_owner')]), action: 'card:read', r: res(), c: ctx({ planAllows: false }), effect: 'deny', reason: 'DENY_PLAN_LIMIT' },
  { name: 'plan answer missing fails closed', s: subject([role('company_owner')]), action: 'card:read', r: res(), c: ctx({ planAllows: undefined as never }), effect: 'deny', reason: 'DENY_PLAN_LIMIT' },

  // ---- card restrictions (feature 5)
  { name: 'read-only card: read allowed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('read_only', {})] }), effect: 'allow', reason: 'ALLOW' },
  { name: 'read-only card: write denied', s: subject([role('admin')]), action: 'card:suspend', r: res(), c: ctx({ restrictions: [restriction('read_only', {})] }), effect: 'deny', reason: 'DENY_CARD_READ_ONLY' },
  { name: 'disabled restriction is ignored', s: subject([role('admin')]), action: 'card:suspend', r: res(), c: ctx({ restrictions: [restriction('read_only', {}, false)] }), effect: 'allow', reason: 'ALLOW' },
  // NOW is Monday 2026-06-01 12:00 UTC = 08:00 in New York.
  { name: 'business hours: inside the window', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('time_window', { timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' })] }), effect: 'allow', reason: 'ALLOW' },
  { name: 'business hours: outside the window (time zone applied)', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('time_window', { timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' })] }), effect: 'deny', reason: 'DENY_CARD_HOURS' },
  { name: 'business hours: wrong day', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('time_window', { timezone: 'UTC', days: [0, 6], start: '00:00', end: '23:59' })] }), effect: 'deny', reason: 'DENY_CARD_HOURS' },
  { name: 'business hours: unknown time zone fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('time_window', { timezone: 'Mars/Olympus', days: [1], start: '00:00', end: '23:59' })] }), effect: 'deny', reason: 'DENY_PDP_ERROR' },
  { name: 'business hours: malformed times fail closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('time_window', { timezone: 'UTC', days: [1], start: '9am', end: '5pm' })] }), effect: 'deny', reason: 'DENY_CARD_HOURS' },
  { name: 'one site only: address inside the range', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('network_allowlist', { cidrs: ['10.0.0.0/24'] })] }), effect: 'allow', reason: 'ALLOW' },
  { name: 'one site only: address outside the range', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ ip: '203.0.113.9', restrictions: [restriction('network_allowlist', { cidrs: ['10.0.0.0/24'] })] }), effect: 'deny', reason: 'DENY_CARD_NETWORK' },
  { name: 'one site only: IPv4-mapped IPv6 address is recognised', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ ip: '::ffff:10.0.0.5', restrictions: [restriction('network_allowlist', { cidrs: ['10.0.0.0/24'] })] }), effect: 'allow', reason: 'ALLOW' },
  { name: 'one site only: garbage address fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ ip: 'not-an-ip', restrictions: [restriction('network_allowlist', { cidrs: ['10.0.0.0/24'] })] }), effect: 'deny', reason: 'DENY_CARD_NETWORK' },
  { name: 'one site only: empty list fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('network_allowlist', { cidrs: [] })] }), effect: 'deny', reason: 'DENY_CARD_NETWORK' },
  { name: 'one site only: malformed range fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('network_allowlist', { cidrs: ['10.0.0.0/99'] })] }), effect: 'deny', reason: 'DENY_CARD_NETWORK' },
  { name: 'usage cap: under the cap -> allowed and counted', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('usage_cap', { limit_key: 'requests', window_seconds: 3600, max_count: 5 })], usage: new Map([[usageKey('requests', 3600), 4]]) }), effect: 'allow', reason: 'ALLOW', obligations: ['count_usage'] },
  { name: 'usage cap: at the cap -> denied', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('usage_cap', { limit_key: 'requests', window_seconds: 3600, max_count: 5 })], usage: new Map([[usageKey('requests', 3600), 5]]) }), effect: 'deny', reason: 'DENY_CARD_LIMIT' },
  { name: 'usage cap of zero denies immediately', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('usage_cap', { limit_key: 'requests', window_seconds: 3600, max_count: 0 })] }), effect: 'deny', reason: 'DENY_CARD_LIMIT' },
  { name: 'usage cap: NaN usage fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('usage_cap', { limit_key: 'requests', window_seconds: 3600, max_count: 5 })], usage: new Map([[usageKey('requests', 3600), Number.NaN]]) }), effect: 'deny', reason: 'DENY_CARD_LIMIT' },
  { name: 'usage cap on writes does not count reads', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('usage_cap', { limit_key: 'writes', window_seconds: 3600, max_count: 0 })] }), effect: 'allow', reason: 'ALLOW', obligations: [] },
  { name: 'usage cap with a malformed config fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('usage_cap', { limit_key: 'requests', window_seconds: 'hour', max_count: 5 })] }), effect: 'deny', reason: 'DENY_CARD_RESTRICTION_INVALID' },
  { name: 'unknown restriction type fails closed', s: subject([role('admin')]), action: 'card:read', r: res(), c: ctx({ restrictions: [restriction('moon_phase', {})] }), effect: 'deny', reason: 'DENY_CARD_RESTRICTION_INVALID' },
  { name: 'restrictions never block signing out', s: subject([role('admin')]), action: 'self:logout', r: res({ type: 'session', id: 's', owner_card_id: CARD }), c: ctx({ restrictions: [restriction('time_window', { timezone: 'UTC', days: [0], start: '00:00', end: '00:01' })] }), effect: 'allow', reason: 'ALLOW' },
];

describe('policy decision point (table-driven)', () => {
  it(`has ${rows.length} cases`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(80);
  });

  it.each(rows)('$name', (row) => {
    const d = decide(row.s, row.action, row.r, row.c ?? ctx());
    expect({ effect: d.effect, reason: d.reason_code }).toEqual({ effect: row.effect, reason: row.reason });
    if (row.obligations) expect(d.obligations.map((o) => o.type).sort()).toEqual([...row.obligations].sort());
    if (d.effect === 'deny') expect(d.obligations).toEqual([]);
  });
});

describe('deny by default is structural', () => {
  it('garbage inputs never produce an allow', () => {
    const good = subject([role('company_owner')]);
    const garbage: unknown[] = [null, undefined, 0, '', 'x', [], {}, Number.NaN, () => 1];
    for (const a of garbage) {
      for (const b of garbage) {
        expect(decide(a as never, 'card:read', b as never, ctx()).effect).toBe('deny');
        expect(decide(good, a as never, b as never, ctx()).effect).toBe('deny');
        expect(decide(good, 'card:read', res(), a as never).effect).toBe('deny');
      }
    }
  });

  it('an exception inside a rule becomes a denial, not a crash', () => {
    const exploding = new Proxy({} as PolicyContext, { get: () => { throw new Error('boom'); } });
    const d = decide(subject([role('company_owner')]), 'card:read', res(), exploding);
    expect(d).toEqual({ effect: 'deny', reason_code: 'DENY_PDP_ERROR', obligations: [] });
  });

  it('an empty matrix denies everything', () => {
    const empty = ctx({ matrix: { permissions: new Map(perms.map((p) => [p.permission_key, p])), grants: [] } });
    for (const p of perms) {
      expect(decide(subject([role('company_owner')], { is_platform_tenant: true }), p.permission_key, res({ collection: true }), empty).effect).toBe('deny');
    }
  });
});
