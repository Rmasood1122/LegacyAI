// Consent (feature 19), the review queue (24), the redaction allow-list (18), knowledge settings,
// AI budget and the operator's AI controls.
import { problems } from '../../../shared/errors.ts';
import type { ResourceRef, Subject } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, writeAudit, type RouteDef, type Tx } from '../../platform/index.ts';
import { aiLimits, baseClaims, type GatewayDeps } from './common.ts';
import { collectionRef, consentRef, newRef, reviewTaskRef } from './resources.ts';

const MAX_BULK = 20;
const SETTINGS_FIELDS = [
  'chunk_quota', 'max_upload_bytes', 'max_pdf_pages', 'second_reviewer_required', 'verifications_per_hour', 'verifications_per_day',
  'learner_sources', 'stale_after_days', 'review_sla_days', 'answer_log_retention_days', 'quiz_answer_retention_days', 'interview_max_turns',
  'interview_max_cost_micro_usd', 'expert_question_expiry_days', 'quiz_questions_per_attempt', 'quiz_time_limit_minutes',
  'quiz_min_questions_per_topic', 'quiz_show_answers_after_grading',
] as const;
const SETTINGS_DEFAULTS: Record<(typeof SETTINGS_FIELDS)[number], unknown> = {
  chunk_quota: 5000, max_upload_bytes: 5242880, max_pdf_pages: 50, second_reviewer_required: true, verifications_per_hour: 30,
  verifications_per_day: 100, learner_sources: 'verified_only', stale_after_days: 365, review_sla_days: 5, answer_log_retention_days: 90,
  quiz_answer_retention_days: 365, interview_max_turns: 30, interview_max_cost_micro_usd: 250000, expert_question_expiry_days: 30,
  quiz_questions_per_attempt: 10, quiz_time_limit_minutes: 45, quiz_min_questions_per_topic: 3, quiz_show_answers_after_grading: false,
};
const REVIEW_DESCRIPTOR = {
  type: 'review_task', tenantExpr: 'r.tenant_id', departmentExpr: 'r.department_id', sensitivityExpr: 'r.sensitivity', ownerPersonExpr: 'r.owner_person_id',
};
// A consent belongs to the person who gave it. Roles that hold consent:read only for their OWN records
// (Expert, Successor) must see only those in the company-wide list.
const CONSENT_DESCRIPTOR = { type: 'consent', tenantExpr: 'consents.tenant_id', ownerPersonExpr: 'consents.person_id' };
const NOT_DISMISSABLE = new Set(['verify_item', 'expert_question', 'quiz_item_approval']);

interface ConsentRow {
  id: string; person_id: string; scope: string; purpose: string; policy_version: string; granted_at: Date; expires_at: Date | null;
  superseded_at: Date | null; withdrawn_at: Date | null; withdrawal_status: string; legal_hold: boolean;
}
const CONSENT_COLUMNS = 'id, person_id, scope, purpose, policy_version, granted_at, expires_at, superseded_at, withdrawn_at, withdrawal_status, legal_hold';
const toApiConsent = (r: ConsentRow): Record<string, unknown> => ({
  id: r.id, person_id: r.person_id, scope: r.scope, purpose: r.purpose, policy_version: r.policy_version, granted_at: r.granted_at.toISOString(),
  expires_at: r.expires_at?.toISOString() ?? null, superseded_at: r.superseded_at?.toISOString() ?? null,
  withdrawn_at: r.withdrawn_at?.toISOString() ?? null, withdrawal_status: r.withdrawal_status, legal_hold: r.legal_hold,
});

interface TaskRow {
  id: string; kind: string; subject_type: string; subject_id: string; department_id: string | null; sensitivity: number; priority: number;
  status: string; assigned_to_card_id: string | null; created_at: Date; due_at: Date; first_response_at: Date | null; resolved_at: Date | null;
  resolution: string | null;
}
const TASK_COLUMNS = `r.id, r.kind, r.subject_type, r.subject_id, r.department_id, r.sensitivity, r.priority, r.status, r.assigned_to_card_id,
  r.created_at, r.due_at, r.first_response_at, r.resolved_at, r.resolution`;
