// The offline pack on this device (feature 9, decision D42): stored locked, opened only within its 7 days.
//
// What it does:
//   - the pack is encrypted (AES-GCM) with a key made for it on this device. The browser keeps that key and never
//     hands its bytes to any script (non-extractable); the stored pack is unreadable without it. Removing the pack
//     removes the key with it.
//   - the card that took the pack, when it was made and until when it may be opened are stored beside it and bound
//     to it (they are the "additional data" of the encryption): changing any of them makes the pack fail to open.
//   - a pack is refused, and removed, from its expiry on, by the device's clock.
//   - a pack is also refused (and kept) while the device's clock is behind the last time it was opened here, or behind
//     the moment it was made: setting the clock back cannot stop its 7 days from running out. Setting the clock right
//     opens it again.
//   - a pack that claims more than 7 days is refused when it is saved.
//
// What it does not do (docs/phase4/09-batch-c-prepared.md, feature 9): it does not stop a person who opens the pack
// from copying what is shown, or someone in control of the unlocked device from using the browser's key; and a clock
// set back before the pack is next opened, but not behind its last opening, cannot be told from a correct one.
import type { KOfflinePack } from '../api/generated.ts';

export type OfflinePack = KOfflinePack;
export type OfflineItem = OfflinePack['items'][number];

/** How long a pack may be opened: the API's 7 days. A pack that claims longer is refused. */
export const PACK_DAYS = 7;
const DAY_MS = 86_400_000;
/** The clocks of the server and the device may differ a little. */
export const CLOCK_SLACK_MS = 5 * 60_000;
const FORMAT = 1;

/** The record kept on the device. Only these dates and the card id are readable; everything else is sealed. */
export interface StoredPack {
  v: typeof FORMAT;
  card_id: string;
  as_of: string;
  expires_at: string;
  /** The latest time this pack was opened here (ISO). Only ever moves forward. */
  last_seen: string;
  key: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  sealed: ArrayBuffer;
}

/** Where the record is kept: IndexedDB in the browser (storage.ts), memory in tests. */
export interface PackStorage {
  read(): Promise<StoredPack | null>;
  write(pack: StoredPack): Promise<void>;
  remove(): Promise<void>;
}

export type Opened =
  | { state: 'none' }
  | { state: 'expired'; expiresAt: string }
  | { state: 'unreadable' }
  /** The device's clock is behind the last opening (or the moment the pack was made): set it right to open the pack. */
  | { state: 'clock_behind'; notBefore: string }
  | { state: 'open'; pack: OfflinePack; cardId: string; asOf: string; expiresAt: string };

export interface OfflineStoreDeps {
  storage: PackStorage;
  subtle: SubtleCrypto;
  randomBytes: (length: number) => Uint8Array<ArrayBuffer>;
  now: () => number;
}

export class PackRefused extends Error {}

const additionalData = (p: Pick<StoredPack, 'v' | 'card_id' | 'as_of' | 'expires_at'>): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(JSON.stringify([p.v, p.card_id, p.as_of, p.expires_at]));

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NaN : t;
};

export class OfflineStore {
  readonly #d: OfflineStoreDeps;

  constructor(deps: OfflineStoreDeps) {
    this.#d = deps;
  }

  /** Locks the pack with a new key and keeps it, replacing any pack kept before. */
  async save(cardId: string, pack: OfflinePack): Promise<void> {
    const asOf = time(pack.as_of);
    const expiresAt = time(pack.expires_at);
    if (Number.isNaN(asOf) || Number.isNaN(expiresAt) || expiresAt <= asOf || expiresAt - asOf > PACK_DAYS * DAY_MS + CLOCK_SLACK_MS) {
      throw new PackRefused(`The pack's dates are not valid (it may be opened for at most ${PACK_DAYS} days).`);
    }
    const now = this.#d.now();
    if (now >= expiresAt) throw new PackRefused('The pack has already expired by this device\'s clock.');
    const key = await this.#d.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = this.#d.randomBytes(12);
    const head = { v: FORMAT, card_id: cardId, as_of: pack.as_of, expires_at: pack.expires_at } as const;
    const sealed = await this.#d.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(head) }, key,
      new TextEncoder().encode(JSON.stringify(pack)));
    await this.#d.storage.write({ ...head, last_seen: new Date(Math.max(now, asOf)).toISOString(), key, iv, sealed });
  }

  /** The card that took the kept pack, without opening it; null when there is none. */
  async cardOfPack(): Promise<string | null> {
    return (await this.#d.storage.read())?.card_id ?? null;
  }

  /** Opens the kept pack if it may still be opened. An expired or damaged pack is removed. */
  async open(): Promise<Opened> {
    const stored = await this.#d.storage.read();
    if (stored === null) return { state: 'none' };
    const asOf = time(stored.as_of);
    const expiresAt = time(stored.expires_at);
    const lastSeen = time(stored.last_seen);
    if (stored.v !== FORMAT || [asOf, expiresAt, lastSeen].some(Number.isNaN) || expiresAt - asOf > PACK_DAYS * DAY_MS + CLOCK_SLACK_MS) {
      await this.remove();
      return { state: 'unreadable' };
    }
    const now = this.#d.now();
    if (now >= expiresAt) {
      await this.remove();
      return { state: 'expired', expiresAt: stored.expires_at };
    }
    const notBefore = Math.max(asOf, lastSeen);
    if (now < notBefore - CLOCK_SLACK_MS) return { state: 'clock_behind', notBefore: new Date(notBefore).toISOString() };
    let pack: OfflinePack;
    try {
      const plain = await this.#d.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, additionalData: additionalData(stored) }, stored.key, stored.sealed);
      pack = JSON.parse(new TextDecoder().decode(plain)) as OfflinePack;
    } catch {
      await this.remove();
      return { state: 'unreadable' };
    }
    if (now > lastSeen) await this.#d.storage.write({ ...stored, last_seen: new Date(now).toISOString() });
    return { state: 'open', pack, cardId: stored.card_id, asOf: stored.as_of, expiresAt: stored.expires_at };
  }

  /** Removes the pack and its key from this device. */
  async remove(): Promise<void> {
    await this.#d.storage.remove();
  }

  /** Keeps the pack only if the given card took it (null = nobody is signed in: removed). */
  async keepOnlyFor(cardId: string | null): Promise<boolean> {
    const holder = await this.cardOfPack();
    if (holder === null || holder === cardId) return false;
    await this.remove();
    return true;
  }
}

/** A storage that keeps the record in memory, for tests. */
export class MemoryPackStorage implements PackStorage {
  record: StoredPack | null = null;
  read = async (): Promise<StoredPack | null> => this.record;
  write = async (pack: StoredPack): Promise<void> => {
    this.record = pack;
  };
  remove = async (): Promise<void> => {
    this.record = null;
  };
}
