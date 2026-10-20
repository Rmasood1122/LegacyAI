// Authenticated encryption of small secrets at rest (AES-256-GCM) with a keyring from the configuration.
// Used for authenticator-app seeds (identity module) and webhook signing secrets (webhooks module): both have to be
// read again later, so a hash would not do. The `aad` binds a ciphertext to the row it belongs to, so a value copied
// into another row does not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Keyring } from './config.ts';

/** AES-256-GCM. Output layout: 12-byte nonce | 16-byte tag | ciphertext. */
export class SealingCipher {
  readonly #keyring: Keyring;
  constructor(keyring: Keyring) {
    if (!keyring.keys.has(keyring.currentId)) throw new Error('credential encryption keyring has no current key');
    this.#keyring = keyring;
  }
  encrypt(plaintext: string, aad: string): { ciphertext: Buffer; keyId: string } {
    const key = (this.#keyring.keys.get(this.#keyring.currentId) as NonNullable<ReturnType<Keyring['keys']['get']>>).reveal();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]), keyId: this.#keyring.currentId };
  }
  /** Returns null (never throws) if the key is unknown or the data was altered. */
  decrypt(ciphertext: Buffer, keyId: string, aad: string): string | null {
    const key = this.#keyring.keys.get(keyId);
    if (!key || ciphertext.length < 29) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key.reveal(), ciphertext.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(ciphertext.subarray(12, 28));
      return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
