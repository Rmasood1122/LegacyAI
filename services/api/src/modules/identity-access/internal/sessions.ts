// Server-side sessions in PostgreSQL.
//
// A session can be created ONLY from a VerifiedLogin, and a VerifiedLogin can be built ONLY
// from a StrongFactorProof AND an ScProof for the same card. There is no other constructor
// and no other INSERT INTO sessions in the codebase (a test checks both). That is what makes
// "card number + SC alone" unable to authenticate, by construction.
import { hmacSha256, isUuid, randomToken, sha256 } from '../../../shared/crypto.ts';
import type { CardState, RequestContext, RoleKey, Subject, SubjectRole } from '../../../shared/policy-types.ts';
import { getSettings, getTenant, type TenantRow, type TenantSettings, type Tx } from '../../platform/index.ts';
import { StrongFactorProof } from './factors.ts';
import { effectiveState } from './lifecycle.ts';
import { ScProof } from './secret-code.ts';

export class VerifiedLogin {
  readonly cardId: string;
  readonly tenantId: string;
  readonly credentialId: string;

  constructor(tenantId: string, strong: StrongFactorProof, sc: ScProof) {
    if (!(strong instanceof StrongFactorProof)) throw new Error('VerifiedLogin requires a verified strong factor');
    if (!(sc instanceof ScProof)) throw new Error('VerifiedLogin requires a verified secret code');
    if (strong.cardId !== sc.cardId) throw new Error('VerifiedLogin: the two proofs belong to different cards');
    if (!isUuid(tenantId)) throw new Error('VerifiedLogin: tenant id is not a UUID');
    this.cardId = strong.cardId;
    this.tenantId = tenantId;
    this.credentialId = strong.credentialId;
    Object.freeze(this);
  }
}

export type SessionRevokeReason =
  | 'logout' | 'card_suspended' | 'card_revoked' | 'card_expired' | 'card_replaced' | 'privilege_change'
  | 'sc_rotated' | 'card_locked' | 'credentials_reset' | 'admin';

const TOKEN_RE = /^v1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;

/** The tenant part only tells the server where to look; forging it finds nothing. */
export function tenantOfToken(token: string): string | null {
  const m = TOKEN_RE.exec(token);
  return m && isUuid(m[1]) ? (m[1] as string) : null;
}

/** Derived from the session token, so it never has to be stored or re-sent to be checked. */
export function csrfTokenFor(sessionToken: string): string {
  return hmacSha256(Buffer.from(sessionToken, 'utf8'), 'legacyai-csrf-v1').toString('base64url');
}

