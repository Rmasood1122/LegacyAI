// Knowledge items: reading and changing them, without any markup.
import { useApiList, useApiMutation, useApiQuery } from '../../api/context.tsx';
import type { OperationTypes } from '../../api/generated.ts';
import type { BadgeTone } from '../../ui/index.tsx';

export type ItemStatusFilter = NonNullable<NonNullable<OperationTypes['listKnowledgeItems']['query']>['status']>;
export const STATUS_FILTERS: readonly ItemStatusFilter[] = ['candidate', 'in_review', 'verified', 'corrected', 'rejected', 'stale'];

const REFRESH = ['listKnowledgeItems', 'getKnowledgeItem', 'listReviewTasks', 'listMyContributions'] as const;

/** The items the card may read, a page at a time (`hasMore` / `loadMore`). No status = every state. */
export const useKnowledgeItemList = ({ status, mineOnly = false }: { status?: ItemStatusFilter; mineOnly?: boolean }) =>
  useApiList('listKnowledgeItems', { query: { limit: 50, ...(status === undefined ? {} : { status }), ...(mineOnly ? { mine: true } : {}) } });
export const useKnowledgeItem = (itemId: string) => useApiQuery('getKnowledgeItem', { path: { item_id: itemId } });
export const useCreateItem = () => useApiMutation('createKnowledgeItem', REFRESH);
export const useSubmitItem = () => useApiMutation('submitKnowledgeItem', REFRESH);
export const useVerifyItem = () => useApiMutation('verifyKnowledgeItem', REFRESH);
export const useRejectItem = () => useApiMutation('rejectKnowledgeItem', REFRESH);
export const useReopenItem = () => useApiMutation('reopenKnowledgeItem', REFRESH);
/** A correction is a new version of the item (the contract calls it proposeItemVersion). */
export const useCorrectItem = () => useApiMutation('proposeItemVersion', REFRESH);

/** Topics in use, to choose from when linking an item (a page at a time). */
export const useTopicChoices = () => useApiList('listTopics', { query: { status: 'active', limit: 50 } });
/** Replaces the item's topics. The gap report and the question bank depend on the links, so they are re-read too. */
export const useSetItemTopics = () => useApiMutation('setItemTopics', [...REFRESH, 'getGapReport', 'listQuizQuestions']);
/** The API's own limit (maxItems of topic_ids). */
export const MAX_TOPICS_PER_ITEM = 20;

/** Where in a document an item comes from: " — page 3", " — pages 3–4", or for a recording " — minute 2", " — minutes 2–3". Pure. */
export function placeInSource(p: { page_from: number | null; page_to: number | null; unit: 'page' | 'minute' }): string {
  if (p.page_from === null) return '';
  const range = p.page_to !== null && p.page_to !== p.page_from;
  return ` — ${p.unit}${range ? 's' : ''} ${p.page_from}${range ? `–${p.page_to}` : ''}`;
}

/** What each state means to a reader: only "verified" and "corrected" have been checked by a person. */
export const itemTone = (status: string): BadgeTone =>
  status === 'verified' || status === 'corrected' ? 'success' : status === 'rejected' ? 'danger' : status === 'withdrawn' || status === 'retired' ? 'neutral' : 'warning';

export const ITEM_STATUS_TEXT: Readonly<Record<string, string>> = {
  candidate: 'Draft — not yet sent for review',
  in_review: 'Waiting for a reviewer',
  verified: 'Verified by a reviewer',
  corrected: 'Corrected and verified by a reviewer',
  rejected: 'Rejected by a reviewer',
  stale: 'Verified long ago — needs a fresh look',
  withdrawn: 'Withdrawn',
  retired: 'Retired',
};
