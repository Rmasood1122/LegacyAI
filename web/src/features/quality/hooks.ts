// Answer quality and conflicts: reading them, without any markup.
import { useApiList, useApiQuery } from '../../api/context.tsx';
import type { KQualityWeek } from '../../api/generated.ts';

export const WEEKS_SHOWN = 8;

/** Weekly counts from the answer log and from readers' feedback, newest week first. */
export const useQualitySummary = () => useApiQuery('getQualitySummary', { query: { weeks: WEEKS_SHOWN } });
/** What readers said about answers, newest first, a page at a time. */
export const useAnswerFeedback = ({ wrongOnly }: { wrongOnly: boolean }) =>
  useApiList('listAnswerFeedback', { query: { limit: 25, ...(wrongOnly ? { verdict: 'wrong' as const } : {}) } });
/** Open review tasks of one kind (the review queue, narrowed), a page at a time. */
export const useOpenTasks = (kind: 'item_conflict' | 'stale_item') => useApiList('listReviewTasks', { query: { status: 'open', kind, limit: 50 } });

/** "12 of 40 (30 %)" - a share is only shown with the numbers it was made from. */
export function share(part: number, whole: number): string {
  return whole === 0 ? `${part} of 0` : `${part} of ${whole} (${Math.round((100 * part) / whole)} %)`;
}

type Counts = Omit<KQualityWeek, 'week_start'>;
// Every counter of a week, once. The compiler checks this list against the contract in both directions: a counter that
// is missing here, or one the contract no longer has, does not compile.
const COUNTERS = {
  questions: 0, answered: 0, search_only: 0, dont_know: 0, dont_know_no_relevant_sources: 0, dont_know_not_grounded: 0, dont_know_low_confidence: 0,
  dont_know_sources_conflict: 0, conflicts_found_by_value_check: 0, conflicts_found_by_ai_model: 0, citations_removed: 0,
  answers_naming_an_unknown_source: 0, answers_containing_unverified_sources: 0, feedback_helpful: 0, feedback_unhelpful: 0, feedback_wrong: 0,
} satisfies Counts;

/** The sum of the weeks shown, for the line above the table. */
export function totals(weeks: readonly KQualityWeek[]): Counts {
  const sum: Counts = { ...COUNTERS };
  for (const week of weeks) {
    for (const name of Object.keys(COUNTERS) as Array<keyof Counts>) sum[name] += week[name];
  }
  return sum;
}