const toApiTask = (r: TaskRow): Record<string, unknown> => ({
  id: r.id, kind: r.kind, subject_type: r.subject_type, subject_id: r.subject_id, department_id: r.department_id, sensitivity: r.sensitivity,
  priority: r.priority, status: r.status, assigned_to_card_id: r.assigned_to_card_id, created_at: r.created_at.toISOString(),
  due_at: r.due_at.toISOString(), first_response_at: r.first_response_at?.toISOString() ?? null, resolved_at: r.resolved_at?.toISOString() ?? null,
  resolution: r.resolution,
});

const isOwner = (s: Subject): boolean => s.roles.some((r) => r.role_key === 'company_owner');

/** expert_question tasks are seen only by the addressed expert and Owners (docs/phase2/06 §2). */
async function taskLoader({ tx, subject, params }: { tx: Tx; subject: Subject; params: any }): Promise<ResourceRef | null> {
  const ref = await reviewTaskRef(tx, subject.tenant_id, params.task_id);
  if (!ref) return null;
  if (ref.kind === 'expert_question' && ref.visible_to_person_id !== subject.person_id && !isOwner(subject)) return null;
  return ref;
}

async function settingsOf(tx: Tx, tenantId: string): Promise<Record<string, unknown>> {
  const { rows } = await tx.query<Record<string, unknown>>(
    // eslint-disable-next-line no-restricted-syntax -- column names are the code constant SETTINGS_FIELDS; the only value is bound
    `SELECT ${SETTINGS_FIELDS.join(', ')}, interview_max_cost_micro_usd::text AS interview_max_cost_text FROM knowledge_settings WHERE tenant_id = $1`,
    [tenantId]);
  const row = rows[0];
  const out: Record<string, unknown> = {};
  for (const f of SETTINGS_FIELDS) out[f] = row ? row[f] : SETTINGS_DEFAULTS[f];
  if (row) out.interview_max_cost_micro_usd = Number(row.interview_max_cost_text);
  return out;
}

/** What the policy decision point needs from the knowledge settings (plugged into the authorizer by app.ts). */
export async function knowledgePolicySettings(tx: Tx, tenantId: string): Promise<{ learner_verified_only: boolean; second_reviewer_required: boolean }> {
  const { rows } = await tx.query<{ learner_sources: string; second_reviewer_required: boolean }>(
    'SELECT learner_sources, second_reviewer_required FROM knowledge_settings WHERE tenant_id = $1', [tenantId]);
  const r = rows[0];
  return { learner_verified_only: r ? r.learner_sources === 'verified_only' : true, second_reviewer_required: r ? r.second_reviewer_required : true };
}

