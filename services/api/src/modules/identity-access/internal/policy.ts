// The policy decision point (PDP).
//
//   decide(subject, action, resource, context) -> { effect, reason_code, obligations }
//
// DENY BY DEFAULT: every path that does not reach the final line returns a denial, and any
// exception inside the function is turned into a denial. `decide` is a pure function of its
// inputs (no database, no clock of its own), which is what makes it table-testable.
//
// Policy is data: the role -> permission matrix comes from the database; the state, grace
// and guard rules are the small declarative tables below.
import { BlockList, isIP } from 'node:net';
import type { CardState, Decision, Obligation, ResourceRef, RoleKey, Subject } from '../../../shared/policy-types.ts';
import { accessPhase, type AccessPhase } from './lifecycle.ts';

// ------------------------------------------------------------------ policy data

export interface PermissionDef {
  permission_key: string;
  is_write: boolean;
  platform_only: boolean;
}

export interface Grant {
  role_key: RoleKey;
  permission_key: string;
  scope: 'tenant' | 'department' | 'own';
  max_sensitivity: number;
  grant_source: 'base' | 'pilot_reviewer';
}

export interface Matrix {
  permissions: ReadonlyMap<string, PermissionDef>;
  grants: readonly Grant[];
}

export interface Restriction {
  type: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PolicyContext {
  now: Date;
  ip: string;
  tenant: { status: string };
  settings: { enabled_roles: readonly RoleKey[]; pilot_reviewer_grant: boolean };
  matrix: Matrix;
  /** The tenant's live company card: its expiry puts the whole tenant into grace / lapsed. */
  companyCard: { state: CardState; expires_at: Date; grace_until: Date } | null;
  restrictions: readonly Restriction[];
  /** Current-window usage, keyed by usageKey(limit_key, window_seconds). */
  usage: ReadonlyMap<string, number>;
  /** Answer from the billing module's plan-limit hook. */
  planAllows: boolean;
}

/** Writes that stay possible during the read-only grace window. "Data export is always free." */
const GRACE_EXEMPT_WRITES: ReadonlySet<string> = new Set(['export:create']);
/** The only things a Company Owner can still do after the grace window has ended. */
const LAPSED_ALLOWED: ReadonlySet<string> = new Set(['export:create', 'export:read', 'self:read', 'self:logout']);
/** Nobody may do these to their own card. */
const SELF_FORBIDDEN: ReadonlySet<string> = new Set([
  'card:suspend', 'card:revoke', 'card:replace', 'card:unlock', 'card:reset_credentials',
  'card_restrictions:update', 'card_roles:assign', 'card_roles:remove', 'person:update',
]);
/**
 * Actions that hand the actor a way INTO the target card (a new SC, a new enrollment token,
 * a new card). For these the actor must rank strictly ABOVE the target - an Admin cannot do
 * them to another Admin (or to itself) - unless the actor is a Company Owner.
 */
const TAKEOVER_CAPABLE: ReadonlySet<string> = new Set(['card:renew', 'card:unlock', 'card:reset_credentials', 'card:replace']);
/** The company card is the tenant's identity and subscription clock. Only renewal (by an Owner) is possible. */
const COMPANY_CARD_FORBIDDEN: ReadonlySet<string> = new Set([
  'card:suspend', 'card:reinstate', 'card:revoke', 'card:replace', 'card:unlock', 'card:reset_credentials',
  'card_restrictions:update', 'card_roles:assign', 'card_roles:remove',
]);
/** Actions on a card that require the actor to rank at least as high as the target and the role involved. */
const RANK_GUARDED: ReadonlySet<string> = new Set([
  'card:suspend', 'card:reinstate', 'card:revoke', 'card:replace', 'card:renew', 'card:unlock',
  'card:reset_credentials', 'card_restrictions:update', 'card_roles:assign', 'card_roles:remove', 'card:issue',
  'person:update',
]);
/** Card restrictions never stop someone from signing out. */
const RESTRICTION_EXEMPT: ReadonlySet<string> = new Set(['self:logout']);

export function usageKey(limitKey: string, windowSeconds: number): string {
  return `${limitKey}:${windowSeconds}`;
}

const deny = (reason_code: string): Decision => ({ effect: 'deny', reason_code, obligations: [] });

// ------------------------------------------------------------- subject-level rules

interface SubjectEvaluation {
  permission: PermissionDef;
  /** Grants that apply to this subject for this action, each with the department of the role that carries it. */
  grants: Array<Grant & { role_department_id: string | null }>;
  obligations: Obligation[];
  subjectRank: number;
  isOwner: boolean;
}

function worstPhase(a: AccessPhase, b: AccessPhase): AccessPhase {
  const order: AccessPhase[] = ['normal', 'grace', 'lapsed'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))] as AccessPhase;
}

