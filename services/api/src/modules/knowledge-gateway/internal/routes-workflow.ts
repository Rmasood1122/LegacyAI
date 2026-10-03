// Interviews (feature 7), ask-the-expert (15), readiness tests (13). Topics, job roles and gaps (10) are in routes-topics.ts.
import { problems } from '../../../shared/errors.ts';
import type { ResourceRef } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, type RouteDef, type Tx } from '../../platform/index.ts';
import { gatewayRoute, pick, uuidOrNull, withListFilter, type GatewayDeps } from './common.ts';
import {
  attemptRef, collectionRef, expertQuestionRef, interviewRef, itemRef, newRef, quizItemRef,
} from './resources.ts';
import { topicRoutes } from './routes-topics.ts';

const INTERVIEW_COLUMNS = 'id, expert_person_id, job_role, status, turn_count, max_turns, created_at, last_turn_at, completed_at';
const INTERVIEW_DESCRIPTOR = { type: 'interview', tenantExpr: 'interviews.tenant_id', ownerPersonExpr: 'interviews.expert_person_id' };

// A readiness attempt belongs to the learner who took it (a Successor's quiz:read_results is "own"). The same two
// columns as the AI service's descriptor (services/ai/app/capture/filters.py, "quiz_attempts"): owner_person_id, which
// a CHECK on the table keeps equal to learner_person_id, and the learner's card.
const ATTEMPT_DESCRIPTOR = { type: 'quiz_attempt', tenantExpr: 'a.tenant_id', ownerPersonExpr: 'a.owner_person_id', ownerCardExpr: 'a.learner_card_id' };
const TURN = ['interview_id', 'status', 'next_question', 'turn_count', 'candidate_item_id'] as const;
const MAX_ITEMS_PER_GENERATION = 20;

interface InterviewRow {
  id: string; expert_person_id: string; job_role: string; status: string; turn_count: number; max_turns: number;
  created_at: Date; last_turn_at: Date | null; completed_at: Date | null;
}
const toApiInterview = (r: InterviewRow): Record<string, unknown> => ({
  id: r.id, expert_person_id: r.expert_person_id, job_role: r.job_role, status: r.status, turn_count: r.turn_count, max_turns: r.max_turns,
  created_at: r.created_at.toISOString(), last_turn_at: r.last_turn_at?.toISOString() ?? null, completed_at: r.completed_at?.toISOString() ?? null,
});