export async function createSession(
  tx: Tx, login: VerifiedLogin, ctx: RequestContext, settings: TenantSettings, hmacKey: Buffer,
): Promise<{ token: string; sessionId: string }> {
  if (!(login instanceof VerifiedLogin)) throw new Error('createSession requires a VerifiedLogin');
  const token = `v1.${login.tenantId}.${randomToken(32)}`;
  const idle = new Date(ctx.now.getTime() + settings.session_idle_minutes * 60_000);
  const absolute = new Date(ctx.now.getTime() + settings.session_absolute_hours * 3_600_000);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO sessions (tenant_id, card_id, token_hash, csrf_hash, credential_id, created_at, last_seen_at,
                           idle_expires_at, absolute_expires_at, ip_hash, user_agent_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10) RETURNING id`,
    [
      login.tenantId, login.cardId, sha256(token), sha256(csrfTokenFor(token)), login.credentialId, ctx.now,
      idle < absolute ? idle : absolute, absolute, hmacSha256(hmacKey, `ip:${ctx.ip}`), hmacSha256(hmacKey, `ua:${ctx.userAgent}`),
    ],
  );
  return { token, sessionId: (rows[0] as { id: string }).id };
}

export async function revokeSessionsForCard(tx: Tx, tenantId: string, cardId: string, reason: SessionRevokeReason, now: Date): Promise<number> {
  const res = await tx.query(
    'UPDATE sessions SET revoked_at = $4, revoked_reason = $3 WHERE tenant_id = $1 AND card_id = $2 AND revoked_at IS NULL',
    [tenantId, cardId, reason, now],
  );
  return res.rowCount;
}

export async function revokeSession(tx: Tx, sessionId: string, reason: SessionRevokeReason, now: Date): Promise<void> {
  await tx.query('UPDATE sessions SET revoked_at = $3, revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason, now]);
}

interface SessionJoinRow {
  session_id: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  card_id: string;
  card_number: string;
  kind: string;
  person_id: string | null;
  state: CardState;
  activated_at: Date | null;
  expires_at: Date;
  grace_until: Date;
  renewal_due: Date;
  locked_at: Date | null;
  department_id: string | null;
}

export interface CompanyCardInfo {
  state: CardState;
  expires_at: Date;
  grace_until: Date;
}

/** Things loaded while resolving a session that the policy decision point needs right afterwards. */
export interface SessionExtras {
  tenant: TenantRow;
  settings: TenantSettings;
  companyCard: CompanyCardInfo | null;
}

const extras = new WeakMap<Subject, SessionExtras>();
export function sessionExtras(subject: Subject): SessionExtras | undefined {
  return extras.get(subject);
}

export async function loadCompanyCard(tx: Tx, tenantId: string): Promise<CompanyCardInfo | null> {
  const { rows } = await tx.query<CompanyCardInfo>(
    `SELECT state, expires_at, grace_until FROM cards
      WHERE tenant_id = $1 AND kind = 'company' AND state NOT IN ('revoked', 'replaced') LIMIT 1`,
    [tenantId],
  );
  return rows[0] ?? null;
}

export async function loadRoles(tx: Tx, tenantId: string, cardId: string): Promise<SubjectRole[]> {
  const { rows } = await tx.query<{ role_key: RoleKey; department_id: string | null; rank: number }>(
    `SELECT cr.role_key, cr.department_id, r.rank FROM card_roles cr JOIN roles r ON r.role_key = cr.role_key
      WHERE cr.tenant_id = $1 AND cr.card_id = $2 ORDER BY r.rank DESC`,
    [tenantId, cardId],
  );
  return rows;
}

/**
 * Looks up a session and re-reads the card's state on EVERY request, so suspension,
 * revocation, lock and expiry take effect on the very next call. Nothing is cached.
 */
export async function resolveSession(
  tx: Tx, token: string, ctx: RequestContext,
): Promise<{ subject: Subject; csrfToken: string } | null> {
  const tenantId = tenantOfToken(token);
  if (tenantId === null) return null;
  const { rows } = await tx.query<SessionJoinRow>(
    `SELECT s.id AS session_id, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
            c.id AS card_id, c.card_number, c.kind, c.person_id, c.state, c.activated_at, c.expires_at, c.grace_until,
            c.renewal_due, a.locked_at, p.department_id
       FROM sessions s
       JOIN cards c ON c.tenant_id = s.tenant_id AND c.id = s.card_id
       LEFT JOIN card_auth_state a ON a.tenant_id = c.tenant_id AND a.card_id = c.id
       LEFT JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
      WHERE s.tenant_id = $1 AND s.token_hash = $2`,
    [tenantId, sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  const now = ctx.now.getTime();
  if (row.revoked_at !== null) return null;
  if (!(now < row.idle_expires_at.getTime()) || !(now < row.absolute_expires_at.getTime())) return null;

  // The card must still be one that may hold a session. "expired" is allowed through here
  // because the policy decision point decides what an expired card may still do
  // (read-only in grace; Owner export afterwards).
  const state = effectiveState(row, ctx.now);
  if (row.kind !== 'person' || row.locked_at !== null || (state !== 'active' && state !== 'expired')) return null;

  const tenant = await getTenant(tx, tenantId);
  if (!tenant) return null;
  const settings = await getSettings(tx, tenantId);
  const roles = await loadRoles(tx, tenantId, row.card_id);
  const companyCard = await loadCompanyCard(tx, tenantId);

  // After the grace window only a Company Owner keeps a session (to export data). For
  // everyone else the session ends when the grace window does.
  if (state === 'expired' && now >= row.grace_until.getTime() && !roles.some((r) => r.role_key === 'company_owner')) return null;

  const idle = new Date(Math.min(now + settings.session_idle_minutes * 60_000, row.absolute_expires_at.getTime()));
  await tx.query('UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1', [row.session_id, ctx.now, idle]);

  const subject: Subject = {
    kind: 'card',
    tenant_id: tenantId,
    card_id: row.card_id,
    card_number: row.card_number,
    person_id: row.person_id,
    department_id: row.department_id,
    card_state: row.state,
    activated_at: row.activated_at,
    expires_at: row.expires_at,
    grace_until: row.grace_until,
    renewal_due: row.renewal_due,
    locked: false,
    roles,
    is_platform_tenant: tenant.is_platform,
    session_id: row.session_id,
    session_idle_expires_at: idle,
    session_absolute_expires_at: row.absolute_expires_at,
  };
  extras.set(subject, { tenant, settings, companyCard });
  return { subject, csrfToken: csrfTokenFor(token) };
}

/** New token for the same session (old one stops working). Used when the caller's own privileges change. */
export async function rotateSession(tx: Tx, subject: Subject): Promise<string> {
  const token = `v1.${subject.tenant_id}.${randomToken(32)}`;
  await tx.query('UPDATE sessions SET token_hash = $2, csrf_hash = $3 WHERE id = $1 AND revoked_at IS NULL', [
    subject.session_id, sha256(token), sha256(csrfTokenFor(token)),
  ]);
  return token;
}

/** Builds a subject for a card WITHOUT a session. Used only by the internal, service-to-service policy check. */
export async function subjectForCard(tx: Tx, tenantId: string, cardId: string): Promise<Subject | null> {
  const { rows } = await tx.query<Omit<SessionJoinRow, 'session_id' | 'idle_expires_at' | 'absolute_expires_at' | 'revoked_at'>>(
    `SELECT c.id AS card_id, c.card_number, c.kind, c.person_id, c.state, c.activated_at, c.expires_at, c.grace_until,
            c.renewal_due, a.locked_at, p.department_id
       FROM cards c
       LEFT JOIN card_auth_state a ON a.tenant_id = c.tenant_id AND a.card_id = c.id
       LEFT JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, cardId],
  );
  const row = rows[0];
  const tenant = await getTenant(tx, tenantId);
  if (!row || !tenant || row.kind !== 'person') return null;
  const epoch = new Date(0);
  return {
    kind: 'card', tenant_id: tenantId, card_id: row.card_id, card_number: row.card_number, person_id: row.person_id,
    department_id: row.department_id, card_state: row.state, activated_at: row.activated_at, expires_at: row.expires_at,
    grace_until: row.grace_until, renewal_due: row.renewal_due, locked: row.locked_at !== null,
    roles: await loadRoles(tx, tenantId, row.card_id), is_platform_tenant: tenant.is_platform,
    session_id: '00000000-0000-0000-0000-000000000000', session_idle_expires_at: epoch, session_absolute_expires_at: epoch,
  };
}