/** Steps that depend only on who is asking and what action - shared by decide() and buildResourceFilter(). */
function evaluateSubject(subject: Subject, action: string, ctx: PolicyContext): Decision | SubjectEvaluation {
  if (subject === null || typeof subject !== 'object' || subject.kind !== 'card') return deny('DENY_UNAUTHENTICATED');
  const permission = typeof action === 'string' ? ctx.matrix.permissions.get(action) : undefined;
  if (!permission) return deny('DENY_UNKNOWN_ACTION');

  if (ctx.tenant.status !== 'active') return deny('DENY_TENANT_INACTIVE');

  // Card state. Only a card that was activated and is active (or expired, see below) may act.
  if (subject.locked !== false) return deny('DENY_CARD_LOCKED');
  if (subject.activated_at === null) return deny('DENY_CARD_STATE');
  if (subject.card_state !== 'active' && subject.card_state !== 'expired') return deny('DENY_CARD_STATE');

  // Expiry and the read-only grace window. This is the ONLY place they are enforced.
  let cardPhase = accessPhase(subject, ctx.now);
  if (subject.card_state === 'expired' && cardPhase === 'normal') cardPhase = 'lapsed'; // inconsistent data: be strict
  let tenantPhase: AccessPhase = 'normal';
  if (ctx.companyCard) {
    if (ctx.companyCard.state !== 'active' && ctx.companyCard.state !== 'expired') return deny('DENY_TENANT_INACTIVE');
    tenantPhase = accessPhase(ctx.companyCard, ctx.now);
    if (ctx.companyCard.state === 'expired' && tenantPhase === 'normal') tenantPhase = 'lapsed';
  } else if (subject.is_platform_tenant !== true) {
    // A customer tenant with NO live company card has no valid subscription clock: treat it as
    // lapsed (fail closed) rather than as "never expires". Only the operator tenant has no company card.
    tenantPhase = 'lapsed';
  }
  const phase = worstPhase(cardPhase, tenantPhase);
  const tenantCaused = tenantPhase === phase && cardPhase !== phase;

  const enabled = new Set<string>(ctx.settings.enabled_roles);
  const roles = subject.roles.filter((r) => enabled.has(r.role_key));
  const obligations: Obligation[] = [];

  if (phase === 'grace') {
    if (permission.is_write && !GRACE_EXEMPT_WRITES.has(action)) {
      return deny(tenantCaused ? 'DENY_TENANT_GRACE_READ_ONLY' : 'DENY_GRACE_READ_ONLY');
    }
    obligations.push({ type: 'read_only' });
  } else if (phase === 'lapsed') {
    const isOwner = roles.some((r) => r.role_key === 'company_owner');
    if (!isOwner || !LAPSED_ALLOWED.has(action)) return deny(tenantCaused ? 'DENY_TENANT_EXPIRED' : 'DENY_CARD_EXPIRED');
    obligations.push({ type: 'export_only' });
  }

  // The role -> permission matrix.
  if (permission.platform_only && subject.is_platform_tenant !== true) return deny('DENY_PLATFORM_ONLY');
  const grants: SubjectEvaluation['grants'] = [];
  for (const role of roles) {
    for (const g of ctx.matrix.grants) {
      if (g.role_key !== role.role_key || g.permission_key !== action) continue;
      if (g.grant_source === 'pilot_reviewer' && ctx.settings.pilot_reviewer_grant !== true) continue;
      grants.push({ ...g, role_department_id: role.department_id });
    }
  }
  if (grants.length === 0) return deny('DENY_DEFAULT');

  const subjectRank = roles.reduce((max, r) => (Number.isFinite(r.rank) && r.rank > max ? r.rank : max), 0);
  return { permission, grants, obligations, subjectRank, isOwner: roles.some((r) => r.role_key === 'company_owner') };
}

// ---------------------------------------------------------------- card restrictions

