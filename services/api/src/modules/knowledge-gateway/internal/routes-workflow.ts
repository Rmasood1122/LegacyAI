// Interviews (feature 7), topics and gaps (10), ask-the-expert (15), readiness tests (13).
import { problems } from '../../../shared/errors.ts';
import type { ResourceRef } from '../../../shared/policy-types.ts';
import { decodeCursor, encodeCursor, writeAudit, type RouteDef, type Tx } from '../../platform/index.ts';
import { baseClaims, gatewayRoute, pick, uuidOrNull, withListFilter, type GatewayDeps } from './common.ts';
import {
  attemptRef, collectionRef, expertQuestionRef, interviewRef, itemRef, newRef, quizItemRef, sourceRef, topicRef,
} from './resources.ts';

const INTERVIEW_COLUMNS = 'id, expert_person_id, job_role, status, turn_count, max_turns, created_at, last_turn_at, completed_at';
const INTERVIEW_DESCRIPTOR = { type: 'interview', tenantExpr: 'interviews.tenant_id', ownerPersonExpr: 'interviews.expert_person_id' };
const TOPIC_DESCRIPTOR = { type: 'topic', tenantExpr: 'topics.tenant_id', departmentExpr: 'topics.department_id', sensitivityExpr: 'topics.sensitivity' };
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

interface TopicRow { id: string; name: string; description: string; department_id: string | null; sensitivity: number; origin: string; status: string; created_at: Date }
const toApiTopic = (r: TopicRow): Record<string, unknown> => ({
  id: r.id, name: r.name, description: r.description, department_id: r.department_id, sensitivity: r.sensitivity, origin: r.origin,
  status: r.status, created_at: r.created_at.toISOString(),
});

