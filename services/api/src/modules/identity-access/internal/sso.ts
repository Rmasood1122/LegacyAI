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
// The web application keeps no storage; everything that matters is in the database, under single-use hashed tokens.
// Every failure is one answer: 401.
//
// TWO ATTACKS THIS IS BUILT AGAINST (found by review before the first push):
//   - "mix-up": every company has its own provider, and one of them may be hostile. If all companies shared one return
//     address, a hostile company's provider could pass a person's code from THEIR company's provider into a flow of
//     its own, and receive that code at its token endpoint. So each company has its OWN return address
//     (.../sso/return/<company id>), registered at its provider; a provider sends codes only to the address registered
//     for it; and finish refuses a code that came back to another company's address than the flow's. When the
//     provider says who it is (RFC 9207 `iss`), that must be the flow's issuer too.
//   - a flow finished in another browser (someone hands a person a link to a provider sign-in that the attacker
//     started, so that the person's identity lands in the attacker's step): start sets an HttpOnly cookie in the
//     browser that started; finish requires the same cookie.
import { hmacSha256, isUuid, randomToken, sha256 } from '../../../shared/crypto.ts';
import { getSettings, urlProblem, type Database, type TenantSealing, type Tx } from '../../platform/index.ts';
import type { SsoIdentity } from './factors.ts';
import { authorizationUrl, exchangeCode, newFlowSecrets, OidcError, type OidcCache } from './oidc.ts';
import { issuerSetupProblem, providerKind, rulesFor, type IssuerSetupProblem } from './providers.ts';

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
  /** Google only: the company's Google Workspace domain; every ID token must carry it (providers.ts). */
  allowed_domain: string | null;
  enabled: boolean;
  has_secret: boolean;
  created_by_card_id: string;
  created_at: Date;
  updated_at: Date;
  removed_at: Date | null;
}

const CONNECTION_COLUMNS = `id, tenant_id, name, issuer, client_id, allowed_domain, enabled, client_secret_enc IS NOT NULL AS has_secret, created_by_card_id,
  created_at, updated_at, removed_at`;

