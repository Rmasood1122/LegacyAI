// Searching the offline copy without a connection. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { searchPack } from './search.ts';
import type { OfflinePack } from './store.ts';

const item = (id: string, title: string, body: string, topic_ids: string[]) =>
  ({ id, title, body, status: 'verified' as const, sensitivity: 0, verified_at: null, topic_ids });
const pack: OfflinePack = {
  job_role: 'Boiler operator', as_of: '2026-10-27T10:00:00Z', expires_at: '2026-11-03T10:00:00Z', max_sensitivity: 1, truncated: false,
  topics: [{ topic_id: 'valves', name: 'Relief valves' }, { topic_id: 'water', name: 'Boiler water' }],
  items: [
    item('a', 'Blowdown', 'Blow down the boiler for ten seconds each shift. Check the valve after.', ['water']),
    item('b', 'Relief valve check', 'Lift the lever monthly until steam escapes.', ['valves']),
    item('c', 'Water treatment', 'Dose the chemicals as the café supplier says.', ['water']),
  ],
};
const ids = (q: string, topicId?: string) => searchPack(pack, { query: q, topicId }).map((i) => i.id);

describe('searching the offline copy', () => {
  it('with no words, lists everything by title', () => {
    expect(ids('')).toEqual(['a', 'b', 'c']);
  });
  it('every word must appear; a word in the title ranks higher', () => {
    expect(ids('valve')).toEqual(['b', 'a']);
    expect(ids('valve monthly')).toEqual(['b']);
    expect(ids('valve nowhere')).toEqual([]);
  });
  it('ignores case and accents, and finds topic names', () => {
    expect(ids('CAFE')).toEqual(['c']);
    expect(ids('relief valves lever')).toEqual(['b']);
    expect(ids('boiler water dose')).toEqual(['c']);
  });
  it('can be narrowed to one topic', () => {
    expect(ids('', 'water')).toEqual(['a', 'c']);
    expect(ids('valve', 'water')).toEqual(['a']);
  });
});
