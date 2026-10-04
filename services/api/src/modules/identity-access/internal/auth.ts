// Sign-in and enrollment.
//
// LOGIN = card number + SC + strong factor, all in ONE request.
// Order of checks inside verify (see docs/phase1/03-security-model.md section 4):
//   1. rate limits            2. login transaction        3. STRONG FACTOR
//   4. SC (always computed)   5. lock / state / expiry    6. session
// A wrong SC only counts toward lockout AFTER the strong factor passed, so somebody who
// merely knows a card number can never lock its owner out.
//
// Every failure returns the same generic 401. The real reason goes to login_attempts and
// the audit log only.
import { hmacSha256, randomToken, sha256 } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';
import type { RequestContext } from '../../../shared/policy-types.ts';
import {
  getSettings, getTenant, PLATFORM_TENANT_ID, writeAudit,
  type Database, type HandlerResult, type Notifier, type RateLimiter, type Tx,
} from '../../platform/index.ts';
import type { AnomalyGuard } from './anomaly.ts';
import type { Authorizer } from './authz.ts';
import { maskCardNumber, normalizeCardNumber } from './card-number.ts';
import { CARD_COLUMNS, type CardRow, type CardService } from './cards.ts';
import {
  newTotpSecret, passkeyLoginOptions, passkeyRegistrationOptions, verifyPasskeyAssertion, verifyPasskeyRegistration,
  verifyTotpCode, verifyTotpEnrollment, type SeedCipher, type StoredCredential, type StrongFactorProof, type WebAuthnSettings,
} from './factors.ts';
import { effectiveState } from './lifecycle.ts';
import type { ScProof, SecretCodeHasher } from './secret-code.ts';
import { createSession, resolveSession, revokeSession, subjectForCard, VerifiedLogin } from './sessions.ts';

export interface AuthLimits {
  loginPerIp: { limit: number; windowSeconds: number };
  loginGlobal: { limit: number; windowSeconds: number };
  totp: { maxFailures: number; windowSeconds: number; pauseSeconds: number; maxPauseSeconds: number };
}

export const DEFAULT_AUTH_LIMITS: AuthLimits = {
  loginPerIp: { limit: 20, windowSeconds: 300 },
  loginGlobal: { limit: 300, windowSeconds: 60 },
  totp: { maxFailures: 5, windowSeconds: 900, pauseSeconds: 900, maxPauseSeconds: 3600 },
};

const TXN_TTL_SECONDS = 300;

/** Associated data for encrypted TOTP seeds: bound to the tenant, so a seed survives a card replacement. */
const totpAad = (tenantId: string): string => `totp:${tenantId}`;

type FailReason =
  | 'bad_txn' | 'unknown_card' | 'bad_factor' | 'factor_throttled' | 'bad_sc' | 'locked' | 'state' | 'expired'
  | 'tenant_inactive' | 'bad_enrollment_token' | 'superseded';

interface AuthStateRow {
  sc_failed_count: number;
  locked_at: Date | null;
  factor_failed_count: number;
  factor_window_start: Date | null;
  factor_throttle_level: number;
  factor_throttled_until: Date | null;
  last_totp_step: string | null;
}

export interface AuthDeps {
  db: Database;
  hasher: SecretCodeHasher;
  cipher: SeedCipher;
  cards: CardService;
  authorizer: Authorizer;
  rateLimiter: RateLimiter;
  notifier: Notifier;
  anomaly: AnomalyGuard;
  webauthn: WebAuthnSettings;
  hmacKey: Buffer;
  limits: AuthLimits;
}

const CREDENTIAL_COLUMNS = `id, card_id, type, webauthn_credential_id, webauthn_public_key, webauthn_sign_count::text AS webauthn_sign_count,
  webauthn_transports, totp_secret_enc, totp_key_id`;

export class AuthService {
  readonly #d: AuthDeps;

  constructor(deps: AuthDeps) {
    this.#d = deps;
  }

