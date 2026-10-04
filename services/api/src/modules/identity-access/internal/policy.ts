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
import {
  actingCardId, actingPersonId, type ApiKeySubject, type CardState, type CardSubject, type Decision, type Obligation, type ResourceRef,
  type RoleKey, type Subject, type SubjectRole,
} from '../../../shared/policy-types.ts';
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
  settings: {
    enabled_roles: readonly RoleKey[];
    pilot_reviewer_grant: boolean;
    /**
     * Knowledge settings, passed in by the knowledge gateway (this module does not read that module's
     * table). Missing means the safe default: learners see verified knowledge only, and a second
     * person must verify.
     */
    learner_verified_only?: boolean;
    second_reviewer_required?: boolean;
  };
  matrix: Matrix;
  /** The tenant's live company card: its expiry puts the whole tenant into grace / lapsed. */
  companyCard: { state: CardState; expires_at: Date; grace_until: Date } | null;
  restrictions: readonly Restriction[];
  /** Current-window usage, keyed by usageKey(limit_key, window_seconds). */
  usage: ReadonlyMap<string, number>;
  /** Answer from the billing module's plan-limit hook. */
  planAllows: boolean;
  /**
   * Only for an API key: the card that made it, as it is NOW (loaded by the authorizer). Its state, its expiry and
   * its roles decide what the key may do at all; a key whose maker cannot be loaded is refused.
   */
  keyMaker?: CardSubject | null;
}

/** Writes that stay possible during the read-only grace window. "Data export is always free." */
const GRACE_EXEMPT_WRITES: ReadonlySet<string> = new Set(['export:create']);
/** The only things a Company Owner can still do after the grace window has ended. */
const LAPSED_ALLOWED: ReadonlySet<string> = new Set(['export:create', 'export:read', 'self:read', 'self:logout']);
// Seeing what is owed and paying it must stay possible when the COMPANY's term ran out - otherwise a lapsed company
// could never come back by itself. This applies only while the company itself is in that phase: a card that is
// expired on its own account (while the company is fine, or further gone than the company) gets nothing from it,
// and a locked, suspended, revoked or never-activated card was refused before any phase is looked at.
const COMPANY_TERM_ACTIONS: ReadonlySet<string> = new Set(['billing:read', 'billing:manage']);
/**
 * The ONLY permissions an API key may ever carry (decision D30): reading knowledge, topics, the gap report and
 * documents' labels, and asking a question. Read and ask, nothing else: nothing that adds or changes anything (a
 * machine must not make a person's attestation about a document), nothing that manages people, cards, roles, keys,
 * settings, consent, billing or the audit log, nothing that verifies or approves, and no platform permission.
 */
export const API_KEY_PERMISSIONS: ReadonlySet<string> = new Set([
  'knowledge:read', 'knowledge:ask', 'topic:read', 'gap:read', 'source:read',
]);
/** Nobody may do these to their own card. */
const SELF_FORBIDDEN: ReadonlySet<string> = new Set([
  'card:suspend', 'card:revoke', 'card:replace', 'card:unlock', 'card:reset_credentials',
  'card_restrictions:update', 'card_roles:assign', 'card_roles:remove', 'person:update',
]);
/**
 * Actions that hand the actor a way INTO the target card - directly (a new SC, a new enrollment
 * token, a new card) or in two steps (take the target's rank away first, or revoke the card and
 * issue a new one to the same person). For these the actor must rank strictly ABOVE the target:
 * an Admin cannot do them to another Admin, and an Owner cannot do them to another Owner.
 * For card:issue the "target" is the person: the highest rank any of that person's cards ever held.
 * Nobody inside a tenant outranks an Owner, so a locked-out Owner is recovered by the platform
 * operator (docs/runbooks/owner-recovery.md). The single exception is a Company Owner renewing
 * their OWN card: that gives them nothing they do not already have.
 */
const TAKEOVER_CAPABLE: ReadonlySet<string> = new Set([
  'card:renew', 'card:unlock', 'card:reset_credentials', 'card:replace', 'card_roles:assign', 'card_roles:remove', 'card:issue',
]);
/**
 * The company card is the tenant's identity and subscription clock. Nothing can be done to it
 * from inside the tenant - not even renewal, which only the platform operator can do
 * (permission tenant:renew_company_card) until billing takes it over.
 */