export function toApiConnection(row: ConnectionRow, redirectUri: string): Record<string, unknown> {
  return {
    id: row.id, name: row.name, protocol: 'oidc', provider: providerKind(row.issuer), issuer: row.issuer, client_id: row.client_id,
    allowed_domain: row.allowed_domain, enabled: row.enabled, has_client_secret: row.has_secret,
    redirect_uri: redirectUri, created_by_card_id: row.created_by_card_id, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

export interface ConnectionInput {
  name: string;
  issuer: string;
  client_id: string;
  /** Required when the connection is made; left out = keep the stored one. */
  client_secret?: string;
  /** Google only (required there): the company's Google Workspace domain. Left out = keep the stored one. */
  allowed_domain?: string | null;
  enabled?: boolean;
}

export type ConnectionProblem = 'issuer-changed' | 'secret-required' | 'bad-issuer' | IssuerSetupProblem | 'domain-required' | 'domain-only-google';

/**
 * The issuer as a provider writes it, and an address the server may call: https on port 443, a public host name (no
 * address literal, no internal name), no credentials, no query, no fragment. Pure. (The same address rules as a
 * webhook endpoint: otherwise an Owner could make the server knock on any port of any machine.)
 */
export function issuerProblem(issuer: string): boolean {
  if (urlProblem(issuer) !== null) return true;
  try {
    return new URL(issuer).search !== '';
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
  /** sha256 of the cookie set in the browser that started (hex) */
  browser_hash: string;
}

export class SsoService {
  readonly #sealing: TenantSealing;
  readonly #cache: OidcCache;
  readonly #redirectBase: string;
  readonly #hmacKey: Buffer;

  constructor(p: { sealing: TenantSealing; cache: OidcCache; redirectUri: string; hmacKey: Buffer }) {
    this.#sealing = p.sealing;
    this.#cache = p.cache;
    this.#redirectBase = p.redirectUri.replace(/\/+$/, '');
    this.#hmacKey = p.hmacKey;
  }

  /** The company's own return address, to be registered at its provider (see "mix-up" at the top of this file). */
  redirectUriFor(tenantId: string): string {
    return `${this.#redirectBase}/${tenantId}`;
  }

  async get(tx: Tx, tenantId: string): Promise<ConnectionRow | null> {
    const { rows } = await tx.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM sso_connections WHERE tenant_id = $1 AND removed_at IS NULL`, [tenantId]);
    return rows[0] ?? null;
  }

  /** Makes the connection, or changes its name, client id, secret or switch. Another issuer = remove first. */
  async put(tx: Tx, tenantId: string, cardId: string, input: ConnectionInput, now: Date): Promise<ConnectionRow | ConnectionProblem> {
    if (issuerProblem(input.issuer)) return 'bad-issuer';
    const setup = issuerSetupProblem(input.issuer);
    if (setup !== null) return setup;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sso-connection:${tenantId}`]);
    const current = await this.get(tx, tenantId);
    // Google lets in any Google account: the company's domain is required there, and means nothing anywhere else
    const domain = input.allowed_domain === undefined ? current?.allowed_domain ?? null : input.allowed_domain;
    const needsDomain = rulesFor(input.issuer).needsDomain;
    if (needsDomain && domain === null) return 'domain-required';
    if (!needsDomain && domain !== null) return 'domain-only-google';
    if (current === null) {
      if (input.client_secret === undefined) return 'secret-required';
      const { rows: ids } = await tx.query<{ id: string }>('SELECT uuidv7()::text AS id');
      const id = (ids[0] as { id: string }).id;
      const sealed = (await this.#sealing.forTenant(tx, tenantId)).encrypt(input.client_secret, secretAad(tenantId, id));
      const { rows } = await tx.query<ConnectionRow>(
        `INSERT INTO sso_connections (id, tenant_id, name, issuer, client_id, client_secret_enc, secret_key_id, enabled, created_by_card_id, created_at, updated_at,
                                      allowed_domain)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11) RETURNING ${CONNECTION_COLUMNS}`,
        [id, tenantId, input.name, input.issuer, input.client_id, sealed.ciphertext, sealed.keyId, input.enabled ?? false, cardId, now, domain]);
      return rows[0] as ConnectionRow;
    }
    if (current.issuer !== input.issuer) return 'issuer-changed';
    const sealed = input.client_secret === undefined ? null : (await this.#sealing.forTenant(tx, tenantId)).encrypt(input.client_secret, secretAad(tenantId, current.id));
    const { rows } = await tx.query<ConnectionRow>(
      `UPDATE sso_connections SET name = $3, client_id = $4, enabled = coalesce($5, enabled),
              client_secret_enc = coalesce($6, client_secret_enc), secret_key_id = coalesce($7, secret_key_id), updated_at = $8, allowed_domain = $9
        WHERE tenant_id = $1 AND id = $2 RETURNING ${CONNECTION_COLUMNS}`,
      [tenantId, current.id, input.name, input.client_id, input.enabled ?? null, sealed?.ciphertext ?? null, sealed?.keyId ?? null, now, domain]);
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

  /**
   * Where the browser must go to sign in at the provider, and the value of the cookie that binds the flow to this
   * browser - or null (one answer for every refusal).
   */
  async start(db: Database, p: { txn: string; company?: string; ip: string; now: Date }): Promise<{ url: string; browserToken: string } | null> {
    const parent = (await db.global<{ purpose: 'login' | 'enroll'; tenant_id: string | null; payload: { factor_type?: string } | null }>(
      `SELECT purpose, tenant_id, payload FROM auth_transactions WHERE txn_hash = $1 AND purpose IN ('login', 'enroll') AND consumed_at IS NULL AND expires_at > $2`,
      [sha256(p.txn), p.now])).rows[0];
    if (parent === undefined) return null;
    // a set-up that chose another factor has no business at the provider
    if (parent.purpose === 'enroll' && parent.payload?.factor_type !== 'sso') return null;
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
      url = authorizationUrl(discovery, { clientId: connection.client_id, redirectUri: this.redirectUriFor(tenantId), secrets, domain: connection.allowed_domain });
    } catch (err) {
      if (err instanceof OidcError) return null;
      throw err;
    }
    const browserToken = randomToken(32);
    const payload: FlowPayload = {
      connection_id: connection.id, parent_hash: sha256(p.txn).toString('hex'), parent_purpose: parent.purpose, code_verifier: secrets.codeVerifier,
      browser_hash: sha256(browserToken).toString('hex'),
    };
    const until = new Date(p.now.getTime() + SSO_FLOW_TTL_SECONDS * 1000);
    await db.global(
      `INSERT INTO auth_transactions (txn_hash, purpose, tenant_id, card_id, challenge, payload, ip_hash, expires_at)
       VALUES ($1, 'sso', $2, NULL, $3, $4, $5, $6)`,
      [sha256(secrets.state), tenantId, secrets.nonce, JSON.stringify(payload), hmacSha256(this.#hmacKey, `ip:${p.ip}`), until]);
    // the original step must still be there when the person comes back (a provider sign-in with a second factor
    // can take longer than the step's usual 5 minutes): it lives as long as the flow, no longer
    await db.global(
      'UPDATE auth_transactions SET expires_at = greatest(expires_at, $3) WHERE txn_hash = $1 AND purpose = $2 AND consumed_at IS NULL',
      [sha256(p.txn), parent.purpose, until]);
    return { url, browserToken };
  }

  /**
   * The provider sent the browser back: redeem the code once, check the ID token, and swap the original step for a
   * new one of the same kind that carries the identity. Returns the new step's token, or null (one answer).
   */
  async finish(db: Database, p: {
    state: string; code: string; returnedTo: string; iss?: string | undefined; browserToken: string | undefined; ip: string; now: Date;
  }): Promise<{ purpose: 'login' | 'enroll'; txn: string } | null> {
    // only the browser that started (its cookie), and only a code that came back to THIS company's address
    if (typeof p.browserToken !== 'string' || p.browserToken.length < 20 || p.browserToken.length > 100 || !isUuid(p.returnedTo)) return null;
    const flow = (await db.global<{ tenant_id: string; challenge: string; payload: FlowPayload }>(
      `UPDATE auth_transactions SET consumed_at = $2
        WHERE txn_hash = $1 AND purpose = 'sso' AND consumed_at IS NULL AND expires_at > $2
          AND payload->>'browser_hash' = $3 AND tenant_id = $4::uuid
        RETURNING tenant_id, challenge, payload`, [sha256(p.state), p.now, sha256(p.browserToken).toString('hex'), p.returnedTo])).rows[0];
    if (flow === undefined) return null;
    const tenantId = flow.tenant_id;
    const connection = await db.withTenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ issuer: string; client_id: string; allowed_domain: string | null; client_secret_enc: Buffer | null; secret_key_id: string | null }>(
        `SELECT issuer, client_id, allowed_domain, client_secret_enc, secret_key_id FROM sso_connections
          WHERE tenant_id = $1 AND id = $2 AND removed_at IS NULL AND enabled`, [tenantId, flow.payload.connection_id]);
      const row = rows[0];
      if (row === undefined || row.client_secret_enc === null || row.secret_key_id === null) return null;
      // opened with the company's own key when it brought one (D35): switched off there, no SSO sign-in here
      const clientSecret = (await this.#sealing.forTenant(tx, tenantId)).decrypt(row.client_secret_enc, row.secret_key_id, secretAad(tenantId, flow.payload.connection_id));
      return clientSecret === null ? null : { issuer: row.issuer, client_id: row.client_id, allowed_domain: row.allowed_domain, clientSecret };
    });
    if (connection === null) return null;
    // RFC 9207: a provider that names itself on the way back must be the flow's provider
    if (p.iss !== undefined && !rulesFor(connection.issuer).issuers.includes(p.iss)) return null;
    const { clientSecret } = connection;
    let subject: string;
    try {
      ({ subject } = await exchangeCode(this.#cache, {
        issuer: connection.issuer, clientId: connection.client_id, clientSecret, redirectUri: this.redirectUriFor(tenantId), code: p.code,
        codeVerifier: flow.payload.code_verifier, nonce: flow.challenge, now: p.now, domain: connection.allowed_domain,
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
