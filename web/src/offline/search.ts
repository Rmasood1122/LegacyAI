// Searching the offline pack, on the device, without the AI service: plain word matching over titles, texts and topic
// names. Every word of the search must appear (in any order, ignoring case and accents); titles count more.
import type { OfflineItem, OfflinePack } from './store.ts';

const fold = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
const words = (query: string): string[] => fold(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w !== '');

export interface SearchOptions {
  query: string;
  /** Only items linked to this topic; undefined = all. */
  topicId?: string;
}

/** The pack's items that match, best first; with no words, all of them by title. */
export function searchPack(pack: OfflinePack, { query, topicId }: SearchOptions): OfflineItem[] {
  const topicNames = new Map(pack.topics.map((t) => [t.topic_id, fold(t.name)]));
  const wanted = words(query);
  const scored: Array<{ item: OfflineItem; score: number }> = [];
  for (const item of pack.items) {
    if (topicId !== undefined && !item.topic_ids.includes(topicId)) continue;
    const title = fold(item.title);
    const rest = `${fold(item.body)} ${item.topic_ids.map((id) => topicNames.get(id) ?? '').join(' ')}`;
    let score = 0;
    let all = true;
    for (const w of wanted) {
      const inTitle = title.includes(w);
      if (!inTitle && !rest.includes(w)) {
        all = false;
        break;
      }
      score += inTitle ? 3 : 1;
    }
    if (all) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .map((s) => s.item);
}