  async #enforceLimits(ctx: RequestContext): Promise<void> {
    const { rateLimiter, limits } = this.#d;
    const perIp = await rateLimiter.hit(`login-ip:${ctx.ip}`, limits.loginPerIp.limit, limits.loginPerIp.windowSeconds, ctx.now);
    // A caller already over its own limit is turned away BEFORE the shared budget is touched;
    // otherwise one address could use up the global allowance and block sign-in for everyone.
    if (!perIp.allowed) throw problems.tooManyRequests(perIp.retryAfterSeconds);
    // The global cap bounds total Argon2 work, so a flood cannot run up CPU cost.
    const global = await rateLimiter.hit('login-global', limits.loginGlobal.limit, limits.loginGlobal.windowSeconds, ctx.now);
    if (!global.allowed) throw problems.tooManyRequests(global.retryAfterSeconds);
  }

  #cardHmac(digitsOrInput: string): Buffer {
    return hmacSha256(this.#d.hmacKey, `card:${digitsOrInput}`);
  }

  async #resolveCard(cardNumber: unknown): Promise<{ tenantId: string; cardId: string } | null> {
    const digits = normalizeCardNumber(cardNumber);
    if (digits === null) return null;
    const { rows } = await this.#d.db.global<{ tenant_id: string; card_id: string }>('SELECT tenant_id, card_id FROM resolve_card($1)', [digits]);
    return rows[0] ? { tenantId: rows[0].tenant_id, cardId: rows[0].card_id } : null;
  }

  async #recordAttempt(tx: Tx, p: { cardHmac: Buffer; tenantId: string | null; cardId: string | null; ok: boolean; reason: string }, ctx: RequestContext): Promise<void> {
    await tx.query(
      'INSERT INTO login_attempts (card_number_hmac, tenant_id, card_id, ip_hash, outcome, real_reason, request_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [p.cardHmac, p.tenantId, p.cardId, hmacSha256(this.#d.hmacKey, `ip:${ctx.ip}`), p.ok ? 'success' : 'fail', p.reason, ctx.requestId],
    );
  }

  // ----------------------------------------------------------------- login: begin

  async loginBegin(ctx: RequestContext, body: { card_number: string }): Promise<HandlerResult> {
    await this.#enforceLimits(ctx);
    const resolved = await this.#resolveCard(body.card_number);
    const { options, challenge } = await passkeyLoginOptions(this.#d.webauthn);
    const token = randomToken(32);
    // The same row shape and the same response for known and unknown cards.
    await this.#d.db.global(
      `INSERT INTO auth_transactions (txn_hash, purpose, tenant_id, card_id, challenge, payload, ip_hash, expires_at)
       VALUES ($1, 'login', $2, $3, $4, $5, $6, $7)`,
      [
        sha256(token), resolved?.tenantId ?? null, resolved?.cardId ?? null, challenge,
        JSON.stringify({ card_hmac: this.#cardHmac(normalizeCardNumber(body.card_number) ?? String(body.card_number)).toString('hex') }),
        hmacSha256(this.#d.hmacKey, `ip:${ctx.ip}`), new Date(ctx.now.getTime() + TXN_TTL_SECONDS * 1000),
      ],
    );
    return { body: { login_txn: token, webauthn_options: options, totp_allowed: true, expires_in: TXN_TTL_SECONDS } };
  }

  // ---------------------------------------------------------------- login: verify

  async loginVerify(
    ctx: RequestContext,
    body: { login_txn: string; sc: string; factor: { type: 'passkey'; assertion: unknown } | { type: 'totp'; code: string } },
  ): Promise<HandlerResult> {
    await this.#enforceLimits(ctx);
    const { db } = this.#d;

    // Single use: the transaction is consumed whether or not the attempt succeeds.
    const consumed = await db.global<{ tenant_id: string | null; card_id: string | null; challenge: string; payload: { card_hmac?: string } }>(
      `UPDATE auth_transactions SET consumed_at = $2
        WHERE txn_hash = $1 AND purpose = 'login' AND consumed_at IS NULL AND expires_at > $2
        RETURNING tenant_id, card_id, challenge, payload`,
      [sha256(body.login_txn), ctx.now],
    );
    const txn = consumed.rows[0] ?? null;
    const known = txn !== null && txn.tenant_id !== null && txn.card_id !== null;
    const tenantId = known ? (txn.tenant_id as string) : PLATFORM_TENANT_ID;
    const cardId = known ? (txn.card_id as string) : null;
    const cardHmac = Buffer.from(txn?.payload.card_hmac ?? '', 'hex');

    const result = await db.withTenantTx<{ token: string; body: Record<string, unknown> } | null>(tenantId, async (tx) => {
      const fail = async (reason: FailReason, card: CardRow | null): Promise<null> => {
        await this.#recordAttempt(tx, { cardHmac, tenantId: card ? tenantId : null, cardId: card?.id ?? null, ok: false, reason }, ctx);
        if (card) {
          await this.#d.cards.event(tx, card, 'login_failed', null, ctx, {});
          await writeAudit(tx, {
            tenantId, actorKind: 'anonymous', action: 'auth:login', resourceType: 'card', resourceId: card.id,
            decision: 'deny', reasonCode: `LOGIN_${reason.toUpperCase()}`, requestId: ctx.requestId, ip: ctx.ip,
          });
        }
        return null;
      };

      // Everything slow (signature check, Argon2) happens BEFORE any row is locked, so a known
      // card and an unknown card behave the same under concurrent requests.
      const card = cardId === null ? null : (await tx.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = $1`, [cardId])).rows[0] ?? null;
      const before = card === null ? null : await this.#authState(tx, card, false);
      const credentials = card === null ? [] : (await tx.query<StoredCredential>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE tenant_id = $1 AND card_id = $2 AND status = 'active'`, [tenantId, card.id])).rows;
      const secret = card === null ? null : (await tx.query<{ id: string; sc_hash: string; pepper_id: string }>(
        `SELECT id, sc_hash, pepper_id FROM card_secrets WHERE tenant_id = $1 AND card_id = $2 AND status = 'current'`, [tenantId, card.id])).rows[0] ?? null;

      // SC - exactly one Argon2 computation (real or dummy) on every path.
      const scResult = await this.#d.hasher.verify(card?.id ?? null, body.sc, secret ? { hash: secret.sc_hash, pepperId: secret.pepper_id } : null);
      const sc: ScProof | null = scResult.proof;

      // Strong factor - exactly one verification (real or dummy) on every path.
      let strong: StrongFactorProof | null = null;
      let newSignCount: number | null = null;
      let totpStep: number | null = null;
      const throttled = body.factor.type === 'totp' && before?.factor_throttled_until != null && before.factor_throttled_until.getTime() > ctx.now.getTime();
      if (body.factor.type === 'passkey') {
        const res = await verifyPasskeyAssertion({
          webauthn: this.#d.webauthn, cardId: card?.id ?? null, credentials, assertion: body.factor.assertion,
          expectedChallenge: txn?.challenge ?? 'no-such-challenge',
        });
        if (res) ({ proof: strong, newSignCount } = res);
      } else {
        // While TOTP is paused for this card (too many wrong codes), a code is examined ONLY when
        // the SC in the same request is right. A stranger guessing codes therefore learns nothing
        // during the pause, while the real cardholder - who knows the SC - can still sign in.
        const examine = !throttled || sc !== null;
        const res = await verifyTotpCode({
          cipher: this.#d.cipher, aad: totpAad(tenantId), cardId: examine ? (card?.id ?? null) : null, credentials, code: body.factor.code,
          now: ctx.now, lastStep: before?.last_totp_step == null ? null : Number(before.last_totp_step),
        });
        if (res) ({ proof: strong, step: totpStep } = res);
      }

      if (card === null || before === null) return fail(txn === null ? 'bad_txn' : 'unknown_card', null);

      // Short critical section: lock the card's counters and decide.
      const state = await this.#authState(tx, card, true);
      // A renewal, unlock or recovery may have committed while the slow checks above ran. Now that
      // the row is locked, what was just verified must STILL be the card's current SC and an
      // active factor - otherwise a sign-in already in flight would outlive the reset.
      if (strong !== null || sc !== null) {
        const stillActive = strong === null ? null : (await tx.query(
          `SELECT 1 FROM credentials WHERE id = $1 AND tenant_id = $2 AND card_id = $3 AND status = 'active'`, [strong.credentialId, tenantId, card.id])).rowCount;
        const currentSecret = (await tx.query<{ id: string }>(
          `SELECT id FROM card_secrets WHERE tenant_id = $1 AND card_id = $2 AND status = 'current'`, [tenantId, card.id])).rows[0]?.id ?? null;
        if (stillActive === 0 || (sc !== null && currentSecret !== secret?.id)) return fail('superseded', card);
      }
      if (strong !== null && totpStep !== null) {
        if (state.last_totp_step != null && totpStep <= Number(state.last_totp_step)) {
          strong = null; // a concurrent request already used this code
        } else {
          // The code is spent the moment it verifies - even if the SC turns out wrong - so it cannot be replayed.
          await tx.query('UPDATE card_auth_state SET last_totp_step = $3 WHERE tenant_id = $1 AND card_id = $2', [tenantId, card.id, totpStep]);
        }
      }

      if (strong === null) {
        if (throttled) {
          // Paused, right SC, wrong code: someone who knows the SC is guessing codes. That counts toward the hard lock.
          if (sc !== null) await this.#countScFailure(tx, card, state, ctx);
          return fail('factor_throttled', card);
        }
        if (body.factor.type === 'totp') await this.#countTotpFailure(tx, card, state, ctx);
        return fail('bad_factor', card);
      }
      // From here on the caller has proved possession of the card's strong factor.
      if (sc === null) {
        await this.#countScFailure(tx, card, state, ctx);
        return fail('bad_sc', card);
      }
      if (state.locked_at !== null) return fail('locked', card);

      const tenant = await getTenant(tx, tenantId);
      if (!tenant || tenant.status !== 'active') return fail('tenant_inactive', card);
      const effective = effectiveState(card, ctx.now);
      if (card.kind !== 'person' || (effective !== 'active' && effective !== 'expired')) return fail('state', card);

      // Would this card be allowed to do anything at all? The policy decision point answers
      // (e.g. no: the card or the company card is past its grace window and this is not an Owner).
      const candidate = await subjectForCard(tx, tenantId, card.id);
      const allowed = candidate
        ? await this.#d.authorizer.decideOnly(tx, candidate, 'self:read', { type: 'session', tenant_id: tenantId, owner_card_id: card.id }, ctx)
        : null;
      if (allowed?.effect !== 'allow') return fail('expired', card);

      // 6. Session. createSession accepts nothing but a VerifiedLogin (strong factor + SC).
      const settings = await getSettings(tx, tenantId);
      const { token, sessionId } = await createSession(tx, new VerifiedLogin(tenantId, strong, sc), ctx, settings, this.#d.hmacKey);
      const session = await resolveSession(tx, token, ctx);
      if (!session) {
        await revokeSession(tx, sessionId, 'card_expired', ctx.now);
        return fail('expired', card);
      }
      // Anomaly rule "second address" (off unless the company switched it on): this successful sign-in came from
      // another network address while a session of the same card was in use. The card locks; this sign-in fails.
      if (await this.#d.anomaly.signedIn(tx, { tenant_id: tenantId, card_id: card.id }, sessionId, ctx)) return fail('locked', card);

      await tx.query(
        `UPDATE card_auth_state SET sc_failed_count = 0, factor_failed_count = 0, factor_window_start = NULL,
                factor_throttle_level = 0, factor_throttled_until = NULL, last_login_at = $3
          WHERE tenant_id = $1 AND card_id = $2`,
        [tenantId, card.id, ctx.now]);
      await tx.query('UPDATE credentials SET last_used_at = $2, webauthn_sign_count = COALESCE($3, webauthn_sign_count) WHERE id = $1', [
        strong.credentialId, ctx.now, newSignCount,
      ]);
      if (scResult.needsRehash) {
        // Pepper rotation: we hold the correct SC for a moment, so re-hash under the current pepper.
        const upgraded = await this.#d.hasher.hash(card.id, body.sc);
        await tx.query(`UPDATE card_secrets SET sc_hash = $3, pepper_id = $4 WHERE tenant_id = $1 AND card_id = $2 AND status = 'current'`, [
          tenantId, card.id, upgraded.hash, upgraded.pepperId,
        ]);
      }
      await this.#recordAttempt(tx, { cardHmac, tenantId, cardId: card.id, ok: true, reason: 'ok' }, ctx);
      await this.#d.cards.event(tx, card, 'login_success', card.id, ctx, { factor_type: strong.factorType }, strong.credentialId);
      await writeAudit(tx, {
        tenantId, actorCardId: card.id, actorKind: 'card', action: 'auth:login', resourceType: 'card', resourceId: card.id,
        decision: 'allow', reasonCode: 'LOGIN_OK', requestId: ctx.requestId, ip: ctx.ip, details: { factor_type: strong.factorType },
      });
      return { token, body: await sessionBody(tx, this.#d.authorizer, session.subject, session.csrfToken, ctx) };
    });

    if (result === null) throw problems.authFailed();
    return { body: result.body, setSessionCookie: result.token };
  }

  async #authState(tx: Tx, card: CardRow, lock: boolean): Promise<AuthStateRow> {
    const read = async (): Promise<AuthStateRow | undefined> => (await tx.query<AuthStateRow>(
      lock
        ? `SELECT sc_failed_count, locked_at, factor_failed_count, factor_window_start, factor_throttle_level, factor_throttled_until,
                  last_totp_step::text AS last_totp_step
             FROM card_auth_state WHERE tenant_id = $1 AND card_id = $2 FOR UPDATE`
        : `SELECT sc_failed_count, locked_at, factor_failed_count, factor_window_start, factor_throttle_level, factor_throttled_until,
                  last_totp_step::text AS last_totp_step
             FROM card_auth_state WHERE tenant_id = $1 AND card_id = $2`,
      [card.tenant_id, card.id])).rows[0];
    const existing = await read();
    if (existing) return existing;
    await tx.query('INSERT INTO card_auth_state (tenant_id, card_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [card.tenant_id, card.id]);
    return (await read()) as AuthStateRow;
  }

  /** Wrong SC after a valid strong factor. At the tenant's threshold (3-5) the card locks. */
  async #countScFailure(tx: Tx, card: CardRow, state: AuthStateRow, ctx: RequestContext): Promise<void> {
    const settings = await getSettings(tx, card.tenant_id);
    const threshold = settings.sc_lockout_threshold;
    // A threshold outside 3-5 cannot come from the database (CHECK constraint); if it somehow does, use the strictest.
    const effective = Number.isInteger(threshold) && threshold >= 3 && threshold <= 5 ? threshold : 3;
    const count = state.sc_failed_count + 1;
    await tx.query('UPDATE card_auth_state SET sc_failed_count = $3 WHERE tenant_id = $1 AND card_id = $2', [card.tenant_id, card.id, count]);
    if (count < effective || state.locked_at !== null) return;
    // The same lock an anomaly rule uses (CardService.lock). Unlike those rules, this one DOES lock the last usable
    // Owner card (Phase 1 decision, unchanged): the secret-code lockout is the brute-force protection, and an
    // exception for the last Owner would let whoever holds that Owner's strong factor try every secret code.
    // Recovery is the operator's (docs/runbooks/owner-recovery.md).
    if (await this.#d.cards.lock(tx, card, { reason: 'sc_attempts', event: 'sc_locked', auditReason: 'CARD_LOCKED_SC_ATTEMPTS', details: { count } }, ctx)) {
      await this.#d.notifier.notify({ type: 'card_locked', tenantId: card.tenant_id, cardId: card.id });
    }
  }

  /** Failed TOTP code. After maxFailures in the window, TOTP for this card pauses (temporary, doubling, capped). */
  async #countTotpFailure(tx: Tx, card: CardRow, state: AuthStateRow, ctx: RequestContext): Promise<void> {
    const { totp } = this.#d.limits;
    const windowOpen = state.factor_window_start !== null && ctx.now.getTime() - state.factor_window_start.getTime() < totp.windowSeconds * 1000;
    const count = windowOpen ? state.factor_failed_count + 1 : 1;
    if (count >= totp.maxFailures) {
      const pause = Math.min(totp.pauseSeconds * 2 ** Math.min(state.factor_throttle_level, 10), totp.maxPauseSeconds);
      await tx.query(
        `UPDATE card_auth_state SET factor_failed_count = 0, factor_window_start = NULL, factor_throttle_level = factor_throttle_level + 1,
                factor_throttled_until = $3 WHERE tenant_id = $1 AND card_id = $2`,
        [card.tenant_id, card.id, new Date(ctx.now.getTime() + pause * 1000)]);
    } else {
      await tx.query(
        'UPDATE card_auth_state SET factor_failed_count = $3, factor_window_start = $4 WHERE tenant_id = $1 AND card_id = $2',
        [card.tenant_id, card.id, count, windowOpen ? state.factor_window_start : ctx.now]);
    }
  }

  // ------------------------------------------------------------ enrollment: begin

  async enrollmentBegin(
    ctx: RequestContext,
    body: { card_number: string; sc: string; enrollment_token: string; factor_type: 'passkey' | 'totp'; label?: string },
  ): Promise<HandlerResult> {
    await this.#enforceLimits(ctx);
    const resolved = await this.#resolveCard(body.card_number);
    const tenantId = resolved?.tenantId ?? PLATFORM_TENANT_ID;
    const cardHmac = this.#cardHmac(normalizeCardNumber(body.card_number) ?? String(body.card_number));

    const response = await this.#d.db.withTenantTx<Record<string, unknown> | null>(tenantId, async (tx) => {
      const card = resolved === null ? null : (await tx.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = $1`, [resolved.cardId])).rows[0] ?? null;
      const secret = card === null ? null : (await tx.query<{ sc_hash: string; pepper_id: string }>(
        `SELECT sc_hash, pepper_id FROM card_secrets WHERE tenant_id = $1 AND card_id = $2 AND status = 'current'`, [tenantId, card.id])).rows[0] ?? null;
      // The enrollment token (256 random bits) is the strong secret for this step.
      const tokenRow = card === null ? null : (await tx.query<{ id: string }>(
        'SELECT id FROM enrollment_tokens WHERE tenant_id = $1 AND card_id = $2 AND token_hash = $3 AND used_at IS NULL AND expires_at > $4',
        [tenantId, card.id, sha256(body.enrollment_token), ctx.now])).rows[0] ?? null;
      const scResult = await this.#d.hasher.verify(card?.id ?? null, body.sc, secret ? { hash: secret.sc_hash, pepperId: secret.pepper_id } : null);

      const fail = async (reason: FailReason): Promise<null> => {
        await this.#recordAttempt(tx, { cardHmac, tenantId: card ? tenantId : null, cardId: card?.id ?? null, ok: false, reason }, ctx);
        if (card) {
          await writeAudit(tx, {
            tenantId, actorKind: 'anonymous', action: 'auth:enroll', resourceType: 'card', resourceId: card.id,
            decision: 'deny', reasonCode: `ENROLL_${reason.toUpperCase()}`, requestId: ctx.requestId, ip: ctx.ip,
          });
        }
        return null;
      };

      if (card === null) return fail('unknown_card');
      if (tokenRow === null) return fail('bad_enrollment_token');
      const state = await this.#authState(tx, card, true);
      if (scResult.proof === null) {
        await this.#countScFailure(tx, card, state, ctx);
        return fail('bad_sc');
      }
      if (state.locked_at !== null) return fail('locked');
      const effective = effectiveState(card, ctx.now);
      if (card.kind !== 'person' || (effective !== 'issued' && effective !== 'active')) return fail('state');
      const settings = await getSettings(tx, tenantId);
      if (!settings.allowed_factor_types.includes(body.factor_type)) return fail('state');

      const token = randomToken(32);
      const payload: Record<string, unknown> = { factor_type: body.factor_type, label: body.label ?? '', enrollment_token_id: tokenRow.id };
      const out: Record<string, unknown> = { enrollment_txn: token, factor_type: body.factor_type };
      let challenge = 'totp';
      if (body.factor_type === 'passkey') {
        const existing = await tx.query<{ webauthn_credential_id: string }>(
          `SELECT webauthn_credential_id FROM credentials WHERE tenant_id = $1 AND card_id = $2 AND type = 'passkey' AND status = 'active'`,
          [tenantId, card.id]);
        const reg = await passkeyRegistrationOptions({
          webauthn: this.#d.webauthn, cardId: card.id, maskedCardNumber: maskCardNumber(card.card_number),
          existingCredentialIds: existing.rows.map((r) => r.webauthn_credential_id),
        });
        challenge = reg.challenge;
        out.webauthn_options = reg.options;
      } else {
        const totp = newTotpSecret(this.#d.webauthn.rpName, maskCardNumber(card.card_number));
        const enc = this.#d.cipher.encrypt(totp.secret, totpAad(tenantId));
        payload.totp_secret_enc = enc.ciphertext.toString('base64');
        payload.totp_key_id = enc.keyId;
        out.totp = { secret: totp.secret, otpauth_uri: totp.uri };
      }
      await tx.query(
        `INSERT INTO auth_transactions (txn_hash, purpose, tenant_id, card_id, challenge, payload, ip_hash, expires_at)
         VALUES ($1, 'enroll', $2, $3, $4, $5, $6, $7)`,
        [sha256(token), tenantId, card.id, challenge, JSON.stringify(payload), hmacSha256(this.#d.hmacKey, `ip:${ctx.ip}`),
          new Date(ctx.now.getTime() + TXN_TTL_SECONDS * 1000)]);
      return out;
    });

    if (response === null) throw problems.authFailed();
    return { body: response };
  }

  // --------------------------------------------------------- enrollment: complete

  async enrollmentComplete(
    ctx: RequestContext, body: { enrollment_txn: string; attestation?: unknown; totp_code?: string },
  ): Promise<HandlerResult> {
    await this.#enforceLimits(ctx);
    const consumed = await this.#d.db.global<{
      tenant_id: string; card_id: string; challenge: string;
      payload: { factor_type: 'passkey' | 'totp'; label: string; enrollment_token_id: string; totp_secret_enc?: string; totp_key_id?: string };
    }>(
      `UPDATE auth_transactions SET consumed_at = $2
        WHERE txn_hash = $1 AND purpose = 'enroll' AND consumed_at IS NULL AND expires_at > $2
        RETURNING tenant_id, card_id, challenge, payload`,
      [sha256(body.enrollment_txn), ctx.now]);
    const txn = consumed.rows[0];
    if (!txn) throw problems.authFailed();

    const ok = await this.#d.db.withTenantTx<boolean>(txn.tenant_id, async (tx) => {
      const card = (await tx.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = $1 FOR UPDATE`, [txn.card_id])).rows[0];
      if (!card) return false;
      const effective = effectiveState(card, ctx.now);
      if (effective !== 'issued' && effective !== 'active') return false;
      // Prove the new factor works FIRST. A mistyped code or a failed passkey ceremony must not
      // use up the 72-hour enrollment token: the person simply starts the enrollment again.
      const reg = txn.payload.factor_type === 'passkey'
        ? await verifyPasskeyRegistration({ webauthn: this.#d.webauthn, attestation: body.attestation, expectedChallenge: txn.challenge })
        : null;
      let totpSecretEnc: Buffer | null = null;
      let totpStep: number | null = null;
      if (txn.payload.factor_type === 'passkey') {
        if (!reg) return false;
      } else {
        if (typeof body.totp_code !== 'string' || !txn.payload.totp_secret_enc || !txn.payload.totp_key_id) return false;
        totpSecretEnc = Buffer.from(txn.payload.totp_secret_enc, 'base64');
        const secret = this.#d.cipher.decrypt(totpSecretEnc, txn.payload.totp_key_id, totpAad(txn.tenant_id));
        if (secret === null) return false;
        totpStep = await verifyTotpEnrollment(secret, body.totp_code, ctx.now);
        if (totpStep === null) return false;
      }

      // Only now is the single-use token claimed, inside the same transaction as the new credential.
      const claimed = await tx.query(
        'UPDATE enrollment_tokens SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2', [txn.payload.enrollment_token_id, ctx.now]);
      if (claimed.rowCount !== 1) return false;

      let credentialId: string;
      if (reg) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO credentials (tenant_id, card_id, type, label, webauthn_credential_id, webauthn_public_key, webauthn_sign_count, webauthn_transports)
           VALUES ($1, $2, 'passkey', $3, $4, $5, $6, $7) ON CONFLICT (webauthn_credential_id) DO NOTHING RETURNING id`,
          [txn.tenant_id, card.id, txn.payload.label, reg.credentialId, reg.publicKey, reg.signCount, reg.transports]);
        // A passkey that is already registered somewhere is refused; throwing rolls the token claim back.
        if (!inserted.rows[0]) throw problems.authFailed();
        credentialId = inserted.rows[0].id;
      } else {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO credentials (tenant_id, card_id, type, label, totp_secret_enc, totp_key_id) VALUES ($1, $2, 'totp', $3, $4, $5) RETURNING id`,
          [txn.tenant_id, card.id, txn.payload.label, totpSecretEnc, txn.payload.totp_key_id]);
        credentialId = (inserted.rows[0] as { id: string }).id;
        // The code just used to enrol cannot be replayed to log in.
        await tx.query(
          `INSERT INTO card_auth_state (tenant_id, card_id, last_totp_step) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, card_id) DO UPDATE SET last_totp_step = EXCLUDED.last_totp_step`,
          [txn.tenant_id, card.id, totpStep]);
      }

      await this.#d.cards.event(tx, card, 'credential_added', card.id, ctx, { factor_type: txn.payload.factor_type }, credentialId);
      await writeAudit(tx, {
        tenantId: txn.tenant_id, actorCardId: card.id, actorKind: 'card', action: 'auth:enroll', resourceType: 'card', resourceId: card.id,
        decision: 'event', reasonCode: 'CREDENTIAL_ADDED', requestId: ctx.requestId, ip: ctx.ip,
        details: { factor_type: txn.payload.factor_type, credential_id: credentialId },
      });
      await this.#d.cards.revokeSessions(tx, card, 'credentials_reset', ctx.now);
      await this.#d.notifier.notify({ type: 'credential_added', tenantId: txn.tenant_id, cardId: card.id });
      if (card.state === 'issued') {
        await tx.query('UPDATE cards SET activated_at = $2 WHERE id = $1', [card.id, ctx.now]);
        await this.#d.cards.transition(tx, { ...card, activated_at: ctx.now }, 'active', 'activated', card.id, ctx);
      } else if (card.activated_at === null) {
        // A card that expired before it was ever activated and was then renewed or recovered is
        // 'active' with no activation date. Its first enrolled factor activates it.
        await tx.query('UPDATE cards SET activated_at = $2 WHERE id = $1 AND activated_at IS NULL', [card.id, ctx.now]);
      }
      return true;
    });

    if (!ok) throw problems.authFailed();
    return { status: 204 };
  }
}

/** The Session object of the API contract. */
export async function sessionBody(
  tx: Tx, authorizer: Authorizer, subject: import('../../../shared/policy-types.ts').CardSubject, csrfToken: string, ctx: RequestContext,
): Promise<Record<string, unknown>> {
  const described = await authorizer.describe(tx, subject, ctx);
  return {
    card_id: subject.card_id,
    tenant_id: subject.tenant_id,
    person_id: subject.person_id,
    card_number_masked: maskCardNumber(subject.card_number),
    roles: subject.roles.map((r) => r.role_key),
    permissions: described.permissions,
    card_state: effectiveState({ state: subject.card_state, expires_at: subject.expires_at, grace_until: subject.grace_until }, ctx.now),
    read_only: described.read_only,
    export_only: described.export_only,
    expires_at: subject.expires_at.toISOString(),
    grace_until: subject.grace_until.toISOString(),
    renewal_due: subject.renewal_due.toISOString(),
    session_idle_expires_at: subject.session_idle_expires_at.toISOString(),
    session_absolute_expires_at: subject.session_absolute_expires_at.toISOString(),
    csrf_token: csrfToken,
  };
}