const COMPANY_CARD_FORBIDDEN: ReadonlySet<string> = new Set([
  'card:suspend', 'card:reinstate', 'card:revoke', 'card:replace', 'card:renew', 'card:unlock', 'card:reset_credentials',
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
/**
 * Second-reviewer rule (docs/phase2/06): whoever verifies an item, or releases it to learners, must be
 * neither its contributor nor the author of its current version. One rule, whatever the item's origin.
 */
const FOUR_EYES: ReadonlySet<string> = new Set(['knowledge:verify', 'knowledge:label']);
const VERIFIED: ReadonlySet<string> = new Set(['verified', 'corrected']);

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

/**
 * The role -> permission matrix, read ONE way for everything that asks "what does this card hold?": the decision,
 * the list filters, what the session endpoint reports, and what a card may write into an API key.
 * Roles the company switched off count for nothing; the pilot grant counts only while the company has it on;
 * platform-only permissions count only in the operator's own tenant.
 */
export function heldGrants(
  roles: readonly SubjectRole[], isPlatformTenant: boolean, ctx: Pick<PolicyContext, 'matrix' | 'settings'>,
): Array<Grant & { role_department_id: string | null }> {
  const enabled = new Set<string>(ctx.settings.enabled_roles);
  const out: Array<Grant & { role_department_id: string | null }> = [];
  for (const role of roles) {
    if (!enabled.has(role.role_key)) continue;
    for (const g of ctx.matrix.grants) {
      if (g.role_key !== role.role_key) continue;
      if (g.grant_source === 'pilot_reviewer' && ctx.settings.pilot_reviewer_grant !== true) continue;
      if (ctx.matrix.permissions.get(g.permission_key)?.platform_only === true && isPlatformTenant !== true) continue;
      out.push({ ...g, role_department_id: role.department_id });
    }
  }
  return out;
}

/**
 * What a KEY holds for one action: the grants its maker holds for that action right now, if the action is on the
 * short list a key may carry AND was written into the key - each cut down to the key's level. Pure.
 * 'outside-scope' = the key may not do this at all; 'malformed' = the key's own data cannot be read (refuse).
 */
export function grantsForKey<G extends { max_sensitivity: number }>(
  makerGrants: readonly G[], key: Pick<ApiKeySubject, 'scope' | 'max_sensitivity'>, action: string,
): G[] | 'outside-scope' | 'malformed' {
  if (key === null || typeof key !== 'object' || !Array.isArray(key.scope) || !key.scope.every((p) => typeof p === 'string')) return 'malformed';
  const level = key.max_sensitivity;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 3) return 'malformed';
  if (!API_KEY_PERMISSIONS.has(action) || !key.scope.includes(action)) return 'outside-scope';
  return makerGrants.map((g) => ({ ...g, max_sensitivity: Math.min(g.max_sensitivity, level) }));
}

/** The card whose state, expiry and roles decide: the card itself, or - for a key - the card that made it. */
function cardBehind(subject: Subject, ctx: PolicyContext): CardSubject | null {
  if (subject === null || typeof subject !== 'object') return null;
  if (subject.kind === 'card') return subject;
  if (subject.kind !== 'api_key') return null;
  const maker = ctx.keyMaker;
  if (maker === undefined || maker === null || maker.kind !== 'card') return null;
  if (subject.acts_for === null || typeof subject.acts_for !== 'object') return null;
  return maker.card_id === subject.acts_for.card_id && maker.tenant_id === subject.tenant_id ? maker : null;
}

/** Steps that depend only on who is asking and what action - shared by decide() and buildResourceFilter(). */
function evaluateSubject(asking: Subject, action: string, ctx: PolicyContext): Decision | SubjectEvaluation {
  // For a card: the card. For a key: the card that made it - the key has no state, expiry or roles of its own.
  const subject = cardBehind(asking, ctx);
  if (subject === null) return deny('DENY_UNAUTHENTICATED');
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
    const payingForTheCompany = tenantPhase === 'grace' && COMPANY_TERM_ACTIONS.has(action);
    if (permission.is_write && !GRACE_EXEMPT_WRITES.has(action) && !payingForTheCompany) {
      return deny(tenantCaused ? 'DENY_TENANT_GRACE_READ_ONLY' : 'DENY_GRACE_READ_ONLY');
    }
    obligations.push({ type: 'read_only' });
  } else if (phase === 'lapsed') {
    const isOwner = roles.some((r) => r.role_key === 'company_owner');
    const payingForTheCompany = tenantPhase === 'lapsed' && COMPANY_TERM_ACTIONS.has(action);
    if (!isOwner || !(LAPSED_ALLOWED.has(action) || payingForTheCompany)) return deny(tenantCaused ? 'DENY_TENANT_EXPIRED' : 'DENY_CARD_EXPIRED');
    obligations.push({ type: 'export_only' });
  }

  // The role -> permission matrix.
  if (permission.platform_only && subject.is_platform_tenant !== true) return deny('DENY_PLATFORM_ONLY');
  let grants: SubjectEvaluation['grants'] = heldGrants(subject.roles, subject.is_platform_tenant, ctx).filter((g) => g.permission_key === action);
  if (grants.length === 0) return deny('DENY_DEFAULT');

  if (asking.kind === 'api_key') {
    // A key holds what its maker holds for this action, cut down to the key (grantsForKey). It has no rank and is
    // nobody's Owner: the rank guards and the Owner's exceptions never apply to it.
    const forKey = grantsForKey(grants, asking, action);
    if (forKey === 'malformed') return deny('DENY_PDP_ERROR');
    if (forKey === 'outside-scope') return deny('DENY_API_KEY_SCOPE');
    grants = forKey;
    return { permission, grants, obligations, subjectRank: 0, isOwner: false };
  }

  const subjectRank = roles.reduce((max, r) => (Number.isFinite(r.rank) && r.rank > max ? r.rank : max), 0);
  return { permission, grants, obligations, subjectRank, isOwner: roles.some((r) => r.role_key === 'company_owner') };
}

