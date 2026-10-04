// Scenario replay (feature 8; docs/phase4/04-scenario-replay.md). A scenario is written and approved by reviewers
// (quiz:manage, quiz:read), run by learners (quiz:take), and its results are read like readiness results
// (quiz:read_results) and overridden like readiness grades (quiz:grade). No permission was added (decision D28).
//
// The texts live with the AI service. This file decides who may act, and tells the AI service - in the token's
// "approved" list - which ids it checked against THE CALLER: item ids when a scenario is written, scenario ids when
// scenarios are offered or started, readable item ids when a result is read.
import { isUuid } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';
import type { ApprovalRef, RequestContext, ResourceRef, CardSubject } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, type RouteDef, type Tx } from '../../platform/index.ts';
import { approvalRoute, gatewayRoute, pick, withListFilter, type GatewayDeps } from './common.ts';
import { collectionRef, itemRef, newRef } from './resources.ts';

/** How many approved scenarios are examined for one learner (each needs its linked items checked against that learner). */
const MAX_OFFERS_EXAMINED = 200;
const SUMMARY = ['id', 'title', 'job_role', 'status', 'flag_reason', 'written_by_me', 'created_at', 'updated_at', 'approved_at'] as const;

type ScenarioRef = ResourceRef & { status: string; updated_at: string; writers: NonNullable<ResourceRef['not_by']> };

/**
 * A scenario as the policy sees it. Its labels follow its linked items (the database keeps them: the highest level,
 * a department only if all items share one), so a reader who may not read an item does not get the scenario either.
 * A scenario is HIDDEN - it does not exist for anybody - while any linked item is withdrawn and still linked
 * (scenario_is_hidden() in the database; the link goes when the erasure step has run, which a legal hold suspends).
 */
async function scenarioRef(tx: Tx, tenantId: string, id: unknown): Promise<ScenarioRef | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<{
    id: string; department_id: string | null; sensitivity: number; owner_person_id: string | null; author_card_id: string;
    created_by_person_id: string | null; created_by_card_id: string; status: string; updated_at: Date;
  }>(
    `SELECT id, department_id, sensitivity, owner_person_id, author_card_id, created_by_person_id, created_by_card_id, status, updated_at
       FROM scenarios WHERE tenant_id = $1 AND id = $2 AND NOT scenario_is_hidden(tenant_id, id)`, [tenantId, id]);
  const r = rows[0];
  if (!r) return null;
  return {
    type: 'scenario', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity, owner_person_id: r.owner_person_id,
    status: r.status, updated_at: r.updated_at.toISOString(),
    // who created it and who wrote its current text: neither may approve it (the policy decides and records the refusal)
    writers: { person_ids: [r.owner_person_id, r.created_by_person_id], card_ids: [r.author_card_id, r.created_by_card_id] },
  };
}

/** For approval: the same scenario, with the people who may not approve it named to the policy. */
const forApproval = (ref: ScenarioRef | null): ApprovalRef | null => (ref === null ? null : { ...ref, approval: true, not_by: ref.writers });

/** A step as long as nothing is released: the question and the learner's own words. Never a score or an expected point. */
const runningStep = (s: any): Record<string, unknown> => ({
  ...pick(s, ['answer_id', 'position', 'prompt', 'answer_text']),
  ...(s?.details_removed === true ? { details_removed: true } : {}),
});
/** Adds the scores of a GRADED run. */
const withScores = (step: Record<string, unknown>, s: any): Record<string, unknown> => ({
  ...step, final_score: typeof s.final_score === 'number' ? s.final_score : null, decided_by: s.decided_by ?? null,
  graded_with_low_confidence: s.graded_with_low_confidence === true,
});
/** Adds the expected points and "read these" of a GRADED run whose points were released to this reader. */
const withPoints = (step: Record<string, unknown>, s: any): Record<string, unknown> => ({
  ...step,
  read_these: Array.isArray(s.read_these) ? s.read_these.map((i: any) => pick(i, ['id', 'title'])) : [],
  points: Array.isArray(s.points) ? s.points.map((p: any) => ({ text: String(p.text ?? ''), met: typeof p.met === 'boolean' ? p.met : null })) : [],
});

