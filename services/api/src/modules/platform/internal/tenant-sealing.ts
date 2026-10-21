// Sealing a company's secrets with the platform's key - or, when the company brought its own key (feature 21, D35),
// with a data key of the company's that only the company's key can open. docs/phase4/08-bring-your-own-key.md.
//
// Every place that seals a company's secret asks for that company's sealer (forTenant) and gets the same two calls
// as before (encrypt / decrypt). Which key is used is decided here, once:
//   - no company key: the platform's keyring (as before; key ids are the keyring's ids);
//   - a company key: the company's live data key, unwrapped by the company's key service (key id "company:<version>").
// Decrypting follows the key id stored with the secret, so secrets sealed before the company brought its key keep
// opening with the platform's key, and secrets sealed under an earlier version of the company's data key keep opening
// while the company's key that wrapped it works.
//
// FAIL CLOSED. When the company's key cannot be used (switched off at its key service, deleted, unreachable):
//   - decrypt answers null, exactly as for a damaged value: sign-ins with an authenticator app, webhook signatures
//     and SSO sign-ins of that company stop;
//   - encrypt throws 503 company-key-unavailable: nothing new is sealed with the platform's key instead.
// Unwrapped data keys are kept in memory for at most `cacheSeconds` (default 300): switching the key off takes
// effect within that time, not at once.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { problems } from '../../../shared/errors.ts';
import type { Tx } from './db.ts';
import { KeyUnavailable, type KeyService } from './key-service.ts';
import type { SealingCipher } from './sealing.ts';

/** What every place that seals a company's secret uses. The same shape as SealingCipher. */
export interface Sealer {
  encrypt(plaintext: string, aad: string): { ciphertext: Buffer; keyId: string };
  /** Null (never throws) when the value was altered or its key cannot be used. */
  decrypt(ciphertext: Buffer, keyId: string, aad: string): string | null;
}

const COMPANY_PREFIX = 'company:';
/** The wrapped data key is bound to one version of one company: copied to another row, it does not open. */
const wrapAad = (tenantId: string, version: number): string => `company-data-key:${tenantId}:${version}`;

export interface CompanyKeyRow { version: number; key_ref: string; wrapped_key: Buffer; created_at: Date; retired_at: Date | null }

function aesSeal(key: Buffer, plaintext: string, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

function aesOpen(key: Buffer, sealed: Buffer, aad: string): string | null {
  if (sealed.length < 29) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export type SetKeyOutcome = { version: number | null } | 'bad-ref' | 'unavailable';

export class TenantSealing {
  readonly #platform: SealingCipher;
  readonly #keys: KeyService;
  readonly #cacheMs: number;
  readonly #cache = new Map<string, { at: number; key: Buffer }>();

  constructor(p: { platform: SealingCipher; keys: KeyService; cacheSeconds?: number }) {
    this.#platform = p.platform;
    this.#keys = p.keys;
    this.#cacheMs = (p.cacheSeconds ?? 300) * 1000;
  }

  /** The platform's own sealer: for what belongs to no company yet (an unknown card at sign-in). */
  get platform(): Sealer {
    return this.#platform;
  }

  get keyService(): KeyService['kind'] {
    return this.#keys.kind;
  }

  async #unwrap(tenantId: string, row: CompanyKeyRow): Promise<Buffer | null> {
    const id = `${tenantId}:${row.version}`;
    const hit = this.#cache.get(id);
    if (hit !== undefined && Date.now() - hit.at < this.#cacheMs) return hit.key;
    try {
      const key = await this.#keys.unwrap(row.key_ref, row.wrapped_key, wrapAad(tenantId, row.version));
      if (key.length !== 32) return null;
      if (this.#cacheMs > 0) this.#cache.set(id, { at: Date.now(), key });
      return key;
    } catch (err) {
      this.#cache.delete(id);
      if (err instanceof KeyUnavailable) return null;
      throw err;
    }
  }

  /** The versions of a company's data key, newest first. Read in the company's own transaction (row-level security). */
  async versions(tx: Tx, tenantId: string): Promise<CompanyKeyRow[]> {
    const { rows } = await tx.query<CompanyKeyRow>(
      'SELECT version, key_ref, wrapped_key, created_at, retired_at FROM company_data_keys WHERE tenant_id = $1 ORDER BY version DESC', [tenantId]);
    return rows;
  }

  /** The sealer of one company, in that company's transaction. */
  async forTenant(tx: Tx, tenantId: string): Promise<Sealer> {
    const rows = await this.versions(tx, tenantId);
    if (rows.length === 0) return this.#platform;
    const keys = new Map<number, Buffer | null>();
    for (const row of rows) keys.set(row.version, await this.#unwrap(tenantId, row));
    const live = rows.find((r) => r.retired_at === null) ?? null;
    const platform = this.#platform;
    return {
      encrypt(plaintext, aad) {
        if (live === null) return platform.encrypt(plaintext, aad);
        const key = keys.get(live.version) ?? null;
        if (key === null) throw problems.companyKeyUnavailable();
        return { ciphertext: aesSeal(key, plaintext, aad), keyId: `${COMPANY_PREFIX}${live.version}` };
      },
      decrypt(ciphertext, keyId, aad) {
        if (!keyId.startsWith(COMPANY_PREFIX)) return platform.decrypt(ciphertext, keyId, aad);
        const version = Number(keyId.slice(COMPANY_PREFIX.length));
        const key = Number.isInteger(version) ? keys.get(version) ?? null : null;
        return key === null ? null : aesOpen(key, ciphertext, aad);
      },
    };
  }

  /**
   * The company brings a key (a reference at the key service), changes to another one, or goes back to none (null).
   * A new data key is made and wrapped with the company's key, and unwrapped again at once to prove the key works -
   * a key that does not is refused before anything is sealed with it. The live version is retired.
   */
  async setKey(tx: Tx, tenantId: string, ref: string | null, now: Date): Promise<SetKeyOutcome> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`company-data-key:${tenantId}`]);
    if (ref !== null && !this.#keys.validRef(ref)) return 'bad-ref';
    let next: { version: number; wrapped: Buffer } | null = null;
    if (ref !== null) {
      const { rows } = await tx.query<{ v: number }>('SELECT coalesce(max(version), 0)::int + 1 AS v FROM company_data_keys WHERE tenant_id = $1', [tenantId]);
      const version = (rows[0] as { v: number }).v;
      const dataKey = randomBytes(32);
      try {
        const wrapped = await this.#keys.wrap(ref, dataKey, wrapAad(tenantId, version));
        const back = await this.#keys.unwrap(ref, wrapped, wrapAad(tenantId, version));
        if (!back.equals(dataKey)) return 'unavailable';
        next = { version, wrapped };
      } catch (err) {
        if (err instanceof KeyUnavailable) return 'unavailable';
        throw err;
      }
    }
    await tx.query('UPDATE company_data_keys SET retired_at = $2 WHERE tenant_id = $1 AND retired_at IS NULL', [tenantId, now]);
    if (next === null) return { version: null };
    await tx.query('INSERT INTO company_data_keys (tenant_id, version, key_ref, wrapped_key, created_at) VALUES ($1, $2, $3, $4, $5)',
      [tenantId, next.version, ref, next.wrapped, now]);
    return { version: next.version };
  }
}