/**
 * "Verified only" (docs/phase2/03): while the company setting is on, someone whose applicable grants
 * reach only released (level 0) material sees verified knowledge only. decide() and the filter spec
 * both use this, so the two locks agree.
 */
function onlyVerified(grants: SubjectEvaluation['grants'], ctx: PolicyContext): boolean {
  if (ctx.settings.learner_verified_only === false) return false;
  return grants.every((g) => g.max_sensitivity === 0);
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

/** Is `ip` inside one of these networks (CIDR notation)? Anything malformed means "no" (fail closed). */
export function cidrsAllow(cidrs: unknown, ip: string): boolean {
  if (!Array.isArray(cidrs) || cidrs.length === 0) return false;
  const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(address);
  if (family === 0) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
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

/** Can every entry be read as a network? (The same reading as cidrsAllow, so a stored list is never unreadable later.) */
export function validCidrs(cidrs: unknown): boolean {
  if (!Array.isArray(cidrs) || cidrs.length === 0 || cidrs.length > 20) return false;
  return cidrs.every((cidr) => {
    if (typeof cidr !== 'string' || cidr.length > 50) return false;
    const [net, prefixText, extra] = cidr.split('/');
    const family = isIP(net ?? '');
    if (family === 0 || extra !== undefined) return false;
    if (prefixText === undefined) return true;
    return /^[0-9]{1,3}$/.test(prefixText) && Number(prefixText) <= (family === 4 ? 32 : 128);
  });
}

function networkAllowed(config: Record<string, unknown>, ip: string): boolean {
  return cidrsAllow(config.cidrs, ip);
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
  // "Mine" - for a grant that covers one's own things, and for the rules about acting on what one wrote or on one's
  // own card: a card is itself; a key stands for the card and the person that made it.
  const myCard = actingCardId(subject);
  const myPerson = actingPersonId(subject);

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
        (typeof resource.owner_card_id === 'string' && resource.owner_card_id === myCard) ||
        (typeof resource.owner_person_id === 'string' && myPerson !== null && resource.owner_person_id === myPerson)
      );
    });
  }
  if (inScope.length === 0) return deny('DENY_SCOPE');

  // Data sensitivity label.
  const sensitivity = validSensitivity(resource.sensitivity);
  if (sensitivity === null || !inScope.some((g) => sensitivity <= g.max_sensitivity)) return deny('DENY_SENSITIVITY');

  // Guard rules.
  if (SELF_FORBIDDEN.has(action) && resource.owner_card_id === myCard) return deny('DENY_SELF_ACTION');
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
    if (TAKEOVER_CAPABLE.has(action)) {
      // The target's rank must be known here too (for card:issue: the person's rank history).
      if (typeof resource.target_rank !== 'number') return deny('DENY_RANK');
      if (resource.target_rank >= ev.subjectRank) {
        const ownRenewal = ev.isOwner && action === 'card:renew' && resource.owner_card_id === myCard;
        if (!ownRenewal) return deny('DENY_RANK');
      }
    }
  }
  if (resource.removes_last_owner !== undefined && resource.removes_last_owner !== false) return deny('DENY_LAST_OWNER');
  // Knowledge guards. They apply only to resources that carry the attribute; a knowledge resource
  // loaded without it is described incompletely and is refused rather than waved through.
  if (resource.verification_status !== undefined) {
    if (typeof resource.verification_status !== 'string') return deny('DENY_PDP_ERROR');
    // Judged on ALL applicable grants, exactly as buildResourceFilterSpec() does, so the two locks agree.
    if (!VERIFIED.has(resource.verification_status) && onlyVerified(grants, ctx)) return deny('DENY_UNVERIFIED');
  }
  // A label change of a knowledge item must SAY whether it releases the item to learners or changes released knowledge.
  // A route that forgets to say so is refused, instead of slipping past the second-person rule below.
  if (action === 'knowledge:label' && resource.type === 'knowledge_item'
      && typeof resource.releases_to_learners !== 'boolean' && typeof resource.changes_released_knowledge !== 'boolean') return deny('DENY_PDP_ERROR');
  if (FOUR_EYES.has(action) && (action === 'knowledge:verify' || resource.releases_to_learners === true || resource.changes_released_knowledge === true)) {
    if (resource.owner_person_id === undefined || resource.author_person_id === undefined) return deny('DENY_SELF_REVIEW');
    // a key counts as its maker: it may not verify or release what its maker wrote
    const me = myPerson;
    const mine = me !== null && (resource.owner_person_id === me || resource.author_person_id === me);
    if (mine && ctx.settings.second_reviewer_required !== false) return deny('DENY_SELF_REVIEW');
  }
  // The same rule for things that are not knowledge items (a scenario, a test question): the route names who wrote it.
  // An approval that does not name them is refused, instead of slipping past the rule.
  if (resource.approval !== undefined && resource.approval !== true) return deny('DENY_PDP_ERROR');
  if (resource.approval === true && resource.not_by === undefined) return deny('DENY_PDP_ERROR');
  if (resource.not_by !== undefined) {
    const by = resource.not_by;
    if (by === null || typeof by !== 'object' || !Array.isArray(by.person_ids) || !Array.isArray(by.card_ids)) return deny('DENY_PDP_ERROR');
    const mine = by.card_ids.includes(myCard) || (myPerson !== null && by.person_ids.includes(myPerson));
    if (mine && ctx.settings.second_reviewer_required !== false) return deny('DENY_SELF_REVIEW');
  }

  // Plan limits (billing hook) and card-level restrictions (feature 5).
  if (ctx.planAllows !== true) return deny('DENY_PLAN_LIMIT');
  // Restrictions are set on a CARD (its hours, its networks, its usage cap). They do not bind a key its holder made:
  // a key has its own network list and its own limits, checked before the policy is asked.
  if (subject.kind === 'card') {
    const restrictionResult = checkRestrictions(action, permission, ctx);
    if (!Array.isArray(restrictionResult)) return restrictionResult;
    obligations.push(...restrictionResult);
  }

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
  /** For tables that hold knowledge: the condition "verified or corrected", applied when the spec says only_verified. */
  verifiedExpr?: string;
}