export function adminRoutes(deps: GatewayDeps): RouteDef[] {
  const { db, authorizer, ai } = deps;

  /** Step 2 of a withdrawal, after step 1 (hiding) has been committed. */
  const erase = (claims: ReturnType<typeof baseClaims>, consentId: string): Promise<{ withdrawal_status: string }> =>
    ai.call<{ withdrawal_status: string }>({ path: `/internal/consents/${consentId}/erase`, action: 'consent.erase', subject: consentId, claims });

  async function loadConsent(tx: Tx, tenantId: string, id: string): Promise<ConsentRow> {
    const { rows } = await tx.query<ConsentRow>(`SELECT ${CONSENT_COLUMNS} FROM consents WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    if (!rows[0]) throw problems.notFound();
    return rows[0];
  }

  return [
    // ------------------------------------------------------------------ consent
    {
      operationId: 'listConsents',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('consent', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeIdCursor(query.cursor);
        // The policy allows listing to any holder of consent:read and OBLIGES the caller to filter: without this
        // filter a card with an "own" grant could read every person's consent records (found by the Phase 3b browser tests).
        const filter = await authorizer.filter(tx, subject, 'consent:read', CONSENT_DESCRIPTOR, ctx, 5);
        const { rows } = await tx.query<ConsentRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${CONSENT_COLUMNS} FROM consents WHERE tenant_id = $1 AND ($2::uuid IS NULL OR person_id = $2::uuid)
              AND ($3::uuid IS NULL OR id > $3::uuid) AND ${filter.sql} ORDER BY id LIMIT $4`,
          [subject.tenant_id, query.person_id ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiConsent), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'listMyConsents',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('consent', subject.tenant_id, { owner_person_id: subject.person_id, owner_card_id: subject.card_id, sensitivity: 0 }) },
      handler: async ({ tx, subject, query }) => {
        // Newest first; ids are time-ordered (uuidv7), so the id of the last row is the cursor.
        const before = decodeIdCursor(query.cursor);
        const { rows } = await tx.query<ConsentRow>(
          `SELECT ${CONSENT_COLUMNS} FROM consents WHERE tenant_id = $1 AND person_id = $2 AND ($3::uuid IS NULL OR id < $3::uuid)
            ORDER BY id DESC LIMIT $4`,
          [subject.tenant_id, subject.person_id, before, query.limit + 1]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiConsent), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'giveConsent',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('consent', subject.tenant_id, { owner_person_id: subject.person_id, owner_card_id: subject.card_id, sensitivity: 0 }) },
      handler: async ({ tx, subject, body, ctx }) => {
        if (subject.person_id === null) throw problems.unprocessable('Only a person can give consent');
        // A new consent replaces the live one of the same scope (the old one is kept, marked superseded).
        await tx.query(`UPDATE consents SET superseded_at = now() WHERE tenant_id = $1 AND person_id = $2 AND scope = $3
                          AND withdrawn_at IS NULL AND superseded_at IS NULL`, [subject.tenant_id, subject.person_id, body.scope]);
        const { rows } = await tx.query<ConsentRow>(
          `INSERT INTO consents (tenant_id, person_id, scope, purpose, policy_version, granted_by_card_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${CONSENT_COLUMNS}`,
          [subject.tenant_id, subject.person_id, body.scope, body.purpose, body.policy_version, subject.card_id, body.expires_at ?? null]);
        const row = rows[0] as ConsentRow;
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'consent:given', resourceType: 'consent',
          resourceId: row.id, decision: 'event', reasonCode: 'CONSENT_GIVEN', requestId: ctx.requestId, ip: ctx.ip, details: { scope: row.scope },
        });
        return { status: 201, body: toApiConsent(row) };
      },
    },
    {
      operationId: 'withdrawConsent',
      kind: 'gateway',
      policy: { resource: ({ tx, subject, params }) => consentRef(tx, subject.tenant_id, params.consent_id) },
      prepare: async ({ tx, subject, decision, ctx, params }) => {
        const c = await loadConsent(tx, subject.tenant_id, params.consent_id);
        if (c.withdrawn_at !== null) throw problems.conflict('already-withdrawn', 'This consent was already withdrawn');
        // Step 1, in THIS transaction: the database hides everything given under the consent (migration 15).
        await tx.query('UPDATE consents SET withdrawn_at = now(), withdrawn_by_card_id = $3 WHERE tenant_id = $1 AND id = $2',
          [subject.tenant_id, params.consent_id, subject.card_id]);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'consent:withdrawn', resourceType: 'consent',
          resourceId: c.id, decision: 'event', reasonCode: 'CONSENT_WITHDRAWN', requestId: ctx.requestId, ip: ctx.ip, details: { scope: c.scope },
        });
        const claims = baseClaims(subject, decision, ctx);
        return {
          call: async ({ withTx }) => {
            await erase(claims, c.id);   // step 2, in the same request
            return { body: toApiConsent(await withTx((tx2) => loadConsent(tx2, subject.tenant_id, c.id))) };
          },
        };
      },
    },
    {
      operationId: 'recordWithdrawalForPerson',
      kind: 'gateway',
      policy: {
        resource: async ({ tx, subject, params }) => {
          const { rows } = await tx.query('SELECT id FROM people WHERE tenant_id = $1 AND id = $2', [subject.tenant_id, params.person_id]);
          return rows.length === 0 ? null : newRef('consent', subject.tenant_id, { owner_person_id: params.person_id, sensitivity: 0 });
        },
      },
      prepare: async ({ tx, subject, decision, ctx, params, body }) => {
        // For someone who has left and cannot sign in: an Owner records the withdrawal, with a reference to their request.
        const { rows } = await tx.query<{ id: string }>(
          `UPDATE consents SET withdrawn_at = now(), withdrawn_by_card_id = $3, withdrawal_recorded_for_person = true, withdrawal_reference = $4
            WHERE tenant_id = $1 AND person_id = $2 AND withdrawn_at IS NULL AND superseded_at IS NULL AND ($5::text IS NULL OR scope = $5)
            RETURNING id`,
          [subject.tenant_id, params.person_id, subject.card_id, body.reference, body.scope ?? null]);
        if (rows.length === 0) throw problems.conflict('nothing-to-withdraw', 'This person has no live consent of that scope');
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'consent:withdrawn_for_person', resourceType: 'person',
          resourceId: params.person_id, decision: 'event', reasonCode: 'CONSENT_WITHDRAWN_FOR_PERSON', requestId: ctx.requestId, ip: ctx.ip,
          details: { count: rows.length },
        });
        const claims = baseClaims(subject, decision, ctx);
        return {
          call: async () => {
            const results = [];
            for (const r of rows) results.push({ consent_id: r.id, withdrawal_status: (await erase(claims, r.id)).withdrawal_status });
            return { body: { person_id: params.person_id, withdrawals: results } };
          },
        };
      },
    },
    {
      operationId: 'holdConsent',
      kind: 'session',
      policy: { resource: ({ tx, subject, params }) => consentRef(tx, subject.tenant_id, params.consent_id) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const c = await loadConsent(tx, subject.tenant_id, params.consent_id);
        if (c.withdrawal_status === 'completed') throw problems.conflict('already-erased', 'The material was already erased');
        await tx.query(`UPDATE consents SET legal_hold = true, legal_hold_by_card_id = $3, legal_hold_at = now(), legal_hold_reason = $4,
                               withdrawal_status = CASE WHEN withdrawal_status = 'hidden' THEN 'held' ELSE withdrawal_status END
                         WHERE tenant_id = $1 AND id = $2`, [subject.tenant_id, c.id, subject.card_id, body.reason]);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'consent:hold', resourceType: 'consent', resourceId: c.id,
          decision: 'event', reasonCode: 'LEGAL_HOLD_SET', requestId: ctx.requestId, ip: ctx.ip,
        });
        return { body: toApiConsent(await loadConsent(tx, subject.tenant_id, c.id)) };
      },
    },
    {
      operationId: 'releaseConsentHold',
      kind: 'gateway',
      policy: { resource: ({ tx, subject, params }) => consentRef(tx, subject.tenant_id, params.consent_id) },
      prepare: async ({ tx, subject, decision, ctx, params }) => {
        const c = await loadConsent(tx, subject.tenant_id, params.consent_id);
        if (!c.legal_hold) throw problems.conflict('not-held', 'This consent is not under a legal hold');
        await tx.query(`UPDATE consents SET legal_hold = false, legal_hold_by_card_id = NULL, legal_hold_at = NULL, legal_hold_reason = NULL,
                               withdrawal_status = CASE WHEN withdrawal_status = 'held' THEN 'hidden' ELSE withdrawal_status END
                         WHERE tenant_id = $1 AND id = $2`, [subject.tenant_id, c.id]);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'consent:hold_released', resourceType: 'consent',
          resourceId: c.id, decision: 'event', reasonCode: 'LEGAL_HOLD_RELEASED', requestId: ctx.requestId, ip: ctx.ip,
        });
        if (c.withdrawn_at === null) return { body: toApiConsent(await loadConsent(tx, subject.tenant_id, c.id)) };
        const claims = baseClaims(subject, decision, ctx);
        return {
          call: async ({ withTx }) => {
            await erase(claims, c.id);   // the withdrawal that waited for the hold now completes
            return { body: toApiConsent(await withTx((tx2) => loadConsent(tx2, subject.tenant_id, c.id))) };
          },
        };
      },
    },

    // ------------------------------------------------------------------ review queue
    {
      operationId: 'listReviewTasks',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('review_task', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'review:read', REVIEW_DESCRIPTOR, ctx, 7);
        const { rows } = await tx.query<TaskRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${TASK_COLUMNS} FROM review_tasks r
            WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.kind = $2) AND ($3::uuid IS NULL OR r.id > $3::uuid)
              AND (r.kind <> 'expert_question' OR r.visible_to_person_id = $4 OR $5)
              AND ${filter.sql}
            ORDER BY r.id LIMIT $6`,
          [query.status ?? null, query.kind ?? null, after, subject.person_id, isOwner(subject), query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        // Highest priority first, then the oldest due date, within the page.
        const items = page.map(toApiTask).sort((a, b) => (b.priority as number) - (a.priority as number) || String(a.due_at).localeCompare(String(b.due_at)));
        return { body: { items, next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'getReviewTask',
      kind: 'session',
      policy: { resource: taskLoader },
      handler: async ({ tx, subject, params }) => {
        const { rows } = await tx.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM review_tasks r WHERE r.tenant_id = $1 AND r.id = $2`, [subject.tenant_id, params.task_id]);
        return { body: toApiTask(rows[0] as TaskRow) };
      },
    },
    ...(['assign', 'unassign', 'dismiss'] as const).map((step): RouteDef => ({
      operationId: { assign: 'assignReviewTask', unassign: 'unassignReviewTask', dismiss: 'dismissReviewTask' }[step],
      kind: 'session',
      policy: { resource: taskLoader },
      handler: async ({ tx, subject, params, body, ctx }) => ({ body: await changeTask(tx, subject, ctx, params.task_id, step, body?.card_id) }),
    })),
    {
      operationId: 'bulkReviewTasks',
      kind: 'session',
      policy: { resource: async ({ subject }) => collectionRef('review_task', subject.tenant_id) },
      handler: async ({ tx, subject, body, ctx }) => {
        const ids = [...new Set(body.task_ids as string[])];
        if (ids.length > MAX_BULK) throw problems.unprocessable(`At most ${MAX_BULK} tasks per request`);
        const results = [];
        // Each task is authorised and audited on its own; one refusal does not block the others.
        for (const id of ids) {
          const ref = await taskLoader({ tx, subject, params: { task_id: id } });
          if (!ref) { results.push({ task_id: id, outcome: 'not_found' }); continue; }
          const decision = await authorizer.authorize(tx, subject, 'review:resolve', ref, ctx);
          await authorizer.record(tx, subject, 'review:resolve', ref, decision, ctx);
          if (decision.effect !== 'allow') { results.push({ task_id: id, outcome: 'forbidden' }); continue; }
          try {
            await tx.query('SAVEPOINT bulk_item');
            await changeTask(tx, subject, ctx, id, body.action, body.card_id);
            await tx.query('RELEASE SAVEPOINT bulk_item');
            results.push({ task_id: id, outcome: 'done' });
          } catch (err) {
            await tx.query('ROLLBACK TO SAVEPOINT bulk_item');
            if (!(err instanceof Error && 'status' in err)) throw err;
            results.push({ task_id: id, outcome: 'refused' });
          }
        }
        return { body: { results } };
      },
    },

    // ------------------------------------------------------------------ redaction allow-list
    {
      operationId: 'listRedactionAllowlist',
      kind: 'session',
      listFilter: { unfiltered: 'the allow-list is one company-wide list with no department or owner; a card whose review:read grant is narrower (Department Manager) is refused' },
      policy: { resource: async ({ subject }) => collectionRef('redaction_allowlist', subject.tenant_id) },
      handler: async ({ tx, subject }) => {
        const { rows } = await tx.query<{ id: string; term: string; entity_type: string; created_at: Date }>(
          'SELECT id, term, entity_type, created_at FROM redaction_allowlist WHERE tenant_id = $1 ORDER BY term', [subject.tenant_id]);
        return { body: { items: rows.map((r) => ({ id: r.id, term: r.term, entity_type: r.entity_type, created_at: r.created_at.toISOString() })), next_cursor: null } };
      },
    },
    {
      operationId: 'addRedactionAllowlistTerm',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('redaction_allowlist', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, body, ctx }) => {
        try {
          const { rows } = await tx.query<{ id: string; term: string; entity_type: string; created_at: Date }>(
            `INSERT INTO redaction_allowlist (tenant_id, term, entity_type, added_by_card_id) VALUES ($1, $2, $3, $4)
             RETURNING id, term, entity_type, created_at`, [subject.tenant_id, String(body.term).trim(), body.entity_type, subject.card_id]);
          const r = rows[0]!;
          await writeAudit(tx, {
            tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'redaction:allow', resourceType: 'redaction_allowlist',
            resourceId: r.id, decision: 'event', reasonCode: 'ALLOWLIST_ADDED', requestId: ctx.requestId, ip: ctx.ip,
          });
          return { status: 201, body: { id: r.id, term: r.term, entity_type: r.entity_type, created_at: r.created_at.toISOString() } };
        } catch (err) {
          if ((err as { code?: string }).code === '23514') throw problems.unprocessable('An allow-listed term cannot be an e-mail address or contain a number');
          throw err;
        }
      },
    },
    {
      operationId: 'deleteRedactionAllowlistTerm',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('redaction_allowlist', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, params, ctx }) => {
        const res = await tx.query('DELETE FROM redaction_allowlist WHERE tenant_id = $1 AND id = $2', [subject.tenant_id, params.term_id]);
        if (res.rowCount === 0) throw problems.notFound();
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'redaction:unallow', resourceType: 'redaction_allowlist',
          resourceId: params.term_id, decision: 'event', reasonCode: 'ALLOWLIST_REMOVED', requestId: ctx.requestId, ip: ctx.ip,
        });
        return { status: 204 };
      },
    },

    // ------------------------------------------------------------------ settings and AI budget
    {
      operationId: 'getKnowledgeSettings',
      kind: 'session',
      listFilter: { unfiltered: 'one settings record per company' },
      policy: { resource: async ({ subject }) => collectionRef('knowledge_settings', subject.tenant_id) },
      handler: async ({ tx, subject }) => ({ body: await settingsOf(tx, subject.tenant_id) }),
    },
    {
      operationId: 'updateKnowledgeSettings',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('knowledge_settings', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, body, ctx }) => {
        const next = { ...(await settingsOf(tx, subject.tenant_id)), ...body } as Record<string, unknown>;
        const cols = SETTINGS_FIELDS as readonly string[];
        try {
          await tx.query(
            // eslint-disable-next-line no-restricted-syntax -- column names are the code constant SETTINGS_FIELDS; every value is bound
            `INSERT INTO knowledge_settings (tenant_id, ${cols.join(', ')}, updated_by_card_id, updated_at)
             VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}, now())
             ON CONFLICT (tenant_id) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
               updated_by_card_id = EXCLUDED.updated_by_card_id, updated_at = now()`,
            [subject.tenant_id, ...cols.map((c) => next[c]), subject.card_id]);
        } catch (err) {
          if ((err as { code?: string }).code === '23514') throw problems.unprocessable('A setting is outside its allowed range');
          throw err;
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'knowledge_settings:update', resourceType: 'knowledge_settings',
          decision: 'event', reasonCode: 'SETTINGS_CHANGED', requestId: ctx.requestId, ip: ctx.ip, details: { changed: Object.keys(body).sort().join(',') },
        });
        return { body: await settingsOf(tx, subject.tenant_id) };
      },
    },
    {
      operationId: 'getAiBudget',
      kind: 'session',
      listFilter: { unfiltered: 'one budget record per company' },
      policy: { resource: async ({ subject }) => collectionRef('ai_budget', subject.tenant_id) },
      handler: async ({ tx, subject }) => {
        const limits = await aiLimits(tx, subject.tenant_id);
        const { rows } = await tx.query<{ period: string; spent: string; reserved: string; calls: number }>(
          `SELECT period, spent_micro_usd::text AS spent, reserved_micro_usd::text AS reserved, calls FROM ai_budget_periods
            WHERE tenant_id = $1 AND period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`, [subject.tenant_id]);
        const g = await tx.query<{ kill_switch: boolean }>('SELECT kill_switch FROM ai_global');
        const p = rows[0];
        return {
          body: {
            period: p?.period ?? new Date().toISOString().slice(0, 7), monthly_cap_micro_usd: limits.monthly_cap_micro_usd ?? 0,
            spent_micro_usd: Number(p?.spent ?? 0), reserved_micro_usd: Number(p?.reserved ?? 0), calls: p?.calls ?? 0,
            ai_stopped: g.rows[0]?.kill_switch === true,
          },
        };
      },
    },
    {
      operationId: 'setTenantAiBudget',
      kind: 'session',
      policy: { resource: async ({ subject }) => collectionRef('ai_budget', subject.tenant_id) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const target = String(params.tenant_id);
        await db.withinTenant(tx, target, async () => {
          const t = await tx.query('SELECT 1 FROM tenants WHERE id = $1', [target]);
          if (t.rowCount === 0) throw problems.notFound();
          await tx.query(`INSERT INTO ai_budgets (tenant_id, monthly_cap_micro_usd, updated_by_card_id, updated_at) VALUES ($1, $2, NULL, now())
                          ON CONFLICT (tenant_id) DO UPDATE SET monthly_cap_micro_usd = EXCLUDED.monthly_cap_micro_usd, updated_at = now()`,
          [target, body.monthly_cap_micro_usd]);
          await writeAudit(tx, {
            tenantId: target, actorCardId: subject.card_id, actorKind: 'operator', action: 'ai_budget:set', resourceType: 'tenant', resourceId: target,
            decision: 'event', reasonCode: 'AI_CAP_SET', requestId: ctx.requestId, ip: ctx.ip, details: { cost_micro_usd: body.monthly_cap_micro_usd },
          });
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'ai_budget:set', resourceType: 'tenant', resourceId: target,
          decision: 'event', reasonCode: 'AI_CAP_SET', requestId: ctx.requestId, ip: ctx.ip, details: { cost_micro_usd: body.monthly_cap_micro_usd },
        });
        return { body: { tenant_id: target, monthly_cap_micro_usd: body.monthly_cap_micro_usd } };
      },
    },
    {
      operationId: 'setAiKillSwitch',
      kind: 'session',
      policy: { resource: async ({ subject }) => collectionRef('ai_global', subject.tenant_id) },
      handler: async ({ tx, subject, body, ctx }) => {
        await tx.query('UPDATE ai_global SET kill_switch = $1, kill_switch_reason = $2, updated_at = now()', [body.on === true, body.reason ?? null]);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'ai_kill_switch:set', resourceType: 'platform',
          decision: 'event', reasonCode: body.on === true ? 'AI_STOPPED' : 'AI_RESUMED', requestId: ctx.requestId, ip: ctx.ip,
        });
        return { body: { on: body.on === true, reason: body.reason ?? null } };
      },
    },
    {
      operationId: 'getPlatformStorage',
      kind: 'session',
      listFilter: { unfiltered: 'platform operator only; figures for the whole installation' },
      policy: { resource: async ({ subject }) => collectionRef('platform', subject.tenant_id) },
      handler: async ({ tx }) => {
        const size = await tx.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
        const per = await tx.query<{ tenant_id: string; chunk_count: number }>('SELECT tenant_id, chunk_count FROM tenant_usage_counters ORDER BY chunk_count DESC');
        return {
          body: {
            database_bytes: Number(size.rows[0]?.bytes ?? 0),
            total_chunks: per.rows.reduce((n, r) => n + r.chunk_count, 0),
            companies: per.rows.map((r) => ({ tenant_id: r.tenant_id, chunk_count: r.chunk_count })),
          },
        };
      },
    },
  ];
}

