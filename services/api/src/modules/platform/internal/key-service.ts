// Bring-your-own-key (feature 21; docs/phase4/08-bring-your-own-key.md, decision D35): the service that holds a
// company's OWN encryption key. The API never sees that key. It asks the service to wrap (encrypt) and unwrap a
// data key of the company's, and the company can stop that at any time at its key service: from then on, what was
// sealed with the company's data key cannot be read.
//
// Adapters:
//   none  - no company can bring a key (the default);
//   local - keys from the configuration (LOCAL_KEY_SERVICE_KEYS), a stand-in for tests and development only. A key can
//           be switched off here (disable) as a company would switch its key off at a real service.
// A real key service (for example Google Cloud KMS) is one more adapter with the same two calls.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Secret } from './config.ts';

/** The company's key cannot be used right now: switched off, deleted, unknown, or the service cannot be reached. */
export class KeyUnavailable extends Error {
  constructor(reason: string) {
    super(`company key unavailable: ${reason}`);
  }
}

export interface KeyService {
  readonly kind: 'none' | 'local';
  /** Could this be a key reference of this service? (Its form only: whether the key works is learned by using it.) */
  validRef(ref: string): boolean;
  /** Encrypts a data key with the company's key. `aad` binds it to one company and one version. */
  wrap(ref: string, dataKey: Buffer, aad: string): Promise<Buffer>;
  /** The data key back. Throws KeyUnavailable when the company's key cannot be used. */
  unwrap(ref: string, wrapped: Buffer, aad: string): Promise<Buffer>;
}

export class NoKeyService implements KeyService {
  readonly kind = 'none' as const;
  validRef(_ref: string): boolean {
    return false;
  }
  async wrap(): Promise<Buffer> {
    throw new KeyUnavailable('no key service is configured (KEY_SERVICE=none)');
  }
  async unwrap(): Promise<Buffer> {
    throw new KeyUnavailable('no key service is configured (KEY_SERVICE=none)');
  }
}

const LOCAL_REF = /^local:([a-z0-9-]{1,40})$/;

/** The stand-in. AES-256-GCM, output nonce | tag | ciphertext, like the platform's own sealing. */
export class LocalKeyService implements KeyService {
  readonly kind = 'local' as const;
  readonly #keys: ReadonlyMap<string, Secret<Buffer>>;
  readonly #off = new Set<string>();

  constructor(keys: ReadonlyMap<string, Secret<Buffer>>) {
    this.#keys = keys;
  }

  validRef(ref: string): boolean {
    return LOCAL_REF.test(ref);
  }

  /** As a company switching its key off (or back on) at its key service. For tests and demonstrations. */
  disable(name: string): void {
    this.#off.add(name);
  }
  enable(name: string): void {
    this.#off.delete(name);
  }

  #key(ref: string): Buffer {
    const name = LOCAL_REF.exec(ref)?.[1];
    if (name === undefined) throw new KeyUnavailable('not a local key reference');
    const key = this.#keys.get(name);
    if (key === undefined) throw new KeyUnavailable('unknown key');
    if (this.#off.has(name)) throw new KeyUnavailable('the key is switched off');
    return key.reveal();
  }

  async wrap(ref: string, dataKey: Buffer, aad: string): Promise<Buffer> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key(ref), nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]);
  }

  async unwrap(ref: string, wrapped: Buffer, aad: string): Promise<Buffer> {
    const key = this.#key(ref);
    if (wrapped.length < 29) throw new KeyUnavailable('not a wrapped key');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(wrapped.subarray(12, 28));
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]);
    } catch {
      throw new KeyUnavailable('the wrapped key does not open with this key');
    }
  }
}

export function keyServiceFrom(config: { kind: 'none' | 'local'; localKeys: ReadonlyMap<string, Secret<Buffer>> }): KeyService {
  return config.kind === 'local' ? new LocalKeyService(config.localKeys) : new NoKeyService();
}
