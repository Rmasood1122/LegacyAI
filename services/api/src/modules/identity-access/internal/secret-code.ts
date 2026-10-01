// The 3-digit secret code (SC).
//
//   stored = Argon2id( HMAC-SHA-256( pepper[pepper_id], card_id + ":" + SC ), random salt )
//
// Only 1,000 codes exist, so the Argon2 cost alone would not stop someone who stole the
// database. The pepper lives in Secret Manager, never in the database: without it the
// stolen hashes cannot even be tested. The SC is still ONLY a second factor.
import * as argon2 from 'argon2';
import { randomBytes, randomInt } from 'node:crypto';
import { hmacSha256 } from '../../../shared/crypto.ts';
import { ARGON2_FLOOR, type Keyring } from '../../platform/index.ts';

export interface Argon2Params {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  maxConcurrency: number;
}

const MINT = Symbol('ScProof');

/** Proof that the SC of `cardId` was verified. Only SecretCodeHasher.verify can create one. */
export class ScProof {
  readonly cardId: string;
  constructor(key: symbol, cardId: string) {
    if (key !== MINT) throw new Error('ScProof can only be created by verifying a secret code');
    this.cardId = cardId;
    Object.freeze(this);
  }
}

export class SecretCodeHasher {
  readonly #keyring: Keyring;
  readonly #params: Argon2Params;
  #running = 0;
  readonly #waiting: Array<() => void> = [];
  #dummyHash: string | null = null;

  constructor(keyring: Keyring, params: Argon2Params) {
    if (
      !Number.isInteger(params.memoryKiB) || params.memoryKiB < ARGON2_FLOOR.memoryKiB ||
      !Number.isInteger(params.iterations) || params.iterations < ARGON2_FLOOR.iterations ||
      !Number.isInteger(params.parallelism) || params.parallelism < ARGON2_FLOOR.parallelism ||
      !Number.isInteger(params.maxConcurrency) || params.maxConcurrency < 1
    ) {
      throw new Error('Argon2id parameters are below the OWASP minimum (19 MiB, 2 iterations, parallelism 1)');
    }
    if (!keyring.keys.has(keyring.currentId)) throw new Error('SC pepper keyring has no current key');
    this.#keyring = keyring;
    this.#params = params;
  }

  get currentPepperId(): string {
    return this.#keyring.currentId;
  }

  /** A new random SC, "000".."999", from the OS CSPRNG. */
  generate(): string {
    return String(randomInt(0, 1000)).padStart(3, '0');
  }

  /** Caps concurrent hashes so a login burst cannot exhaust container memory. */
  async #limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#params.maxConcurrency) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#running += 1;
    try {
      return await fn();
    } finally {
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }

  #peppered(pepperId: string, cardId: string, sc: string): Buffer | null {
    const key = this.#keyring.keys.get(pepperId);
    if (!key) return null;
    return hmacSha256(key.reveal(), `${cardId}:${sc}`);
  }

  #options(): { type: 2; memoryCost: number; timeCost: number; parallelism: number; raw: false } {
    return {
      type: argon2.argon2id,
      raw: false,
      memoryCost: this.#params.memoryKiB,
      timeCost: this.#params.iterations,
      parallelism: this.#params.parallelism,
    };
  }

  async hash(cardId: string, sc: string): Promise<{ hash: string; pepperId: string }> {
    if (!/^[0-9]{3}$/.test(sc)) throw new Error('secret code must be exactly 3 digits');
    const pepperId = this.#keyring.currentId;
    const input = this.#peppered(pepperId, cardId, sc) as Buffer;
    const hash = await this.#limited(() => argon2.hash(input, this.#options()));
    return { hash, pepperId };
  }

  /**
   * Verifies an SC. ALWAYS performs one Argon2 computation, whatever the inputs, so that
   * "no such card", "unknown pepper" and "wrong code" take about the same time.
   */
  async verify(
    cardId: string | null, sc: string, stored: { hash: string; pepperId: string } | null,
  ): Promise<{ proof: ScProof | null; needsRehash: boolean }> {
    const input = cardId !== null && stored !== null ? this.#peppered(stored.pepperId, cardId, sc) : null;
    if (cardId === null || stored === null || input === null) {
      await this.#dummy(sc);
      return { proof: null, needsRehash: false };
    }
    let ok = false;
    try {
      ok = await this.#limited(() => argon2.verify(stored.hash, input));
    } catch {
      ok = false; // a malformed stored hash must never authenticate
    }
    if (!ok) return { proof: null, needsRehash: false };
    const needsRehash = stored.pepperId !== this.#keyring.currentId || argon2.needsRehash(stored.hash, this.#options());
    return { proof: new ScProof(MINT, cardId), needsRehash };
  }

  async #dummy(sc: string): Promise<void> {
    if (this.#dummyHash === null) {
      const dummyHash = await this.#limited(() => argon2.hash(randomBytes(32), this.#options()));
      this.#dummyHash = dummyHash;
    }
    const hash: string = this.#dummyHash;
    try {
      await this.#limited(() => argon2.verify(hash, Buffer.from(`dummy:${sc}`)));
    } catch {
      // result is irrelevant; only the work matters
    }
  }

  /** Pre-computes the dummy hash so the first unknown-card login is not slower than later ones. */
  async warmUp(): Promise<void> {
    await this.#dummy('000');
  }
}
