// Google Cloud KMS as the key service (bring-your-own-key, decision D40; docs/phase4/08-bring-your-own-key.md,
// "Google Cloud KMS"). The company keeps its key in ITS OWN Google Cloud project and lets this installation's service
// account use it (role Cloud KMS CryptoKey Encrypter/Decrypter on that one key). The company can disable or destroy
// the key, or take the permission back, at any time: from then on nothing it sealed opens here.
//
// No Google library: two REST calls (https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.
// cryptoKeys/encrypt and /decrypt, read 2026-10-24), through the platform's guarded HTTPS client:
//   POST https://cloudkms.googleapis.com/v1/<key>:encrypt  { plaintext, additionalAuthenticatedData, *Crc32c }
//   POST https://cloudkms.googleapis.com/v1/<key>:decrypt  { ciphertext, additionalAuthenticatedData, *Crc32c }
// with an OAuth access token of the service account, from the metadata server of Cloud Run (as the audit-anchoring
// job already does). Integrity as Google recommends: we send CRC32C checksums of what we send, KMS says it verified
// them, and we check the checksum of what comes back. Anything that does not add up, any refusal (key disabled or
// destroyed, permission taken back) and any failure to answer is KeyUnavailable: fail closed.
import type { Secret } from './config.ts';
import { KeyUnavailable, LocalKeyService, NoKeyService, type KeyService } from './key-service.ts';
import { httpsRequest, type HttpsOptions } from './outbound.ts';

export const KMS_API = 'https://cloudkms.googleapis.com';
const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** A key (not a key version: KMS encrypts with the key's primary version and finds the version itself on decrypt). */
const KEY_REF = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{1,63}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}$/;

// CRC32C (Castagnoli), the checksum KMS uses. Pure.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32c(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** KMS writes checksums as decimal strings (int64 in JSON). */
const crcText = (data: Buffer): string => String(crc32c(data));

/** An access token for Google APIs, with when it stops being usable. */
export type TokenSource = () => Promise<{ token: string; expiresAt: number }>;

/** The service account's token from the Cloud Run / Compute Engine metadata server (never a key file). */
export const metadataToken: TokenSource = async () => {
  const res = await fetch(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new KeyUnavailable('no access token from the metadata server');
  const body = await res.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || body.access_token === '' || typeof body.expires_in !== 'number') {
    throw new KeyUnavailable('no access token from the metadata server');
  }
  return { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
};

export class GoogleKmsKeyService implements KeyService {
  readonly kind = 'google-kms' as const;
  readonly #tokens: TokenSource;
  readonly #api: string;
  readonly #http: HttpsOptions;
  #cached: { token: string; expiresAt: number } | null = null;

  constructor(deps: { tokens?: TokenSource; /** Tests only: a stand-in for KMS. */ api?: string; http?: Partial<HttpsOptions> } = {}) {
    this.#tokens = deps.tokens ?? metadataToken;
    this.#api = deps.api ?? KMS_API;
    this.#http = { timeoutMs: 5_000, maxBytes: 64 * 1024, ...deps.http };
  }

  validRef(ref: string): boolean {
    return KEY_REF.test(ref);
  }

  async #token(): Promise<string> {
    // a minute of margin: a token that runs out during a call would fail it
    if (this.#cached !== null && this.#cached.expiresAt - 60_000 > Date.now()) return this.#cached.token;
    try {
      this.#cached = await this.#tokens();
    } catch {
      throw new KeyUnavailable('no access token for the key service');
    }
    return this.#cached.token;
  }

  async #call(ref: string, verb: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, unknown>> {
    if (!this.validRef(ref)) throw new KeyUnavailable('not a Cloud KMS key reference');
    const res = await httpsRequest({
      url: `${this.#api}/v1/${ref}:${verb}`, method: 'POST',
      headers: { authorization: `Bearer ${await this.#token()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    }, this.#http);
    if (!res.ok) throw new KeyUnavailable(`the key service did not answer (${res.error})`);
    if (res.status === 401) this.#cached = null;   // the next call fetches a new token
    // 403: permission taken back; 400 FAILED_PRECONDITION: key version disabled or destroyed; 404: no such key. Only the
    // status is named: Google's message can carry project and key names.
    if (res.status !== 200) throw new KeyUnavailable(`the key service refused (HTTP ${res.status})`);
    try {
      return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new KeyUnavailable('the key service gave an unreadable answer');
    }
  }

  async wrap(ref: string, dataKey: Buffer, aad: string): Promise<Buffer> {
    const aadBytes = Buffer.from(aad, 'utf8');
    const out = await this.#call(ref, 'encrypt', {
      plaintext: dataKey.toString('base64'), plaintextCrc32c: crcText(dataKey),
      additionalAuthenticatedData: aadBytes.toString('base64'), additionalAuthenticatedDataCrc32c: crcText(aadBytes),
    });
    if (out.verifiedPlaintextCrc32c !== true || out.verifiedAdditionalAuthenticatedDataCrc32c !== true) throw new KeyUnavailable('the key service did not verify the request');
    if (typeof out.ciphertext !== 'string') throw new KeyUnavailable('the key service gave an unreadable answer');
    const ciphertext = Buffer.from(out.ciphertext, 'base64');
    if (out.ciphertextCrc32c !== crcText(ciphertext)) throw new KeyUnavailable('the answer of the key service was damaged on the way');
    return ciphertext;
  }

  async unwrap(ref: string, wrapped: Buffer, aad: string): Promise<Buffer> {
    const aadBytes = Buffer.from(aad, 'utf8');
    const out = await this.#call(ref, 'decrypt', {
      ciphertext: wrapped.toString('base64'), ciphertextCrc32c: crcText(wrapped),
      additionalAuthenticatedData: aadBytes.toString('base64'), additionalAuthenticatedDataCrc32c: crcText(aadBytes),
    });
    if (typeof out.plaintext !== 'string') throw new KeyUnavailable('the key service gave an unreadable answer');
    const plaintext = Buffer.from(out.plaintext, 'base64');
    if (out.plaintextCrc32c !== crcText(plaintext)) throw new KeyUnavailable('the answer of the key service was damaged on the way');
    return plaintext;
  }
}

/** The key service the configuration names (KEY_SERVICE). */
export function keyServiceFrom(config: { kind: KeyService['kind']; localKeys: ReadonlyMap<string, Secret<Buffer>> }): KeyService {
  if (config.kind === 'local') return new LocalKeyService(config.localKeys);
  if (config.kind === 'google-kms') return new GoogleKmsKeyService();
  return new NoKeyService();
}
