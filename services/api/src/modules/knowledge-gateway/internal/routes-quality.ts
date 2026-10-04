// Answer quality monitor (feature 22): what readers say about an answer, and weekly counts from the answer log.
// The answer log and the feedback belong to the AI service; the API decides and passes the request on
// (docs/phase4/01-contradiction-staleness-quality.md, decision D25).
import { decodeIdCursor, encodeCursor, type RouteDef } from '../../platform/index.ts';
import { gatewayRoute, pick, withListFilter, type GatewayDeps } from './common.ts';
import { collectionRef, newRef } from './resources.ts';
import type { Subject } from '../../../shared/policy-types.ts';

// The weekly counters, in the words of the contract (KQualityWeek). The AI service owns the list (quality.py,
// ANSWER_COUNTERS and FEEDBACK_COUNTERS); a name that is missing there comes out as null and fails response validation.
const WEEK = [
  'week_start', 'questions', 'answered', 'search_only', 'dont_know', 'dont_know_no_relevant_sources', 'dont_know_not_grounded',
  'dont_know_low_confidence', 'dont_know_sources_conflict', 'conflicts_found_by_value_check', 'conflicts_found_by_ai_model', 'citations_removed',
  'answers_naming_an_unknown_source', 'answers_containing_unverified_sources', 'feedback_helpful', 'feedback_unhelpful', 'feedback_wrong',
] as const;
const FEEDBACK = [
  'id', 'answer_id', 'verdict', 'comment', 'question_shared', 'question', 'created_at', 'outcome', 'reason', 'confidence', 'contains_unverified_sources',
] as const;

// Both are declared "unfiltered" (decision D23): there is one company-wide answer, so a card holding the permission
// at a narrower scope - no role does today - is refused rather than given the company's data.
const COUNTS = { unfiltered: 'Counts for the whole company; they cannot be narrowed to a department or a person.' };
// This one returns CONTENT, not counts: what readers of every department wrote, and the question an answer was for
// where its reader chose to share it. Whoever is granted knowledge_settings:read can read all of it; widening that
// permission widens this (decision D25).
const EVERY_READERS_FEEDBACK = {
  unfiltered: 'Readers\' opinions and comments from every department, and the questions readers chose to share; not narrowed by department or sensitivity.',
};

/** Feedback is about an answer the card itself received: the AI service answers "not found" for anyone else's. */
const ownAnswer = async ({ subject }: { subject: Subject }) =>
  newRef('answer', subject.tenant_id, { owner_card_id: subject.card_id, owner_person_id: subject.person_id ?? undefined, sensitivity: 0 });
const feedback = (r: any) => pick(r, FEEDBACK);

export function qualityRoutes(deps: GatewayDeps): RouteDef[] {
  return [
    // The permission is the one that let the card ask. PUT replaces the whole opinion (a comment left out is removed).
    gatewayRoute(deps, 'putAnswerFeedback', ownAnswer, async ({ params, body }) => ({
      path: `/internal/answers/${params.knowledge_answer_id}/feedback`, action: 'answer.feedback', subject: params.knowledge_answer_id,
      json: { verdict: body.verdict, comment: body.comment ?? null, share_question: body.share_question === true }, map: feedback,
    })),
    gatewayRoute(deps, 'getAnswerFeedback', ownAnswer, async ({ params }) => ({
      path: `/internal/answers/${params.knowledge_answer_id}/feedback/read`, action: 'answer.feedback_read', subject: params.knowledge_answer_id,
      map: feedback,
    })),
    gatewayRoute(deps, 'withdrawAnswerFeedback', ownAnswer, async ({ params }) => ({
      path: `/internal/answers/${params.knowledge_answer_id}/feedback/withdraw`, action: 'answer.feedback_withdraw',
      subject: params.knowledge_answer_id, status: 204, map: () => undefined,
    })),
    withListFilter(COUNTS, gatewayRoute(deps, 'getQualitySummary',
      async ({ subject }) => collectionRef('quality', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/quality/summary', action: 'quality.summary', json: { weeks: query.weeks ?? 8 },
        map: (r) => ({
          weeks: (r.weeks ?? []).map((w: any) => pick(w, WEEK)),
          kept_for_days: r.kept_for_days,
          waiting_for_review: pick(r.waiting_for_review, ['item_conflicts', 'stale_items', 'answers_marked_wrong']),
        }),
      }))),
    withListFilter(EVERY_READERS_FEEDBACK, gatewayRoute(deps, 'listAnswerFeedback',
      async ({ subject }) => collectionRef('quality', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/quality/feedback/list', action: 'quality.feedback',
        json: { verdict: query.verdict ?? null, limit: query.limit, cursor: decodeIdCursor(query.cursor) },
        map: (r) => ({ items: (r.items ?? []).map(feedback), next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null }),
      }))),
  ];
}
