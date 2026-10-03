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
