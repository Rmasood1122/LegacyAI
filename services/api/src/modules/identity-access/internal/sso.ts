// SSO (feature 16, part A): the company's identity-provider connection, and the two public steps of a sign-in there.
// docs/phase4/07-sso-scim.md, decision D33.
//
// HOW A SIGN-IN AT THE PROVIDER FITS THE EXISTING ONES. Signing in and setting up a card both start with a
// short-lived step (auth_transactions, purpose 'login' or 'enroll'). The SSO factor adds a detour:
//   start:  the browser names that step, and - when signing in - the company's short name. The provider is chosen
//           by the COMPANY, never by the card, so the answer cannot tell anyone whether a card number exists. A new
//           step (purpose 'sso') holds the state, the nonce and the PKCE verifier for 10 minutes; the browser goes to
//           the provider.
//   finish: the provider sends the browser back to the web application with a code; the web application hands code
//           and state to the API. The API redeems the code ONCE, checks the ID token, ends the original step and
//           opens a new one of the same kind that carries the identity the provider vouched for. The browser then
//           completes the sign-in (3-digit code + factor 'sso') or the set-up as before.
// Nothing is kept in the browser between the two (the web application keeps no storage); everything that matters
// is in the database, under single-use hashed tokens. Every failure is one answer: 401.
import { randomToken, sha256, hmacSha256 } from '../../../shared/crypto.ts';
import { getSettings, type Database, type SealingCipher, type Tx } from '../../platform/index.ts';
import type { SsoIdentity } from './factors.ts';
import { authorizationUrl, exchangeCode, newFlowSecrets, OidcError, type OidcCache } from './oidc.ts';

/** How long a sign-in at the provider may take, from "start" to "finish". */
export const SSO_FLOW_TTL_SECONDS = 600;
/** How long the step that carries a vouched-for identity stays usable (the person types the 3-digit code). */
export const SSO_CONTINUE_TTL_SECONDS = 300;

export interface ConnectionRow {
  id: string;
  tenant_id: string;
  name: string;
  issuer: string;
  client_id: string;
  enabled: boolean;
  has_secret: boolean;
  created_by_card_id: string;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
}

const CONNECTION_COLUMNS = `id, tenant_id, name, issuer, client_id, enabled, client_secret_enc IS NOT NULL AS has_secret, created_by_card_id,
  created_at, updated_at, removed_at`;