function minutesOfDay(hhmm: unknown): number | null {
  if (typeof hhmm !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hhmm)) return null;
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function withinTimeWindow(config: Record<string, unknown>, now: Date): boolean {
  const start = minutesOfDay(config.start);
  const end = minutesOfDay(config.end);
  const days = config.days;
  if (start === null || end === null || !Array.isArray(days) || typeof config.timezone !== 'string') return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now); // throws RangeError for an unknown time zone -> caught by decide() -> deny
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = WEEKDAYS.indexOf(get('weekday'));
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  if (day < 0 || !Number.isFinite(minutes) || !days.includes(day)) return false;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function networkAllowed(config: Record<string, unknown>, ip: string): boolean {
  if (!Array.isArray(config.cidrs) || config.cidrs.length === 0) return false;
  const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(address);
  if (family === 0) return false;
  const list = new BlockList();
  for (const cidr of config.cidrs) {
    if (typeof cidr !== 'string') return false;
    const [net, prefixText] = cidr.split('/');
    const netFamily = isIP(net ?? '');
    if (prefixText !== undefined && !/^[0-9]{1,3}$/.test(prefixText)) return false; // "10.0.0.0/" must not mean "/0"
    const prefix = prefixText === undefined ? (netFamily === 4 ? 32 : 128) : Number(prefixText);
    if (netFamily === 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > (netFamily === 4 ? 32 : 128)) return false;
    list.addSubnet(net as string, prefix, netFamily === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Returns a denial, or the usage obligations to honour. Malformed restrictions deny (fail closed). */
function checkRestrictions(action: string, permission: PermissionDef, ctx: PolicyContext): Decision | Obligation[] {
  const obligations: Obligation[] = [];
  if (RESTRICTION_EXEMPT.has(action)) return obligations;
  for (const r of ctx.restrictions) {
    if (r.enabled !== true) continue;
    const config = r.config ?? {};
    switch (r.type) {
      case 'read_only':
        if (permission.is_write) return deny('DENY_CARD_READ_ONLY');
        break;
      case 'time_window':
        if (!withinTimeWindow(config, ctx.now)) return deny('DENY_CARD_HOURS');
        break;
      case 'network_allowlist':
        if (!networkAllowed(config, ctx.ip)) return deny('DENY_CARD_NETWORK');
        break;
      case 'usage_cap': {
        const { limit_key: limitKey, window_seconds: windowSeconds, max_count: maxCount } = config;
        if (
          typeof limitKey !== 'string' || !Number.isInteger(windowSeconds) || (windowSeconds as number) < 1 ||
          !Number.isInteger(maxCount) || (maxCount as number) < 0
        ) {
          return deny('DENY_CARD_RESTRICTION_INVALID');
        }
        const applies =
          limitKey === 'requests' || (limitKey === 'writes' && permission.is_write) || (limitKey === 'exports' && action === 'export:create');
        if (!applies) break;
        const used = ctx.usage.get(usageKey(limitKey, windowSeconds as number)) ?? 0;
        if (!Number.isFinite(used) || used >= (maxCount as number)) return deny('DENY_CARD_LIMIT');
        obligations.push({ type: 'count_usage', limit_key: limitKey, window_seconds: windowSeconds as number });
        break;
      }
      default:
        return deny('DENY_CARD_RESTRICTION_INVALID');
    }
  }
  return obligations;
}

// ------------------------------------------------------------------------ decide

function validSensitivity(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
}

function decideUnsafe(subject: Subject, action: string, resource: ResourceRef, ctx: PolicyContext): Decision {
  if (resource === null || typeof resource !== 'object' || typeof resource.type !== 'string') return deny('DENY_PDP_ERROR');

  // Tenant match comes first: nothing about another tenant's resource is ever evaluated.
  if (typeof subject?.tenant_id !== 'string' || resource.tenant_id !== subject.tenant_id) return deny('DENY_TENANT_MISMATCH');

  const ev = evaluateSubject(subject, action, ctx);
  if ('effect' in ev) return ev;
  const { permission, grants } = ev;
  const obligations = [...ev.obligations];

  // Scope of each grant.
  let inScope: typeof grants;
  if (resource.collection === true) {
    // "The set of things of this type": creating needs a tenant-wide grant; listing is
    // allowed for any grant, and the caller must apply buildResourceFilter().
    inScope = permission.is_write ? grants.filter((g) => g.scope === 'tenant') : grants;
    if (inScope.length > 0 && !permission.is_write && !inScope.some((g) => g.scope === 'tenant')) {
      obligations.push({ type: 'filter' });
    }
  } else {
    inScope = grants.filter((g) => {
      if (g.scope === 'tenant') return true;
      if (g.scope === 'department') {
        return typeof g.role_department_id === 'string' && resource.department_id === g.role_department_id;
      }
      return (
        (typeof resource.owner_card_id === 'string' && resource.owner_card_id === subject.card_id) ||
        (typeof resource.owner_person_id === 'string' && subject.person_id !== null && resource.owner_person_id === subject.person_id)
      );
    });
  }
  if (inScope.length === 0) return deny('DENY_SCOPE');

  // Data sensitivity label.
  const sensitivity = validSensitivity(resource.sensitivity);
  if (sensitivity === null || !inScope.some((g) => sensitivity <= g.max_sensitivity)) return deny('DENY_SENSITIVITY');

  // Guard rules.
  if (SELF_FORBIDDEN.has(action) && resource.owner_card_id === subject.card_id) return deny('DENY_SELF_ACTION');
  if (resource.card_kind === 'company' && COMPANY_CARD_FORBIDDEN.has(action)) return deny('DENY_COMPANY_CARD');
  if (RANK_GUARDED.has(action)) {
    // The rank of what is being acted on MUST be known. A caller that does not supply it is
    // refused: a missing value must never switch the guard off.
    const required = resource.collection === true ? resource.role_rank : resource.target_rank;
    if (required === undefined) return deny('DENY_RANK');
    for (const rank of [resource.target_rank, resource.role_rank]) {
      if (rank === undefined) continue;
      if (typeof rank !== 'number' || !Number.isFinite(rank) || rank > ev.subjectRank) return deny('DENY_RANK');
    }
    if (TAKEOVER_CAPABLE.has(action) && !ev.isOwner && (resource.target_rank as number) >= ev.subjectRank) return deny('DENY_RANK');
  }
  if (resource.removes_last_owner !== undefined && resource.removes_last_owner !== false) return deny('DENY_LAST_OWNER');

  // Plan limits (billing hook) and card-level restrictions (feature 5).
  if (ctx.planAllows !== true) return deny('DENY_PLAN_LIMIT');
  const restrictionResult = checkRestrictions(action, permission, ctx);
  if (!Array.isArray(restrictionResult)) return restrictionResult;
  obligations.push(...restrictionResult);

  return { effect: 'allow', reason_code: 'ALLOW', obligations };
}

export function decide(subject: Subject, action: string, resource: ResourceRef, ctx: PolicyContext): Decision {
  try {
    return decideUnsafe(subject, action, resource, ctx);
  } catch {
    return deny('DENY_PDP_ERROR');
  }
}

// ----------------------------------------------------------- retrieval-time filter

/**
 * Describes where a resource type keeps the attributes the policy needs. The strings are
 * SQL fragments written in code (never from a request); values are always bound parameters.
 */
export interface ResourceDescriptor {
  type: string;
  tenantExpr: string;
  ownerCardExpr?: string;
  ownerPersonExpr?: string;
  departmentExpr?: string;
  sensitivityExpr?: string;
}

export interface ResourceFilter {
  /** A boolean SQL expression to AND into the WHERE clause. "FALSE" when nothing is visible. */
  sql: string;
  params: unknown[];
}

const NOTHING = (): ResourceFilter => ({ sql: 'FALSE', params: [] });

/**
 * The retrieval-time hook (feature 17). Returns the predicate a query MUST apply so the
 * subject can only ever retrieve rows it is allowed to see. It runs the same rules as
 * decide(); a test asserts the two always agree. `firstParam` is the number of the first
 * free bind parameter ($n) in the caller's query.
 */
export function buildResourceFilter(
  subject: Subject, action: string, descriptor: ResourceDescriptor, ctx: PolicyContext, firstParam = 1,
): ResourceFilter {
  try {
    const ev = evaluateSubject(subject, action, ctx);
    if ('effect' in ev) return NOTHING();
    if (ev.permission.is_write) return NOTHING(); // filters are for reading
    if (ctx.planAllows !== true) return NOTHING();
    if (!Array.isArray(checkRestrictions(action, ev.permission, ctx))) return NOTHING();

    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${firstParam + params.length - 1}`;
    };
    const tenantClause = `${descriptor.tenantExpr} = ${bind(subject.tenant_id)}`;

    const clauses: string[] = [];
    for (const g of ev.grants) {
      const parts: string[] = [];
      if (g.scope === 'department') {
        if (!descriptor.departmentExpr || typeof g.role_department_id !== 'string') continue;
        parts.push(`${descriptor.departmentExpr} = ${bind(g.role_department_id)}`);
      } else if (g.scope === 'own') {
        const own: string[] = [];
        if (descriptor.ownerCardExpr) own.push(`${descriptor.ownerCardExpr} = ${bind(subject.card_id)}`);
        if (descriptor.ownerPersonExpr && subject.person_id !== null) {
          own.push(`${descriptor.ownerPersonExpr} = ${bind(subject.person_id)}`);
        }
        if (own.length === 0) continue;
        parts.push(`(${own.join(' OR ')})`);
      }
      if (descriptor.sensitivityExpr) parts.push(`${descriptor.sensitivityExpr} <= ${bind(g.max_sensitivity)}`);
      clauses.push(parts.length === 0 ? 'TRUE' : `(${parts.join(' AND ')})`);
    }
    if (clauses.length === 0) return NOTHING();
    return { sql: `(${tenantClause} AND (${clauses.join(' OR ')}))`, params };
  } catch {
    return NOTHING();
  }
}