export interface ResourceFilter {
  /** A boolean SQL expression to AND into the WHERE clause. "FALSE" when nothing is visible. */
  sql: string;
  params: unknown[];
}

const NOTHING = (): ResourceFilter => ({ sql: 'FALSE', params: [] });

/** One way in which the subject may see rows. Data only: no SQL, no column names. */
export type FilterGrant =
  | { scope: 'tenant'; max_sensitivity: number }
  | { scope: 'department'; department_id: string; max_sensitivity: number }
  | { scope: 'own'; owner_person_id?: string; owner_card_id: string; max_sensitivity: number };

/**
 * The access filter as DATA (docs/phase2/03, lock 2). It crosses the service boundary inside the
 * signed service token; the AI service turns it into a query condition with its own fixed
 * descriptors. `nothing: true` is what every denial becomes.
 */
export interface FilterSpec {
  v: 1;
  tenant_id: string;
  action: string;
  nothing: boolean;
  only_verified: boolean;
  any_of: FilterGrant[];
}

/** Builds the filter spec with the same subject evaluation as decide(). Any error means "nothing". */
export function buildResourceFilterSpec(subject: Subject, action: string, ctx: PolicyContext): FilterSpec {
  const nothing: FilterSpec = {
    v: 1, tenant_id: typeof subject?.tenant_id === 'string' ? subject.tenant_id : '', action: String(action), nothing: true,
    only_verified: true, any_of: [],
  };
  try {
    const ev = evaluateSubject(subject, action, ctx);
    if ('effect' in ev) return nothing;
    if (ev.permission.is_write) return nothing; // filters are for reading
    if (ctx.planAllows !== true) return nothing;
    if (subject.kind === 'card' && !Array.isArray(checkRestrictions(action, ev.permission, ctx))) return nothing;
    const anyOf: FilterGrant[] = [];
    for (const g of ev.grants) {
      if (!Number.isInteger(g.max_sensitivity) || g.max_sensitivity < 0 || g.max_sensitivity > 3) return nothing;
      if (g.scope === 'tenant') anyOf.push({ scope: 'tenant', max_sensitivity: g.max_sensitivity });
      else if (g.scope === 'department') {
        if (typeof g.role_department_id !== 'string') continue;
        anyOf.push({ scope: 'department', department_id: g.role_department_id, max_sensitivity: g.max_sensitivity });
      } else {
        anyOf.push({
          scope: 'own', owner_card_id: actingCardId(subject), max_sensitivity: g.max_sensitivity,
          ...(actingPersonId(subject) !== null ? { owner_person_id: actingPersonId(subject) as string } : {}),
        });
      }
    }
    if (anyOf.length === 0) return nothing;
    return { v: 1, tenant_id: subject.tenant_id, action, nothing: false, only_verified: onlyVerified(ev.grants, ctx), any_of: anyOf };
  } catch {
    return nothing;
  }
}

