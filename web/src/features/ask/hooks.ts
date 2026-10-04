// Asking, and saying what you think of an answer: reading and changing, without any markup.
import { useApiMutation, useApiQuery } from '../../api/context.tsx';

/** What a change of opinion makes stale: the company's counts, the readers' feedback and the review queue. */
const OPINION_CHANGED = ['getQualitySummary', 'listAnswerFeedback', 'listReviewTasks', 'getAnswerFeedback'] as const;

export const useAsk = () => useApiMutation('askKnowledge');
/** Give or replace the reader's opinion of one answer (the whole opinion is replaced). */
export const usePutFeedback = () => useApiMutation('putAnswerFeedback', OPINION_CHANGED);
/** The opinion this card gave on an answer earlier, if any (the API answers "not found" when there is none). */
export const useMyFeedback = (answerId: string, { enabled }: { enabled: boolean }) =>
  useApiQuery('getAnswerFeedback', { path: { knowledge_answer_id: answerId } }, { enabled });
/** Take the opinion back. */
export const useWithdrawFeedback = () => useApiMutation('withdrawAnswerFeedback', OPINION_CHANGED);

/** Said in one place, shown wherever conflicts are listed: an empty list is not a promise that the sources agree. */
export const VALUE_CHECK_LIMITS =
  'The comparison reads numbers with units, intervals, counts and plain must / must-not sentences in English. It does not catch '
  + 'contradictions in ordinary prose, so sources can still disagree when nothing is listed here.';
