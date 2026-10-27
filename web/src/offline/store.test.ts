// The offline copy on the device (feature 9, D42): locked, bound to its card and dates, refused from its expiry on,
// and not extended by setting the device's clock back. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { memoryOfflineStore } from '../test/harness.tsx';
import { PackRefused, type MemoryPackStorage, type OfflinePack, type StoredPack } from './store.ts';

const DAY = 86_400_000;
const AS_OF = Date.parse('2026-10-27T10:00:00Z');
const CARD = '01a10174-0000-7000-8000-000000000001';
const SECRET = 'Lift the relief valve lever monthly until steam escapes.';

const makePack = (days = 7): OfflinePack => ({
  job_role: 'Boiler operator', as_of: new Date(AS_OF).toISOString(), expires_at: new Date(AS_OF + days * DAY).toISOString(), max_sensitivity: 1,
  topics: [{ topic_id: 't1', name: 'Relief valves' }], truncated: false,
  items: [{ id: 'i1', title: 'Relief valve check', body: SECRET, status: 'verified', sensitivity: 0, verified_at: new Date(AS_OF).toISOString(), topic_ids: ['t1'] }],
});

const kept = (storage: MemoryPackStorage): StoredPack => {
  if (storage.record === null) throw new Error('no copy is kept');
  return storage.record;
};

async function saved(now = AS_OF + 60_000) {
  const offline = memoryOfflineStore({ now });
  await offline.store.save(CARD, makePack());
  return offline;
}

describe('the offline copy on the device', () => {
  it('is kept locked: nothing of its content is readable in what is stored, and the key cannot be taken out', async () => {
    const { store, storage } = await saved();
    const record = kept(storage);
    const stored = new TextDecoder().decode(new Uint8Array(record.sealed));
    expect(stored).not.toContain('Relief valve');
    expect(stored).not.toContain('Boiler operator');
    expect(JSON.stringify({ ...record, key: undefined, sealed: undefined })).not.toContain('Relief');
    expect(record.key.extractable).toBe(false);
    expect(record.key.algorithm.name).toBe('AES-GCM');
    const opened = await store.open();
    expect(opened.state).toBe('open');
    if (opened.state === 'open') expect(opened.pack.items[0]?.body).toBe(SECRET);
  });

  it('every copy has its own key and its own random start value', async () => {
    const a = await saved();
    const b = await saved();
    expect(kept(a.storage).key).not.toBe(kept(b.storage).key);
    expect(kept(a.storage).iv).not.toEqual(kept(b.storage).iv);
  });

  it('opens until its expiry, and from its expiry on is refused and removed', async () => {
    const { store, storage, clock } = await saved();
    clock.now = AS_OF + 7 * DAY - 1;
    expect((await store.open()).state).toBe('open');
    clock.now = AS_OF + 7 * DAY;
    expect(await store.open()).toEqual({ state: 'expired', expiresAt: makePack().expires_at });
    expect(storage.record).toBeNull();
    expect(await store.open()).toEqual({ state: 'none' });
  });

  it('with the clock set back behind its last opening it is refused (and kept) until the clock is right', async () => {
    const { store, storage, clock } = await saved();
    clock.now = AS_OF + 6 * DAY;
    expect((await store.open()).state).toBe('open');
    clock.now = AS_OF + 1 * DAY;                     // set back five days
    expect(await store.open()).toEqual({ state: 'clock_behind', notBefore: new Date(AS_OF + 6 * DAY).toISOString() });
    expect(storage.record).not.toBeNull();
    clock.now = AS_OF + 6 * DAY - 60_000;            // within the 5 minutes two clocks may differ
    expect((await store.open()).state).toBe('open');
    clock.now = AS_OF + 7 * DAY;                     // the clock set right, at the expiry
    expect((await store.open()).state).toBe('expired');
  });

  it('a clock behind the moment the copy was made is refused too', async () => {
    const { store, clock } = await saved();
    clock.now = AS_OF - 30 * DAY;
    expect((await store.open()).state).toBe('clock_behind');
  });

  it('changing the stored card, dates or locked content makes it fail to open, and it is removed', async () => {
    for (const change of [
      (r: Record<string, unknown>) => { r.expires_at = new Date(AS_OF + 6 * DAY).toISOString(); },   // shorter is still a change
      (r: Record<string, unknown>) => { r.card_id = '01a10174-0000-7000-8000-0000000000ff'; },
      (r: Record<string, unknown>) => { r.as_of = new Date(AS_OF - 3_600_000).toISOString(); },
      (r: Record<string, unknown>) => { const b = new Uint8Array((r.sealed as ArrayBuffer).slice(0)); b[0] = (b[0] ?? 0) ^ 1; r.sealed = b.buffer; },
    ]) {
      const { store, storage } = await saved();
      change(storage.record as unknown as Record<string, unknown>);
      expect(await store.open()).toEqual({ state: 'unreadable' });
      expect(storage.record).toBeNull();
    }
  });

  it('an expiry moved later than 7 days is refused, whether stored or offered', async () => {
    const { store, storage } = await saved();
    kept(storage).expires_at = new Date(AS_OF + 30 * DAY).toISOString();
    expect(await store.open()).toEqual({ state: 'unreadable' });
    const fresh = memoryOfflineStore({ now: AS_OF });
    await expect(fresh.store.save(CARD, makePack(8))).rejects.toBeInstanceOf(PackRefused);
    await expect(fresh.store.save(CARD, { ...makePack(), expires_at: 'not a date' })).rejects.toBeInstanceOf(PackRefused);
    expect(fresh.storage.record).toBeNull();
  });

  it('a copy already expired by the device\'s clock is not kept', async () => {
    const offline = memoryOfflineStore({ now: AS_OF + 8 * DAY });
    await expect(offline.store.save(CARD, makePack())).rejects.toBeInstanceOf(PackRefused);
    expect(offline.storage.record).toBeNull();
  });

  it('belongs to the card that took it: kept for that card, removed for another card or for nobody', async () => {
    const { store, storage } = await saved();
    expect(await store.keepOnlyFor(CARD)).toBe(false);
    expect(storage.record).not.toBeNull();
    expect(await store.keepOnlyFor('01a10174-0000-7000-8000-0000000000ff')).toBe(true);
    expect(storage.record).toBeNull();
    const again = await saved();
    expect(await again.store.keepOnlyFor(null)).toBe(true);
    expect(again.storage.record).toBeNull();
  });
});