async function changeTask(tx: Tx, subject: Subject, ctx: { requestId: string; ip: string }, taskId: string, step: string, cardId?: string): Promise<Record<string, unknown>> {
  const { rows } = await tx.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM review_tasks r WHERE r.tenant_id = $1 AND r.id = $2 FOR UPDATE`, [subject.tenant_id, taskId]);
  const task = rows[0];
  if (!task) throw problems.notFound();
  if (task.status === 'resolved' || task.status === 'dismissed') throw problems.conflict('task-closed', 'This task is already closed');
  if (step === 'dismiss' && NOT_DISMISSABLE.has(task.kind)) throw problems.conflict('not-dismissable', 'This task ends only by acting on its subject');
  if (step === 'assign') {
    const assignee = cardId ?? subject.card_id;
    const ok = await tx.query("SELECT 1 FROM cards WHERE tenant_id = $1 AND id = $2 AND state = 'active'", [subject.tenant_id, assignee]);
    if (ok.rowCount === 0) throw problems.unprocessable('That card cannot be assigned');
    await tx.query(`UPDATE review_tasks SET status = 'assigned', assigned_to_card_id = $3, first_response_at = COALESCE(first_response_at, now())
                     WHERE tenant_id = $1 AND id = $2`, [subject.tenant_id, taskId, assignee]);
  } else if (step === 'unassign') {
    if (task.status !== 'assigned') throw problems.conflict('not-assigned', 'This task is not assigned');
    await tx.query("UPDATE review_tasks SET status = 'open', assigned_to_card_id = NULL WHERE tenant_id = $1 AND id = $2", [subject.tenant_id, taskId]);
  } else {
    await tx.query(`UPDATE review_tasks SET status = 'dismissed', resolved_at = now(), resolved_by_card_id = $3, resolution = 'dismissed',
                           assigned_to_card_id = NULL, first_response_at = COALESCE(first_response_at, now())
                     WHERE tenant_id = $1 AND id = $2`, [subject.tenant_id, taskId, subject.card_id]);
  }
  await writeAudit(tx, {
    tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: `review:${step}`, resourceType: 'review_task',
    resourceId: taskId, decision: 'event', reasonCode: `TASK_${step.toUpperCase()}`, requestId: ctx.requestId, ip: ctx.ip, details: { task_id: taskId },
  });
  const after = await tx.query<TaskRow>(`SELECT ${TASK_COLUMNS} FROM review_tasks r WHERE r.tenant_id = $1 AND r.id = $2`, [subject.tenant_id, taskId]);
  return toApiTask(after.rows[0] as TaskRow);
}