export function workflowRoutes(deps: GatewayDeps): RouteDef[] {
  const { authorizer } = deps;
  const interview = ({ tx, subject, params }: { tx: Tx; subject: { tenant_id: string }; params: any }): Promise<ResourceRef | null> =>
    interviewRef(tx, subject.tenant_id, params.interview_id);

  return [
    // ------------------------------------------------------------------ interviews
    gatewayRoute(deps, 'createInterview',
      async ({ subject, body }) => newRef('interview', subject.tenant_id, { owner_person_id: uuidOrNull(body.expert_person_id), sensitivity: 1 }),
      async ({ body }) => ({
        path: '/internal/interviews', action: 'interview.invite', json: { expert_person_id: body.expert_person_id, job_role: body.job_role },
        status: 201, map: (r) => pick(r, ['id', 'status']),
      })),
    {
      operationId: 'listInterviews',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('interview', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'interview:read', INTERVIEW_DESCRIPTOR, ctx, 4);
        const { rows } = await tx.query<InterviewRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${INTERVIEW_COLUMNS} FROM interviews WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR id > $2::uuid)
              AND ${filter.sql} ORDER BY id LIMIT $3`,
          [query.status ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiInterview), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    gatewayRoute(deps, 'getInterview', interview, async ({ params }) => ({
      path: `/internal/interviews/${params.interview_id}/read`, action: 'interview.read', subject: params.interview_id,
      map: (r) => ({
        ...pick(r, ['id', 'expert_person_id', 'job_role', 'status', 'turn_count', 'max_turns', 'created_at', 'last_turn_at', 'completed_at']),
        turns: (r.turns ?? []).map((t: any) => pick(t, ['ordinal', 'topic_id', 'question', 'kind', 'answer', 'answered_at', 'erased'])),
      }),
    })),
    gatewayRoute(deps, 'acceptInterview', interview, async ({ params }) => ({
      path: `/internal/interviews/${params.interview_id}/accept`, action: 'interview.accept', subject: params.interview_id,
      filterAction: 'knowledge:read', ai: true, map: (r) => pick(r, TURN),
    })),
    gatewayRoute(deps, 'answerInterviewTurn', interview, async ({ params, body }) => ({
      path: `/internal/interviews/${params.interview_id}/turns`, action: 'interview.turn', subject: params.interview_id,
      filterAction: 'knowledge:read', ai: true, json: { answer: body.answer }, map: (r) => pick(r, TURN),
    })),
    ...([['pauseInterview', 'paused'], ['resumeInterview', 'active'], ['completeInterview', 'completed']] as const).map(([op, target]) =>
      gatewayRoute(deps, op, interview, async ({ params }) => ({
        path: `/internal/interviews/${params.interview_id}/status`, action: 'interview.status', subject: params.interview_id,
        json: { status: target, by_expert: true }, map: (r) => pick(r, ['id', 'status']),
      }))),

    // gaps, topics and job roles: routes-topics.ts
    ...topicRoutes(deps),

    // ------------------------------------------------------------------ ask-the-expert
    gatewayRoute(deps, 'createExpertQuestion',
      async ({ subject, body }) => newRef('expert_question', subject.tenant_id, {
        owner_person_id: uuidOrNull(body.expert_person_id), owner_card_id: subject.card_id, department_id: uuidOrNull(body.department_id),
        sensitivity: body.sensitivity ?? 1,
      }),
      async ({ body }) => ({
        path: '/internal/expert-questions', action: 'expert_question.create', status: 201,
        json: { expert_person_id: body.expert_person_id, question: body.question, department_id: body.department_id ?? null, sensitivity: body.sensitivity ?? 1 },
        map: (r) => pick(r, ['id', 'status', 'expires_at']),
      })),
    withListFilter('delegated', gatewayRoute(deps, 'listExpertQuestions',
      async ({ subject }) => collectionRef('expert_question', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/expert-questions/list', action: 'expert_question.list', filterAction: 'expert_question:read',
        json: { box: query.box ?? 'all', limit: query.limit, after: decodeIdCursor(query.cursor) },
        map: (r) => ({
          items: (r.items ?? []).map((q: any) => pick(q, ['id', 'question', 'expert_person_id', 'status', 'decline_reason', 'answer_item_id', 'created_at', 'answered_at', 'expires_at'])),
          next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null,
        }),
      }))),
    gatewayRoute(deps, 'replyExpertQuestion',
      ({ tx, subject, params }) => expertQuestionRef(tx, subject.tenant_id, params.question_id),
      async ({ params, body }) => ({
        path: `/internal/expert-questions/${params.question_id}/reply`, action: 'expert_question.reply', subject: params.question_id,
        json: { answer: body.answer, title: body.title ?? '' }, map: (r) => pick(r, ['id', 'status', 'answer_item_id']),
      })),
    gatewayRoute(deps, 'declineExpertQuestion',
      ({ tx, subject, params }) => expertQuestionRef(tx, subject.tenant_id, params.question_id),
      async ({ params, body }) => ({
        path: `/internal/expert-questions/${params.question_id}/decline`, action: 'expert_question.decline', subject: params.question_id,
        json: { reason: body.reason }, map: (r) => pick(r, ['id', 'status']),
      })),

    // ------------------------------------------------------------------ readiness tests
    gatewayRoute(deps, 'generateQuizQuestions',
      async ({ subject }) => newRef('quiz_item', subject.tenant_id, { sensitivity: 0 }),
      async ({ tx, subject, body, ctx }) => {
        const ids = [...new Set(body.item_ids as string[])].slice(0, MAX_ITEMS_PER_GENERATION);
        // Only items this caller may read, verified, and released to learners (docs/phase2/06 §5).
        const approved: string[] = [];
        for (const id of ids) {
          const ref = await itemRef(tx, subject.tenant_id, id);
          if (!ref || ref.sensitivity !== 0 || (ref.status !== 'verified' && ref.status !== 'corrected')) continue;
          if ((await authorizer.decideOnly(tx, subject, 'knowledge:read', ref, ctx)).effect === 'allow') approved.push(id);
        }
        if (approved.length === 0) throw problems.unprocessable('None of these items is verified, released to learners and readable by you');
        return {
          path: '/internal/readiness/generate', action: 'quiz.generate', ai: true, approved, json: { kind: body.kind }, status: 201,
          map: (r) => ({ created: r.created ?? [], refused: (r.refused ?? []).map((x: any) => pick(x, ['item_id', 'reason'])) }),
        };
      }),
    withListFilter('delegated', gatewayRoute(deps, 'listQuizQuestions',
      async ({ subject }) => collectionRef('quiz_item', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/readiness/questions/list', action: 'quiz.list', filterAction: 'quiz:read',
        json: { status: query.status ?? null, limit: query.limit, after: decodeIdCursor(query.cursor) },
        map: (r) => ({
          items: (r.items ?? []).map((q: any) => pick(q, ['id', 'topic_id', 'knowledge_item_id', 'kind', 'stem', 'options', 'correct_option', 'rubric', 'status', 'approved_at', 'created_at'])),
          next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null,
        }),
      }))),
    gatewayRoute(deps, 'editQuizQuestion',
      ({ tx, subject, params }) => quizItemRef(tx, subject.tenant_id, params.question_id),
      async ({ params, body }) => ({
        path: `/internal/readiness/questions/${params.question_id}/edit`, action: 'quiz.edit', subject: params.question_id,
        json: { stem: body.stem, options: body.options ?? null, correct_option: body.correct_option ?? null, rubric: body.rubric ?? null },
        map: (r) => pick(r, ['id', 'status']),
      })),
    ...([['approveQuizQuestion', 'approved'], ['retireQuizQuestion', 'retired']] as const).map(([op, target]) =>
      gatewayRoute(deps, op, ({ tx, subject, params }) => quizItemRef(tx, subject.tenant_id, params.question_id), async ({ params }) => ({
        path: `/internal/readiness/questions/${params.question_id}/status`, action: 'quiz.status', subject: params.question_id,
        json: { status: target }, map: (r) => pick(r, ['id', 'status']),
      }))),
    gatewayRoute(deps, 'startReadinessAttempt',
      async ({ subject }) => newRef('quiz_attempt', subject.tenant_id, { owner_person_id: subject.person_id, owner_card_id: subject.card_id, sensitivity: 0 }),
      async ({ tx, subject, body, ctx }) => {
        // Each question's source item is checked again against THIS learner's permissions.
        const { rows } = await tx.query<{ id: string; knowledge_item_id: string }>(
          `SELECT q.id, q.knowledge_item_id FROM quiz_items q JOIN role_topic_maps m ON m.tenant_id = q.tenant_id AND m.topic_id = q.topic_id
            WHERE q.tenant_id = $1 AND q.status = 'approved' AND m.job_role = $2`, [subject.tenant_id, body.job_role]);
        const approved: string[] = [];
        for (const r of rows) {
          const ref = await itemRef(tx, subject.tenant_id, r.knowledge_item_id);
          if (ref && (await authorizer.decideOnly(tx, subject, 'knowledge:read', ref, ctx)).effect === 'allow') approved.push(r.id);
        }
        if (approved.length === 0) throw problems.unprocessable('There are no approved questions for this job role yet');
        return {
          path: '/internal/readiness/attempts', action: 'quiz.start', approved, json: { job_role: body.job_role }, status: 201,
          map: (r) => ({
            id: r.id, expires_at: r.expires_at,
            questions: (r.questions ?? []).map((q: any) => pick(q, ['position', 'kind', 'stem', 'options'])),
          }),
        };
      }),
    // The tests taken: labels and times only (never questions, answers or scores). A learner's grant is "own", so the
    // filter leaves it only its own attempts; Owner and Admin see the company's.
    {
      operationId: 'listReadinessAttempts',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('quiz_attempt', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const before = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'quiz:read_results', ATTEMPT_DESCRIPTOR, ctx, 4);
        const { rows } = await tx.query<{
          id: string; learner_person_id: string; job_role: string; status: string; started_at: Date; expires_at: Date; submitted_at: Date | null; graded_at: Date | null;
        }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT a.id, a.learner_person_id, a.job_role, a.status, a.started_at, a.expires_at, a.submitted_at, a.graded_at
             FROM quiz_attempts a
            WHERE ($1::uuid IS NULL OR a.learner_person_id = $1::uuid) AND ($2::uuid IS NULL OR a.id < $2::uuid) AND ${filter.sql}
            ORDER BY a.id DESC LIMIT $3`,
          [query.learner_person_id ?? null, before, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return {
          body: {
            items: page.map((a) => ({
              id: a.id, learner_person_id: a.learner_person_id, job_role: a.job_role, status: a.status, started_at: a.started_at.toISOString(),
              expires_at: a.expires_at.toISOString(), submitted_at: a.submitted_at?.toISOString() ?? null, graded_at: a.graded_at?.toISOString() ?? null,
            })),
            next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
          },
        };
      },
    },
    gatewayRoute(deps, 'getReadinessAttempt',
      ({ tx, subject, params }) => attemptRef(tx, subject.tenant_id, params.attempt_id),
      async ({ params }) => ({
        path: `/internal/readiness/attempts/${params.attempt_id}/read`, action: 'quiz.attempt_read', subject: params.attempt_id,
        map: (r) => ({
          ...pick(r, ['id', 'learner_person_id', 'job_role', 'status', 'started_at', 'expires_at', 'submitted_at', 'graded_at', 'bank_size']),
          questions: (r.questions ?? []).map((q: any) => {
            const out = pick(q, ['answer_id', 'position', 'kind', 'stem', 'options', 'chosen_option', 'answer_text', 'final_score', 'decided_by']);
            return q.correct_option !== undefined ? { ...out, correct_option: q.correct_option } : out;
          }),
        }),
      })),
    gatewayRoute(deps, 'saveAttemptAnswer',
      ({ tx, subject, params }) => attemptRef(tx, subject.tenant_id, params.attempt_id),
      async ({ params, body }) => ({
        path: `/internal/readiness/attempts/${params.attempt_id}/answers`, action: 'quiz.answer', subject: params.attempt_id,
        json: { position: body.position, chosen_option: body.chosen_option ?? null, answer_text: body.answer_text ?? null },
        map: (r) => pick(r, ['id', 'position']),
      })),
    gatewayRoute(deps, 'submitReadinessAttempt',
      ({ tx, subject, params }) => attemptRef(tx, subject.tenant_id, params.attempt_id),
      async ({ params }) => ({
        path: `/internal/readiness/attempts/${params.attempt_id}/submit`, action: 'quiz.submit', subject: params.attempt_id, ai: true,
        map: (r) => pick(r, ['id', 'status']),
      })),
    gatewayRoute(deps, 'overrideQuizAnswer',
      async ({ subject, params }) => (/^[0-9a-f-]{36}$/.test(String(params.answer_id))
        ? { type: 'quiz_answer', id: params.answer_id, tenant_id: subject.tenant_id, sensitivity: 0 } : null),
      async ({ params, body }) => ({
        path: `/internal/readiness/answers/${params.answer_id}/override`, action: 'quiz.override', subject: params.answer_id,
        json: { score: body.score }, map: (r) => pick(r, ['id', 'status']),
      })),
    gatewayRoute(deps, 'getReadinessReport',
      ({ tx, subject, params }) => attemptRef(tx, subject.tenant_id, params.attempt_id),
      async ({ params }) => ({
        path: `/internal/readiness/reports/${params.attempt_id}`, action: 'quiz.report', subject: params.attempt_id,
        map: (r) => ({
          ...pick(r, ['attempt_id', 'learner_person_id', 'job_role', 'status', 'started_at', 'submitted_at', 'graded_at', 'bank_size', 'statement']),
          topics: (r.topics ?? []).map((t: any) => pick(t, ['topic_id', 'name', 'score', 'note', 'questions_asked', 'questions_in_bank', 'ai_graded', 'person_graded'])),
          coverage_gaps: (r.coverage_gaps ?? []).map((g: any) => pick(g, ['topic_id', 'name', 'gap'])),
        }),
      })),
  ];
}
