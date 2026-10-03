// Loaders that describe the thing being acted on, for the policy decision point. They read labels and
// status only (the API's database login cannot read captured text). Row-level security limits every
// query to the caller's company; a row of another company is simply "not found".
import { isUuid } from '../../../shared/crypto.ts';
import type { ResourceRef } from '../../../shared/policy-types.ts';
import type { Tx } from '../../platform/index.ts';

const isId = isUuid;

async function first<T>(tx: Tx, sql: string, params: unknown[]): Promise<T | null> {
  const { rows } = await tx.query<T & Record<string, unknown>>(sql, params);
  return (rows[0] as T | undefined) ?? null;
}

export async function sourceRef(tx: Tx, tenantId: string, id: unknown): Promise<(ResourceRef & { status: string }) | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; department_id: string | null; sensitivity: number; owner_person_id: string | null; uploaded_by_card_id: string; status: string }>(
    tx, 'SELECT id, department_id, sensitivity, owner_person_id, uploaded_by_card_id, status FROM sources WHERE tenant_id = $1 AND id = $2',
    [tenantId, id]);
  if (!r || r.status === 'withdrawn') return null;
  return {
    type: 'source', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity,
    owner_person_id: r.owner_person_id, owner_card_id: r.uploaded_by_card_id, status: r.status,
  };
}

/** A knowledge item with what the second-reviewer and verified-only rules need. */
export async function itemRef(tx: Tx, tenantId: string, id: unknown): Promise<(ResourceRef & { status: string }) | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; department_id: string | null; sensitivity: number; owner_person_id: string | null; status: string; author_person_id: string | null }>(
    tx,
    `SELECT i.id, i.department_id, i.sensitivity, i.owner_person_id, i.status, v.author_person_id
       FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id
      WHERE i.tenant_id = $1 AND i.id = $2`, [tenantId, id]);
  if (!r || r.status === 'withdrawn') return null;
  return {
    type: 'knowledge_item', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity,
    owner_person_id: r.owner_person_id, author_person_id: r.author_person_id,
    verification_status: r.status === 'verified' || r.status === 'corrected' ? r.status : 'unverified', status: r.status,
  };
}

/** Item states in which the item is (or was) released as verified knowledge: learners are tested on it and the gap report counts it. */
const RELEASED = new Set(['verified', 'corrected', 'stale']);

/**
 * The item as the policy must see it when its TOPICS are changed. On a released item that change needs a second
 * person, like verifying it (decision D24); on a draft or an item in review the author may still sort it into topics.
 */
export function forTopicChange<T extends ResourceRef & { status: string }>(ref: T): T {
  return { ...ref, changes_released_knowledge: RELEASED.has(ref.status) };
}

export async function chunkRefs(tx: Tx, tenantId: string, ids: string[]): Promise<ResourceRef[]> {
  const valid = ids.filter(isId);
  if (valid.length === 0) return [];
  const { rows } = await tx.query<{ id: string; department_id: string | null; sensitivity: number; owner_person_id: string | null; verification_status: string }>(
    `SELECT id, department_id, sensitivity, owner_person_id, verification_status FROM chunks
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`, [tenantId, valid]);
  return rows.map((r) => ({
    type: 'chunk', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity,
    owner_person_id: r.owner_person_id, verification_status: r.verification_status,
  }));
}

export async function interviewRef(tx: Tx, tenantId: string, id: unknown): Promise<(ResourceRef & { status: string }) | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; expert_person_id: string; status: string }>(
    tx, 'SELECT id, expert_person_id, status FROM interviews WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!r) return null;
  // An interview is the expert's own words: internal (1), no department of its own.
  return { type: 'interview', id: r.id, tenant_id: tenantId, owner_person_id: r.expert_person_id, sensitivity: 1, status: r.status };
}