export function toApiConnection(row: ConnectionRow, redirectUri: string): Record<string, unknown> {
  return {
    id: row.id, name: row.name, protocol: 'oidc', issuer: row.issuer, client_id: row.client_id, enabled: row.enabled, has_client_secret: row.has_secret,
    redirect_uri: redirectUri, created_by_card_id: row.created_by_card_id, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

export interface ConnectionInput {
  name: string;
  issuer: string;
  client_id: string;
  /** Required when the connection is made; left out = keep the stored one. */
  client_secret?: string;
  enabled?: boolean;
}

export type ConnectionProblem = 'issuer-changed' | 'secret-required' | 'bad-issuer';

/** The issuer as a provider writes it: https, a host name, no query, no fragment, no credentials. Pure. */
export function issuerProblem(issuer: string): boolean {
  try {
    const u = new URL(issuer);
    return u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '' || issuer.length > 2048;
  } catch {
    return true;
  }
}

/** The client secret is bound to one connection of one company: copied into another row, it does not decrypt. */
const secretAad = (tenantId: string, connectionId: string): string => `sso-client-secret:${tenantId}:${connectionId}`;

interface FlowPayload {
  connection_id: string;
  parent_hash: string;
  parent_purpose: 'login' | 'enroll';
  code_verifier: string;
}

export class SsoService {
  readonly #cipher: SealingCipher;
  readonly #cache: OidcCache;
  readonly #redirectUri: string;
  readonly #hmacKey: Buffer;

  constructor(p: { cipher: SealingCipher; cache: OidcCache; redirectUri: string; hmacKey: Buffer }) {
    this.#cipher = p.cipher;
    this.#cache = p.cache;
    this.#redirectUri = p.redirectUri;
    this.#hmacKey = p.hmacKey;
  }

  get redirectUri(): string {
    return this.#redirectUri;
  }

  async get(tx: Tx, tenantId: string): Promise<ConnectionRow | null> {
    const { rows } = await tx.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM sso_connections WHERE tenant_id = $1 AND removed_at IS NULL`, [tenantId]);
    return rows[0] ?? null;
  }

  /** Makes the connection, or changes its name, client id, secret or switch. Another issuer = remove first. */
  async put(tx: Tx, tenantId: string, cardId: string, input: ConnectionInput, now: Date): Promise<ConnectionRow | ConnectionProblem> {
    if (issuerProblem(input.issuer)) return 'bad-issuer';
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sso-connection:${tenantId}`]);
    const current = await this.get(tx, tenantId);
    if (current === null) {
      if (input.client_secret === undefined) return 'secret-required';
      const { rows: ids } = await tx.query<{ id: string }>('SELECT uuidv7()::text AS id');
      const id = (ids[0] as { id: string }).id;
      const sealed = this.#cipher.encrypt(input.client_secret, secretAad(tenantId, id));
      const { rows } = await tx.query<ConnectionRow>(
        `INSERT INTO sso_connections (id, tenant_id, name, issuer, client_id, client_secret_enc, secret_key_id, enabled, created_by_card_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING ${CONNECTION_COLUMNS}`,
        [id, tenantId, input.name, input.issuer, input.client_id, sealed.ciphertext, sealed.keyId, input.enabled ?? false, cardId, now]);
      return rows[0] as ConnectionRow;
    }
    if (current.issuer !== input.issuer) return 'issuer-changed';
    const sealed = input.client_secret === undefined ? null : this.#cipher.encrypt(input.client_secret, secretAad(tenantId, current.id));
    const { rows } = await tx.query<ConnectionRow>(
      `UPDATE sso_connections SET name = $3, client_id = $4, enabled = coalesce($5, enabled),
              client_secret_enc = coalesce($6, client_secret_enc), secret_key_id = coalesce($7, secret_key_id), updated_at = $8
        WHERE tenant_id = $1 AND id = $2 RETURNING ${CONNECTION_COLUMNS}`,
      [tenantId, current.id, input.name, input.client_id, input.enabled ?? null, sealed?.ciphertext ?? null, sealed?.keyId ?? null, now]);
    return rows[0] as ConnectionRow;
  }

  /**
   * Removed for good: switched off, the secret wiped, every SSO factor linked through it revoked. Returns the cards
   * that held such a factor with the factor's id; the caller ends the sessions opened with each (cards.revokeSessions,
   * the one place that ends sessions) and records it.
   */
  async remove(tx: Tx, tenantId: string, now: Date): Promise<{ connectionId: string; revoked: Array<{ cardId: string; credentialId: string }> } | null> {
    const current = await this.get(tx, tenantId);
    if (current === null) return null;
    const { rows } = await tx.query<{ card_id: string; id: string }>(
      `UPDATE credentials SET status = 'revoked' WHERE tenant_id = $1 AND type = 'sso' AND sso_connection_id = $2 AND status = 'active'
        RETURNING card_id, id`, [tenantId, current.id]);
    await tx.query(
      `UPDATE sso_connections SET removed_at = $3, enabled = false, client_secret_enc = NULL, secret_key_id = NULL, updated_at = $3
        WHERE tenant_id = $1 AND id = $2`, [tenantId, current.id, now]);
    return { connectionId: current.id, revoked: rows.map((r) => ({ cardId: r.card_id, credentialId: r.id })) };
  }

  /** Where the browser must go to sign in at the provider, or null (one answer for every refusal). */
  async start(db: Database, p: { txn: string; company?: string; ip: string; now: Date }): Promise<string | null> {
    const parent = (await db.global<{ purpose: 'login' | 'enroll'; tenant_id: string | null }>(
      `SELECT purpose, tenant_id FROM auth_transactions WHERE txn_hash = $1 AND purpose IN ('login', 'enroll') AND consumed_at IS NULL AND expires_at > $2`,
      [sha256(p.txn), p.now])).rows[0];
    if (parent === undefined) return null;
    let tenantId: string;
    if (parent.purpose === 'login') {
      // decided by the company the person named - never by the card (see the top of this file)
      if (typeof p.company !== 'string' || !/^[a-z0-9-]{3,40}$/.test(p.company)) return null;
      const found = (await db.global<{ tenant_id: string }>('SELECT tenant_id FROM resolve_sso_company($1)', [p.company])).rows[0];
      if (found === undefined) return null;
      tenantId = found.tenant_id;
    } else {
      // setting up: the card is known and its 3-digit code was checked when the step began
      if (parent.tenant_id === null) return null;
      tenantId = parent.tenant_id;
    }
    const connection = await db.withTenantTx(tenantId, async (tx) => {
      const row = await this.get(tx, tenantId);
      if (row === null || !row.enabled) return null;
      const settings = await getSettings(tx, tenantId);
      return settings.allowed_factor_types.includes('sso') ? row : null;
    });
    if (connection === null) return null;
    let url: string;
    const secrets = newFlowSecrets();
    try {
      const discovery = await this.#cache.discovery(connection.issuer, p.now.getTime());
      url = authorizationUrl(discovery, { clientId: connection.client_id, redirectUri: this.#redirectUri, secrets });
    } catch (err) {
      if (err instanceof OidcError) return null;
      throw err;
    }
    const payload: FlowPayload = { connection_id: connection.id, parent_hash: sha256(p.txn).toString('hex'), parent_purpose: parent.purpose, code_verifier: secrets.codeVerifier };
    await db.global(
      `INSERT INTO auth_transactions (txn_hash, purpose, tenant_id, card_id, challenge, payload, ip_hash, expires_at)
       VALUES ($1, 'sso', $2, NULL, $3, $4, $5, $6)`,
      [sha256(secrets.state), tenantId, secrets.nonce, JSON.stringify(payload), hmacSha256(this.#hmacKey, `ip:${p.ip}`),
        new Date(p.now.getTime() + SSO_FLOW_TTL_SECONDS * 1000)]);
    return url;
  }

  /**
   * The provider sent the browser back: redeem the code once, check the ID token, and swap the original step for a
   * new one of the same kind that carries the identity. Returns the new step's token, or null (one answer).
   */
  async finish(db: Database, p: { state: string; code: string; ip: string; now: Date }): Promise<{ purpose: 'login' | 'enroll'; txn: string } | null> {
    const flow = (await db.global<{ tenant_id: string; challenge: string; payload: FlowPayload }>(
      `UPDATE auth_transactions SET consumed_at = $2
        WHERE txn_hash = $1 AND purpose = 'sso' AND consumed_at IS NULL AND expires_at > $2
        RETURNING tenant_id, challenge, payload`, [sha256(p.state), p.now])).rows[0];
    if (flow === undefined) return null;
    const tenantId = flow.tenant_id;
    const connection = await db.withTenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ issuer: string; client_id: string; client_secret_enc: Buffer | null; secret_key_id: string | null }>(
        `SELECT issuer, client_id, client_secret_enc, secret_key_id FROM sso_connections
          WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL AND enabled`, [tenantId, flow.payload.connection_id]);
      return rows[0] ?? null;
    });
    if (connection === null || connection.client_secret_enc === null || connection.secret_key_id === null) return null;
    const clientSecret = this.#cipher.decrypt(connection.client_secret_enc, connection.secret_key_id, secretAad(tenantId, flow.payload.connection_id));
    if (clientSecret === null) return null;
    let subject: string;
    try {
      ({ subject } = await exchangeCode(this.#cache, {
        issuer: connection.issuer, clientId: connection.client_id, clientSecret, redirectUri: this.#redirectUri, code: p.code,
        codeVerifier: flow.payload.code_verifier, nonce: flow.challenge, now: p.now,
      }));
    } catch (err) {
      if (err instanceof OidcError) return null;
      throw err;
    }
    const identity: SsoIdentity = { tenantId, connectionId: flow.payload.connection_id, subject };
    const next = randomToken(32);
    // the original step ends here and a new one carries the identity: one statement, so it happens once
    const swapped = await db.global<{ id: string }>(
      `WITH old AS (
         UPDATE auth_transactions SET consumed_at = $3
          WHERE txn_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > $3
          RETURNING purpose, tenant_id, card_id, challenge, payload)
       INSERT INTO auth_transactions (txn_hash, purpose, tenant_id, card_id, challenge, payload, ip_hash, expires_at)
       SELECT $4, purpose, tenant_id, card_id, challenge, payload || jsonb_build_object('sso', $5::jsonb), $6, $7 FROM old
       RETURNING id`,
      [Buffer.from(flow.payload.parent_hash, 'hex'), flow.payload.parent_purpose, p.now, sha256(next), JSON.stringify(identity),
        hmacSha256(this.#hmacKey, `ip:${p.ip}`), new Date(p.now.getTime() + SSO_CONTINUE_TTL_SECONDS * 1000)]);
    if (swapped.rows.length !== 1) return null;
    return { purpose: flow.payload.parent_purpose, txn: next };
  }
}

/** The identity a step carries, if a provider vouched for one in it. Pure: what is stored is checked again here. */
export function ssoIdentityOf(payload: unknown): SsoIdentity | null {
  const sso = (payload as { sso?: unknown } | null)?.sso as Record<string, unknown> | undefined;
  if (sso === undefined || sso === null || typeof sso !== 'object') return null;
  const { tenantId, connectionId, subject } = sso;
  return typeof tenantId === 'string' && typeof connectionId === 'string' && typeof subject === 'string' ? { tenantId, connectionId, subject } : null;
}