/**
 * The steps of a run as the API passes them on. This is the API's OWN rule, not a copy of what the AI service sent:
 * scores only when the run is `graded` AND the AI service says in so many words that it released them
 * (`scores_released === true`); expected points and "read these" only when, in addition, `points_released === true`.
 * A run that is in progress, expired, waiting for a person, or in a state this code does not know gets the question
 * and the learner's own words only - even if the answer from the AI service contains more. Pure; unit-tested.
 */
export function runSteps(run: any): Array<Record<string, unknown>> {
  const steps: any[] = Array.isArray(run?.steps) ? run.steps : [];
  const scores = run?.status === 'graded' && run?.scores_released === true;
  const points = scores && run?.points_released === true;
  return steps.map((s) => {
    const base = runningStep(s);
    if (!scores) return base;
    return points ? withPoints(withScores(base, s), s) : withScores(base, s);
  });
}

/**
 * One answer of a run, for the people who grade (quiz:grade). It carries the level and department of its scenario,
 * so a grader below that level is refused by the policy; a hidden scenario's answers do not exist.
 */
async function answerRef(tx: Tx, tenantId: string, id: unknown): Promise<ResourceRef | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<{ id: string; sensitivity: number; department_id: string | null }>(
    `SELECT an.id, sc.sensitivity, sc.department_id
       FROM scenario_answers an JOIN scenario_attempts a ON a.tenant_id = an.tenant_id AND a.id = an.attempt_id
       JOIN scenarios sc ON sc.tenant_id = a.tenant_id AND sc.id = a.scenario_id
      WHERE an.tenant_id = $1 AND an.id = $2 AND NOT scenario_is_hidden(sc.tenant_id, sc.id)`, [tenantId, id]);
  const r = rows[0];
  return r ? { type: 'scenario_answer', id: r.id, tenant_id: tenantId, sensitivity: r.sensitivity, department_id: r.department_id } : null;
}

/**
 * A run belongs to the learner who started it (a Successor's quiz:read_results is "own"), like a readiness attempt.
 * It carries the CURRENT level of its scenario: if a linked item was re-labelled above what the learner may read,
 * the learner can no longer read, answer or hand in the run (the database has also ended it).
 */
async function runRef(tx: Tx, tenantId: string, id: unknown): Promise<(ResourceRef & { scenario_id: string }) | null> {
  if (!isUuid(id)) return null;
  const { rows } = await tx.query<{ id: string; scenario_id: string; learner_person_id: string; learner_card_id: string; sensitivity: number }>(
    `SELECT a.id, a.scenario_id, a.learner_person_id, a.learner_card_id, sc.sensitivity
       FROM scenario_attempts a JOIN scenarios sc ON sc.tenant_id = a.tenant_id AND sc.id = a.scenario_id
      WHERE a.tenant_id = $1 AND a.id = $2 AND NOT scenario_is_hidden(sc.tenant_id, sc.id)`, [tenantId, id]);
  const r = rows[0];
  if (!r) return null;
  return {
    type: 'scenario_attempt', id: r.id, tenant_id: tenantId, owner_person_id: r.learner_person_id, owner_card_id: r.learner_card_id,
    sensitivity: r.sensitivity, scenario_id: r.scenario_id,
  };
}