/**
 * The retrieval-time hook (feature 17) for the API's own list queries: the filter spec above,
 * translated into the predicate a query MUST apply. One source of rules for both services; a test
 * asserts it always agrees with decide(). `firstParam` is the number of the first free bind
 * parameter ($n) in the caller's query.
 */
export function buildResourceFilter(
  subject: Subject, action: string, descriptor: ResourceDescriptor, ctx: PolicyContext, firstParam = 1,
): ResourceFilter {
  try {
    const spec = buildResourceFilterSpec(subject, action, ctx);
    if (spec.nothing) return NOTHING();
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${firstParam + params.length - 1}`;
    };
    const tenantClause = `${descriptor.tenantExpr} = ${bind(spec.tenant_id)}`;

    const clauses: string[] = [];
    for (const g of spec.any_of) {
      const parts: string[] = [];
      if (g.scope === 'department') {
        if (!descriptor.departmentExpr) continue;
        parts.push(`${descriptor.departmentExpr} = ${bind(g.department_id)}`);
      } else if (g.scope === 'own') {
        const own: string[] = [];
        if (descriptor.ownerCardExpr) own.push(`${descriptor.ownerCardExpr} = ${bind(g.owner_card_id)}`);
        if (descriptor.ownerPersonExpr && g.owner_person_id !== undefined) {
          own.push(`${descriptor.ownerPersonExpr} = ${bind(g.owner_person_id)}`);
        }
        if (own.length === 0) continue;
        parts.push(`(${own.join(' OR ')})`);
      }
      if (descriptor.sensitivityExpr) parts.push(`${descriptor.sensitivityExpr} <= ${bind(g.max_sensitivity)}`);
      clauses.push(parts.length === 0 ? 'TRUE' : `(${parts.join(' AND ')})`);
    }
    if (clauses.length === 0) return NOTHING();
    let sql = `(${tenantClause} AND (${clauses.join(' OR ')}))`;
    if (spec.only_verified && descriptor.verifiedExpr !== undefined) sql = `(${sql} AND ${descriptor.verifiedExpr})`;
    return { sql, params };
  } catch {
    return NOTHING();
  }
}