async function mustTopic(tx: Tx, tenantId: string, id: string): Promise<TopicRow> {
  const { rows } = await tx.query<TopicRow>(
    'SELECT id, name, description, department_id, sensitivity, origin, status, created_at FROM topics WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!rows[0]) throw problems.notFound();
  return rows[0];
}

export function workflowRoutes(deps: GatewayDeps): RouteDef[] {
  const { authorizer, ai } = deps;
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
        const after = decodeCursor(query.cursor);
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

    // ------------------------------------------------------------------ gaps and topics
    withListFilter('delegated', gatewayRoute(deps, 'getGapReport',
      async ({ subject }) => collectionRef('gap', subject.tenant_id),
      async ({ query }) => ({
        // Counted with what THIS viewer may read: the report is computed for whoever looks at it. The AI service applies
        // the viewer's knowledge:read filter to BOTH the topics and the items it counts (services/ai/app/capture/gaps.py).
        path: '/internal/gaps', action: 'gap.report', filterAction: 'knowledge:read', json: { job_role: query.job_role },
        map: (r) => ({
          job_role: r.job_role,
          topics: (r.topics ?? []).map((g: any) => pick(g, ['topic_id', 'name', 'required', 'importance', 'label', 'verified_items', 'contributors'])),
        }),
      }))),
    {
      operationId: 'listTopics',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('topic', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'topic:read', TOPIC_DESCRIPTOR, ctx, 4);
        const { rows } = await tx.query<TopicRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT id, name, description, department_id, sensitivity, origin, status, created_at FROM topics
            WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR id > $2::uuid) AND ${filter.sql} ORDER BY id LIMIT $3`,
          [query.status ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiTopic), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'createTopic',
      kind: 'gateway',
      policy: { resource: async ({ subject, body }) => newRef('topic', subject.tenant_id, { department_id: uuidOrNull(body.department_id), sensitivity: body.sensitivity ?? 0 }) },
      prepare: async ({ tx, subject, decision, ctx, body }) => {
        let topic: TopicRow;
        try {
          const { rows } = await tx.query<TopicRow>(
            `INSERT INTO topics (tenant_id, name, description, department_id, sensitivity, origin, status, created_by_card_id)
             VALUES ($1, $2, $3, $4, $5, 'admin', 'active', $6)
             RETURNING id, name, description, department_id, sensitivity, origin, status, created_at`,
            [subject.tenant_id, body.name, body.description ?? '', body.department_id ?? null, body.sensitivity ?? 0, subject.card_id]);
          topic = rows[0] as TopicRow;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw problems.conflict('duplicate-topic', 'A topic with this name exists');
          throw err;
        }
        const claims = baseClaims(subject, decision, ctx);
        return {
          call: async () => {
            await ai.call({ path: `/internal/topics/${topic.id}/embed`, action: 'topic.embed', subject: topic.id, claims });
            return { status: 201, body: toApiTopic(topic) };
          },
        };
      },
    },
    {
      operationId: 'updateTopic',
      kind: 'gateway',
      policy: { resource: ({ tx, subject, params }) => topicRef(tx, subject.tenant_id, params.topic_id) },
      prepare: async ({ tx, subject, decision, ctx, params, body }) => {
        const before = await mustTopic(tx, subject.tenant_id, params.topic_id);
        if (body.status !== undefined && !(before.status === body.status
            || (before.status === 'proposed' && body.status === 'active') || (before.status === 'active' && body.status === 'retired'))) {
          throw problems.conflict('illegal-transition', 'This topic cannot move to that status');
        }
        try {
          await tx.query('UPDATE topics SET name = COALESCE($3, name), description = COALESCE($4, description), status = COALESCE($5, status) WHERE tenant_id = $1 AND id = $2',
            [subject.tenant_id, params.topic_id, body.name ?? null, body.description ?? null, body.status ?? null]);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw problems.conflict('duplicate-topic', 'A topic with this name exists');
          throw err;
        }
        const after = await mustTopic(tx, subject.tenant_id, params.topic_id);
        const claims = baseClaims(subject, decision, ctx);
        return {
          call: async () => {
            if (after.status === 'active') {
              await ai.call({ path: `/internal/topics/${after.id}/embed`, action: 'topic.embed', subject: after.id, claims });
            }
            return { body: toApiTopic(after) };
          },
        };
      },
    },
    {
      operationId: 'setRoleTopics',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const entries = body.topics as Array<{ topic_id: string; required?: boolean; importance?: number }>;
        await tx.query('DELETE FROM role_topic_maps WHERE tenant_id = $1 AND job_role = $2', [subject.tenant_id, params.job_role]);
        for (const t of entries) {
          await mustTopic(tx, subject.tenant_id, t.topic_id);
          await tx.query(
            `INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance, created_by_card_id) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (tenant_id, job_role, topic_id) DO UPDATE SET required = EXCLUDED.required, importance = EXCLUDED.importance`,
            [subject.tenant_id, params.job_role, t.topic_id, t.required ?? true, t.importance ?? 2, subject.card_id]);
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'topic:role_map', decision: 'event',
          reasonCode: 'ROLE_TOPICS_SET', requestId: ctx.requestId, ip: ctx.ip, details: { count: entries.length },
        });
        return { body: { job_role: params.job_role, topics: entries.map((t) => ({ topic_id: t.topic_id, required: t.required ?? true, importance: t.importance ?? 2 })) } };
      },
    },
    {
      operationId: 'setRolePeople',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const entries = body.people as Array<{ person_id: string; relation: 'holder' | 'successor' }>;
        await tx.query('DELETE FROM person_job_roles WHERE tenant_id = $1 AND job_role = $2', [subject.tenant_id, params.job_role]);
        for (const p of entries) {
          const found = await tx.query('SELECT 1 FROM people WHERE tenant_id = $1 AND id = $2', [subject.tenant_id, p.person_id]);
          if (found.rowCount === 0) throw problems.unprocessable('Unknown person');
          await tx.query('INSERT INTO person_job_roles (tenant_id, person_id, job_role, relation) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [subject.tenant_id, p.person_id, params.job_role, p.relation]);
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'topic:role_people', decision: 'event',
          reasonCode: 'ROLE_PEOPLE_SET', requestId: ctx.requestId, ip: ctx.ip, details: { count: entries.length },
        });
        return { body: { job_role: params.job_role, people: entries } };
      },
    },
    gatewayRoute(deps, 'suggestTopics',
      async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }),
      async ({ tx, subject, body, ctx }) => {
        // The suggestions come from a document: the caller must also be allowed to read it.
        const source = await sourceRef(tx, subject.tenant_id, body.source_id);
        if (!source) throw problems.notFound();
        const d = await authorizer.decideOnly(tx, subject, 'source:read', source, ctx);
        if (d.effect !== 'allow') throw problems.notFound();
        return {
          path: `/internal/topics/suggest/${body.source_id}`, action: 'topic.suggest', subject: body.source_id, ai: true, approved: [body.source_id],
          status: 201, map: (r) => ({ proposed: r.proposed ?? [] }),
        };
      }),

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
        json: { box: query.box ?? 'all', limit: query.limit },
        map: (r) => ({
          items: (r.items ?? []).map((q: any) => pick(q, ['id', 'question', 'expert_person_id', 'status', 'decline_reason', 'answer_item_id', 'created_at', 'answered_at', 'expires_at'])),
          next_cursor: null,
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
        json: { status: query.status ?? null, limit: query.limit, after: decodeCursor(query.cursor) },
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