export async function expertQuestionRef(tx: Tx, tenantId: string, id: unknown): Promise<ResourceRef | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; expert_person_id: string; asked_by_card_id: string; department_id: string | null; sensitivity: number }>(
    tx, 'SELECT id, expert_person_id, asked_by_card_id, department_id, sensitivity FROM expert_questions WHERE tenant_id = $1 AND id = $2',
    [tenantId, id]);
  if (!r) return null;
  return {
    type: 'expert_question', id: r.id, tenant_id: tenantId, owner_person_id: r.expert_person_id, owner_card_id: r.asked_by_card_id,
    department_id: r.department_id, sensitivity: r.sensitivity,
  };
}

export async function quizItemRef(tx: Tx, tenantId: string, id: unknown): Promise<ResourceRef | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; department_id: string | null; sensitivity: number; owner_person_id: string | null }>(
    tx, 'SELECT id, department_id, sensitivity, owner_person_id FROM quiz_items WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!r) return null;
  return { type: 'quiz_item', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity, owner_person_id: r.owner_person_id };
}

export async function attemptRef(tx: Tx, tenantId: string, id: unknown): Promise<ResourceRef | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; learner_person_id: string; learner_card_id: string }>(
    tx, 'SELECT id, learner_person_id, learner_card_id FROM quiz_attempts WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!r) return null;
  // Readiness material is released (0) by definition.
  return { type: 'quiz_attempt', id: r.id, tenant_id: tenantId, owner_person_id: r.learner_person_id, owner_card_id: r.learner_card_id, sensitivity: 0 };
}

export async function consentRef(tx: Tx, tenantId: string, id: unknown): Promise<(ResourceRef & { withdrawn: boolean; legal_hold: boolean; withdrawal_status: string; person_id: string }) | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; person_id: string; granted_by_card_id: string; withdrawn_at: Date | null; legal_hold: boolean; withdrawal_status: string }>(
    tx, 'SELECT id, person_id, granted_by_card_id, withdrawn_at, legal_hold, withdrawal_status FROM consents WHERE tenant_id = $1 AND id = $2',
    [tenantId, id]);
  if (!r) return null;
  return {
    type: 'consent', id: r.id, tenant_id: tenantId, owner_person_id: r.person_id, owner_card_id: r.granted_by_card_id, sensitivity: 0,
    withdrawn: r.withdrawn_at !== null, legal_hold: r.legal_hold, withdrawal_status: r.withdrawal_status, person_id: r.person_id,
  };
}

export async function reviewTaskRef(tx: Tx, tenantId: string, id: unknown): Promise<(ResourceRef & { kind: string; status: string; visible_to_person_id: string | null }) | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; kind: string; status: string; department_id: string | null; sensitivity: number; owner_person_id: string | null; visible_to_person_id: string | null }>(
    tx, `SELECT id, kind, status, department_id, sensitivity, owner_person_id, visible_to_person_id FROM review_tasks
          WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  if (!r) return null;
  return {
    type: 'review_task', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity,
    owner_person_id: r.owner_person_id, kind: r.kind, status: r.status, visible_to_person_id: r.visible_to_person_id,
  };
}

export async function topicRef(tx: Tx, tenantId: string, id: unknown): Promise<ResourceRef | null> {
  if (!isId(id)) return null;
  const r = await first<{ id: string; department_id: string | null; sensitivity: number }>(
    tx, 'SELECT id, department_id, sensitivity FROM topics WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (!r) return null;
  return { type: 'topic', id: r.id, tenant_id: tenantId, department_id: r.department_id, sensitivity: r.sensitivity };
}

/** "The set of things of this type" (lists, reports, settings). */
export const collectionRef = (type: string, tenantId: string): ResourceRef => ({ type, tenant_id: tenantId, collection: true });

/** Something about to be created, described concretely so an `own` grant can allow it (docs/phase2/03). */
export const newRef = (type: string, tenantId: string, over: Partial<ResourceRef>): ResourceRef => ({
  type, tenant_id: tenantId, department_id: null, sensitivity: 1, owner_person_id: null, ...over,
});
