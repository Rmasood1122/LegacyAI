// Types shared by the HTTP layer (platform) and the policy decision point (identity-access).
// Types (and two one-line accessors over them): no behaviour lives here.

export type RoleKey =
  | 'company_owner'
  | 'admin'
  | 'department_manager'
  | 'auditor'
  | 'reviewer'
  | 'expert'
  | 'successor'
  | 'contractor';

export type CardState = 'issued' | 'active' | 'suspended' | 'revoked' | 'expired' | 'replaced';

export interface SubjectRole {
  role_key: RoleKey;
  department_id: string | null;
  rank: number;
}

/** A signed-in card. Built ONLY by the session layer from database rows, never from request input. */
export interface CardSubject {
  kind: 'card';
  tenant_id: string;
  card_id: string;
  card_number: string;
  person_id: string | null;
  department_id: string | null;
  /** State as stored. Expiry is derived from the clock by the policy decision point. */
  card_state: CardState;
  activated_at: Date | null;
  expires_at: Date;
  grace_until: Date;
  renewal_due: Date;
  locked: boolean;
  roles: SubjectRole[];
  is_platform_tenant: boolean;
  session_id: string;
  session_idle_expires_at: Date;
  session_absolute_expires_at: Date;
}

/**
 * A machine's API key (docs/phase4/06, decision D30). Its OWN kind of subject: it has no roles, no session and no
 * person, so code written for "a card" does not accept it (the compiler refuses), and nothing can run with the
 * maker's full rights by forgetting to look for a marker.
 *
 * What a key may do is decided by the policy decision point alone: the grants its maker's card holds at that
 * moment, cut down to the key's scope, to the short list a key may ever carry, and to the key's level.
 * `acts_for` is the card (and person) that made the key - used for two things only: the second-person rules
 * (a key may not approve what its maker wrote) and the audit trail.
 */
export interface ApiKeySubject {
  kind: 'api_key';
  tenant_id: string;
  key_id: string;
  scope: readonly string[];
  max_sensitivity: number;
  acts_for: { card_id: string; person_id: string | null };
}

/** Who is asking: a signed-in card, or a machine's API key. Built only by the identity module. */
export type Subject = CardSubject | ApiKeySubject;

/** The card a database row or an audit entry names as the actor: the card itself, or the card a key acts for. */
export const actingCardId = (subject: Subject): string => (subject.kind === 'card' ? subject.card_id : subject.acts_for.card_id);
/** Whose idempotency records a request uses: a card's own, or a key's own (never shared between the two). */
export const idempotencyActor = (subject: Subject): { kind: 'card'; id: string } | { kind: 'api_key'; id: string } =>
  (subject.kind === 'card' ? { kind: 'card', id: subject.card_id } : { kind: 'api_key', id: subject.key_id });
/** The person behind the request, for rules about "the same person": the card's person, or the key's maker. */
export const actingPersonId = (subject: Subject): string | null => (subject.kind === 'card' ? subject.person_id : subject.acts_for.person_id);

/** What is being acted on. `collection: true` means "the set of things of this type" (list / create). */
export interface ResourceRef {
  type: string;
  id?: string;
  tenant_id: string;
  collection?: boolean;
  owner_card_id?: string | null;
  owner_person_id?: string | null;
  department_id?: string | null;
  sensitivity?: number;
  /** For card resources: a company card is the tenant's identity and subscription clock, not a login. */
  card_kind?: 'person' | 'company';
  /** Highest role rank held by the target card (for the rank guard). */
  target_rank?: number;
  /** Highest rank among roles being granted or removed. */
  role_rank?: number;
  /** True when the action would leave the tenant without an active Company Owner. */
  removes_last_owner?: boolean;
  /** Knowledge: 'verified' | 'corrected' | 'unverified' | 'stale' (and item states). Drives the verified-only rule. */
  verification_status?: string;
  /** Knowledge item: the person who wrote its CURRENT version (null for an AI extraction). Drives the second-reviewer rule. */
  author_person_id?: string | null;
  /** True when a label change would release the item to learners (sensitivity 0). */
  releases_to_learners?: boolean;
  /** True when a label change alters how an already verified item is used (its topics: what learners are tested on, what the gap report counts). */
  changes_released_knowledge?: boolean;
  /**
   * "A second person must do this": the people and cards who wrote what is being approved and therefore may NOT take
   * this action on it (a scenario's creator and last editor; a test question's generator and last editor). Refused
   * with DENY_SELF_REVIEW unless the company switched the second-reviewer rule off.
   */
  not_by?: { person_ids: Array<string | null>; card_ids: Array<string | null> };
  /**
   * True when the action is an APPROVAL of what somebody wrote (a scenario, a test question). Approval shares its
   * permission with edit and retire, so the route has to say so; a resource marked like this MUST name its writers
   * in `not_by`, or the decision is a refusal.
   */
  approval?: boolean;
}

/** A resource description for an approval: it cannot be built without saying who may not approve. */
export type ApprovalRef = ResourceRef & { approval: true; not_by: NonNullable<ResourceRef['not_by']> };

export type Obligation =
  | { type: 'read_only' }
  | { type: 'export_only' }
  | { type: 'filter' }
  | { type: 'count_usage'; limit_key: string; window_seconds: number };

export const KNOWN_OBLIGATIONS: ReadonlySet<string> = new Set(['read_only', 'export_only', 'filter', 'count_usage']);

export interface Decision {
  effect: 'allow' | 'deny';
  reason_code: string;
  obligations: Obligation[];
}

export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  now: Date;
  /**
   * The browser's own statement of where a request came from (the Sec-Fetch-Site header): 'same-origin',
   * 'same-site', 'cross-site' or 'none'. Page scripts cannot set or change it. Null when the client sent none
   * (anything that is not a browser). Set by the HTTP layer only, and used there only: a signed-in request marked
   * 'cross-site' or 'same-site' without an allowed Origin is refused before the policy is asked.
   */
  fetchSite?: string | null;
  /**
   * Work to do once the request's transaction has COMMITTED (telling people about something that really
   * happened). The HTTP layer runs these after the commit and never lets one of them fail the request.
   */
  afterCommit?: Array<() => Promise<void>>;
}
