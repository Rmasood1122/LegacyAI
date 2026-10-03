// Types shared by the HTTP layer (platform) and the policy decision point (identity-access).
// Types only: no behaviour lives here.

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

/** Who is asking. Built ONLY by the session layer from database rows, never from request input. */
export interface Subject {
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
}

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
}