export function scenarioRoutes(deps: GatewayDeps): RouteDef[] {
  const { authorizer } = deps;

  /**
   * Of these knowledge items, the ones THIS caller may read and - when `released` - that are verified and released
   * to learners (level 0). Each item is asked of the policy once per request.
   */
  const readableItems = async (tx: Tx, subject: CardSubject, ctx: RequestContext, ids: Iterable<string>, released: boolean): Promise<Set<string>> => {
    const ok = new Set<string>();
    for (const id of new Set(ids)) {
      const ref = await itemRef(tx, subject.tenant_id, id);
      if (!ref) continue;
      if (released && (ref.sensitivity !== 0 || (ref.status !== 'verified' && ref.status !== 'corrected'))) continue;
      if ((await authorizer.decideOnly(tx, subject, 'knowledge:read', ref, ctx)).effect === 'allow') ok.add(id);
    }
    return ok;
  };

  /** The body of a create or an edit, with the items checked against the writer. */
  const writePlan = async (tx: Tx, subject: CardSubject, ctx: RequestContext, body: any) => {
    const steps = (body.steps as Array<{ prompt: string; item_ids: string[]; rubric: string[] }>).map((s) => ({
      prompt: s.prompt, item_ids: [...new Set(s.item_ids.map((i) => i.toLowerCase()))], rubric: s.rubric,
    }));
    const wanted = steps.flatMap((s) => s.item_ids);
    const approved = await readableItems(tx, subject, ctx, wanted, true);
    if (wanted.some((id) => !approved.has(id))) {
      throw problems.unprocessable('Every linked item must be verified, released to learners and readable by you');
    }
    return { approved: [...approved], json: { title: body.title, situation: body.situation, job_role: body.job_role, steps, updated_at: body.updated_at ?? null } };
  };

  /** item ids linked to each of these scenarios */
  const linkedItems = async (tx: Tx, tenantId: string, scenarioIds: string[]): Promise<Map<string, string[]>> => {
    const out = new Map<string, string[]>(scenarioIds.map((id) => [id, []]));
    if (scenarioIds.length === 0) return out;
    const { rows } = await tx.query<{ scenario_id: string; item_id: string }>(
      `SELECT st.scenario_id, si.item_id FROM scenario_step_items si JOIN scenario_steps st ON st.tenant_id = si.tenant_id AND st.id = si.step_id
        WHERE si.tenant_id = $1 AND st.scenario_id = ANY($2::uuid[])`, [tenantId, scenarioIds]);
    for (const r of rows) out.get(r.scenario_id)?.push(r.item_id);
    return out;
  };

  /** Of these approved scenarios, the ones built only from knowledge this caller may read (and that is still verified and released). */
  const offeredTo = async (tx: Tx, subject: CardSubject, ctx: RequestContext, scenarioIds: string[]): Promise<string[]> => {
    const links = await linkedItems(tx, subject.tenant_id, scenarioIds);
    const readable = await readableItems(tx, subject, ctx, [...links.values()].flat(), true);
    return scenarioIds.filter((id) => {
      const items = links.get(id) ?? [];
      return items.length > 0 && items.every((i) => readable.has(i));
    });
  };

  const asRun = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> =>
    newRef('scenario_attempt', subject.tenant_id, { owner_person_id: subject.person_id, owner_card_id: subject.card_id, sensitivity: 0 });

  return [
    // ------------------------------------------------------------------ writing and approving (reviewers)
    gatewayRoute(deps, 'createScenario',
      async ({ subject }) => newRef('scenario', subject.tenant_id, { sensitivity: 0, owner_person_id: subject.person_id }),
      async ({ tx, subject, body, ctx }) => {
        const plan = await writePlan(tx, subject, ctx, body);
        return { path: '/internal/scenarios', action: 'scenario.write', ...plan, status: 201, map: (r) => pick(r, ['id', 'status']) };
      }),
    withListFilter('delegated', gatewayRoute(deps, 'listScenarios',
      async ({ subject }) => collectionRef('scenario', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/scenarios/list', action: 'scenario.list', filterAction: 'quiz:read',
        json: { status: query.status ?? null, limit: query.limit, after: decodeIdCursor(query.cursor) },
        map: (r) => ({
          items: (r.items ?? []).map((s: any) => ({ ...pick(s, SUMMARY), step_count: s.steps ?? 0 })),
          next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null,
        }),
      }))),
    gatewayRoute(deps, 'getScenario',
      ({ tx, subject, params }) => scenarioRef(tx, subject.tenant_id, params.scenario_id),
      async ({ tx, subject, params, ctx }) => {
        // The title of a linked item is given only for items THIS reader may read; the others are named by id and state.
        const links = await linkedItems(tx, subject.tenant_id, [params.scenario_id]);
        const approved = await readableItems(tx, subject, ctx, [...links.values()].flat(), false);
        return {
          path: `/internal/scenarios/${params.scenario_id}/read`, action: 'scenario.read', subject: params.scenario_id, filterAction: 'quiz:read',
          approved: [...approved],
          map: (r) => ({
            ...pick(r, SUMMARY), situation: r.situation ?? '', has_attempts: r.has_attempts === true,
            steps: (r.steps ?? []).map((s: any) => ({
              position: s.position, prompt: s.prompt ?? '', erased: s.erased === true, rubric: s.rubric ?? [],
              items: (s.items ?? []).map((i: any) => ({ id: i.id, title: typeof i.title === 'string' ? i.title : null, status: i.status })),
            })),
          }),
        };
      }),
    gatewayRoute(deps, 'updateScenario',
      ({ tx, subject, params }) => scenarioRef(tx, subject.tenant_id, params.scenario_id),
      async ({ tx, subject, params, body, ctx }) => {
        const plan = await writePlan(tx, subject, ctx, body);
        return {
          path: `/internal/scenarios/${params.scenario_id}/edit`, action: 'scenario.edit', subject: params.scenario_id, ...plan,
          map: (r) => pick(r, ['id', 'status']),
        };
      }),
    // Approval: by someone who neither created the scenario nor last edited it. The policy decides (and records a
    // refusal as DENY_SELF_REVIEW, like the second-reviewer rule for knowledge items); the AI service and the database
    // check it again. The approver says which version it read; a scenario changed since is not approved.
    approvalRoute(deps, 'approveScenario',
      async ({ tx, subject, params }) => forApproval(await scenarioRef(tx, subject.tenant_id, params.scenario_id)),
      async ({ params, body }) => ({
        path: `/internal/scenarios/${params.scenario_id}/status`, action: 'scenario.status', subject: params.scenario_id,
        json: { status: 'approved', updated_at: body?.updated_at ?? null }, map: (r) => pick(r, ['id', 'status']),
      })),
    gatewayRoute(deps, 'retireScenario', ({ tx, subject, params }) => scenarioRef(tx, subject.tenant_id, params.scenario_id), async ({ params }) => ({
      path: `/internal/scenarios/${params.scenario_id}/status`, action: 'scenario.status', subject: params.scenario_id,
      json: { status: 'retired' }, map: (r) => pick(r, ['id', 'status']),
    })),
    gatewayRoute(deps, 'proposeScenarioRubric',
      async ({ subject }) => newRef('scenario', subject.tenant_id, { sensitivity: 0, owner_person_id: subject.person_id }),
      async ({ tx, subject, body, ctx }) => {
        const approved = await readableItems(tx, subject, ctx, (body.item_ids as string[]).map((i) => i.toLowerCase()), true);
        if (approved.size === 0) throw problems.unprocessable('None of these items is verified, released to learners and readable by you');
        return { path: '/internal/scenarios/rubric', action: 'scenario.rubric', ai: true, approved: [...approved], map: (r) => ({ rubric: r.rubric ?? [] }) };
      }),

    // ------------------------------------------------------------------ running (learners)
    // Not a list of "everything of a type": it is what THIS card may start, worked out here item by item. The policy
    // is asked whether the card may take a run of its own (as for starting one), so no list filter applies.
    gatewayRoute(deps, 'listOfferedScenarios', asRun, async ({ tx, subject, query, ctx }) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM scenarios WHERE tenant_id = $1 AND status = 'approved' AND ($2::text IS NULL OR job_role = $2) ORDER BY id LIMIT $3`,
        [subject.tenant_id, query.job_role ?? null, MAX_OFFERS_EXAMINED + 1]);
      const examined = rows.slice(0, MAX_OFFERS_EXAMINED).map((r) => r.id);
      const approved = await offeredTo(tx, subject, ctx, examined);
      return {
        path: '/internal/scenarios/offered', action: 'scenario.offered', approved,
        map: (r) => ({
          items: (r.items ?? []).map((s: any) => ({ ...pick(s, ['id', 'title', 'situation', 'job_role']), step_count: s.steps ?? 0 })),
          truncated: rows.length > MAX_OFFERS_EXAMINED,
        }),
      };
    }),
    gatewayRoute(deps, 'startScenarioAttempt', asRun, async ({ tx, subject, params, ctx }) => {
      const scenario = await scenarioRef(tx, subject.tenant_id, params.scenario_id);
      // not approved, or built from something this learner may not read: the same answer as "no such scenario"
      if (!scenario || scenario.status !== 'approved' || (await offeredTo(tx, subject, ctx, [scenario.id as string])).length === 0) throw problems.notFound();
      return {
        path: `/internal/scenarios/${scenario.id}/attempts`, action: 'scenario.start', subject: scenario.id as string, approved: [scenario.id as string], status: 201,
        map: (r) => ({
          ...pick(r, ['id', 'scenario_id', 'title', 'situation', 'expires_at']),
          steps: (r.steps ?? []).map((s: any) => pick(s, ['position', 'prompt'])),      // never the expected points
        }),
      };
    }),
    withListFilter('delegated', gatewayRoute(deps, 'listScenarioAttempts',
      async ({ subject }) => collectionRef('scenario_attempt', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/scenario-attempts/list', action: 'scenario.attempts', filterAction: 'quiz:read_results',
        json: { limit: query.limit, before: decodeIdCursor(query.cursor) },
        map: (r) => ({
          items: (r.items ?? []).map((a: any) => pick(a, ['id', 'scenario_id', 'title', 'job_role', 'learner_person_id', 'status', 'started_at', 'submitted_at', 'graded_at'])),
          next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null,
        }),
      }))),
    gatewayRoute(deps, 'getScenarioAttempt',
      ({ tx, subject, params }) => runRef(tx, subject.tenant_id, params.scenario_attempt_id),
      async ({ tx, subject, params, ctx }) => {
        // "Read these" after grading: only the linked items the READER may read.
        const scenarioId = (await runRef(tx, subject.tenant_id, params.scenario_attempt_id))?.scenario_id;
        const links = scenarioId ? await linkedItems(tx, subject.tenant_id, [scenarioId]) : new Map<string, string[]>();
        const linked = [...links.values()].flat();
        const approved = await readableItems(tx, subject, ctx, linked, false);
        // A run quotes its scenario (the situation, the questions). A reader who may no longer read every linked item
        // - it was re-labelled above their level, or is no longer verified for a learner - does not get the run either.
        if (linked.some((id) => !approved.has(id))) throw problems.forbidden();
        return {
          path: `/internal/scenario-attempts/${params.scenario_attempt_id}/read`, action: 'scenario.attempt_read', subject: params.scenario_attempt_id,
          filterAction: 'quiz:read_results', approved: [...approved],
          map: (r) => ({
            ...pick(r, ['id', 'scenario_id', 'title', 'situation', 'job_role', 'learner_person_id', 'status', 'started_at', 'expires_at', 'submitted_at', 'graded_at']),
            steps: runSteps(r),
          }),
        };
      }),
    gatewayRoute(deps, 'saveScenarioAnswer',
      ({ tx, subject, params }) => runRef(tx, subject.tenant_id, params.scenario_attempt_id),
      async ({ params, body }) => ({
        path: `/internal/scenario-attempts/${params.scenario_attempt_id}/answers`, action: 'scenario.answer', subject: params.scenario_attempt_id,
        json: { position: body.position, answer_text: body.answer_text ?? null }, map: (r) => pick(r, ['id', 'position']),
      })),
    gatewayRoute(deps, 'submitScenarioAttempt',
      ({ tx, subject, params }) => runRef(tx, subject.tenant_id, params.scenario_attempt_id),
      async ({ params }) => ({
        path: `/internal/scenario-attempts/${params.scenario_attempt_id}/submit`, action: 'scenario.submit', subject: params.scenario_attempt_id, ai: true,
        map: (r) => pick(r, ['id', 'status']),
      })),
    // No blind grading. A grader reads ONE step - the question, the learner's words, the expected points - and sets
    // its score under the same rule (the AI service applies it for both): the run is handed in, it is not the
    // grader's own, and the step waits for a person or belongs to a run the grader may read anyway
    // (quiz:read_results, sent as the filter). The scenario's level and department are checked here, by the policy.
    gatewayRoute(deps, 'getScenarioAnswer',
      ({ tx, subject, params }) => answerRef(tx, subject.tenant_id, params.scenario_answer_id),
      async ({ params }) => ({
        path: `/internal/scenario-answers/${params.scenario_answer_id}/read`, action: 'scenario.answer_read', subject: params.scenario_answer_id,
        filterAction: 'quiz:read_results',
        map: (r) => ({
          ...pick(r, ['id', 'attempt_id', 'scenario_title', 'position', 'prompt', 'answer_text', 'final_score', 'decided_by', 'ai_score', 'ai_confidence']),
          awaiting_person: r.awaiting_person === true, details_removed: r.details_removed === true,
          points: (r.points ?? []).map((p: any) => ({ text: String(p.text ?? ''), met: typeof p.met === 'boolean' ? p.met : null })),
        }),
      })),
    gatewayRoute(deps, 'overrideScenarioAnswer',
      ({ tx, subject, params }) => answerRef(tx, subject.tenant_id, params.scenario_answer_id),
      async ({ params, body }) => ({
        path: `/internal/scenario-answers/${params.scenario_answer_id}/override`, action: 'scenario.override', subject: params.scenario_answer_id,
        filterAction: 'quiz:read_results',
        json: { score: body.score }, map: (r) => pick(r, ['id', 'status']),
      })),
  ];
}
