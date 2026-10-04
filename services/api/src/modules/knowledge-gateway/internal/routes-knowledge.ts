// Documents (feature 25), cited answers (14, 15, 17) and the verification loop (12).
import { problems } from '../../../shared/errors.ts';
import type { ResourceRef } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, type RouteDef, type Tx } from '../../platform/index.ts';
import { aiLimits, baseClaims, gatewayRoute, pick, uuidOrNull, withListFilter, type GatewayDeps } from './common.ts';
import { chunkRefs, collectionRef, forTopicChange, itemRef, newRef, sourceRef, topicRef } from './resources.ts';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SOURCE_COLUMNS = `id, kind, title, department_id, sensitivity, owner_person_id, status, failure_code, mime, byte_size, page_count,
  chunk_count, created_at, ready_at, (company_owned_attested_by_card_id IS NOT NULL) AS company_document,
  (owner_person_id IS NOT NULL AND contributor_confirmed_at IS NULL AND status = 'awaiting_confirmation') AS awaiting_confirmation`;
const SOURCE_DESCRIPTOR = {
  type: 'source', tenantExpr: 'sources.tenant_id', ownerPersonExpr: 'sources.owner_person_id', ownerCardExpr: 'sources.uploaded_by_card_id',
  departmentExpr: 'sources.department_id', sensitivityExpr: 'sources.sensitivity',
};

interface SourceRow {
  id: string; kind: string; title: string; department_id: string | null; sensitivity: number; owner_person_id: string | null; status: string;
  failure_code: string | null; mime: string | null; byte_size: number | null; page_count: number | null; chunk_count: number;
  created_at: Date; ready_at: Date | null; company_document: boolean;
}

function toApiSource(r: SourceRow): Record<string, unknown> {
  return {
    id: r.id, kind: r.kind, title: r.title, department_id: r.department_id, sensitivity: r.sensitivity, contributor_person_id: r.owner_person_id,
    company_document: r.company_document, status: r.status, failure_code: r.failure_code, mime: r.mime, byte_size: r.byte_size,
    page_count: r.page_count, chunk_count: r.chunk_count, created_at: r.created_at.toISOString(), ready_at: r.ready_at?.toISOString() ?? null,
  };
}

async function sourceDetail(tx: Tx, tenantId: string, id: string): Promise<Record<string, unknown>> {
  const { rows } = await tx.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  const row = rows[0];
  if (!row) throw problems.notFound();
  const findings = await tx.query<{ entity_type: string; n: number; low: number }>(
    `SELECT entity_type, count(*)::int AS n, count(*) FILTER (WHERE low_confidence)::int AS low FROM redaction_findings
      WHERE tenant_id = $1 AND source_id = $2 GROUP BY entity_type ORDER BY entity_type`, [tenantId, id]);
  return {
    ...toApiSource(row),
    redactions: findings.rows.map((f) => ({ type: f.entity_type, count: f.n, low_confidence: f.low })),
  };
}

const UPLOAD_RESULT = ['status', 'failure_code', 'chunk_count', 'pending_chunks', 'duplicate_of'] as const;
const ITEM_SUMMARY = ['id', 'title', 'status', 'origin', 'ai_extracted', 'department_id', 'sensitivity', 'owner_person_id', 'usage_count',
  'verified_at', 'stale_after', 'updated_at'] as const;

function citation(c: any): Record<string, unknown> {
  return {
    ref: c.ref, kind: c.kind, id: c.id, title: c.title, snippet: c.snippet, verification_status: c.verification_status,
    expert_display_name: null, derived_from: Array.isArray(c.derived_from) ? c.derived_from.map((d: any) => pick(d, ['source_id', 'title'])) : [],
  };
}

/**
 * Display names for citations of items whose contributor agreed to be named (consent scope named_expert).
 * Python never sees names; the API adds them here.
 */
async function addExpertNames(tx: Tx, tenantId: string, citations: Array<Record<string, unknown>>): Promise<void> {
  const itemIds = citations.filter((c) => c.kind === 'item').map((c) => c.id as string);
  if (itemIds.length === 0) return;
  const { rows } = await tx.query<{ id: string; display_name: string }>(
    `SELECT i.id, p.display_name FROM knowledge_items i JOIN people p ON p.tenant_id = i.tenant_id AND p.id = i.owner_person_id
      WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[]) AND consent_is_valid(i.tenant_id, i.owner_person_id, 'named_expert', now())`,
    [tenantId, itemIds]);
  const names = new Map(rows.map((r) => [r.id, r.display_name]));
  for (const c of citations) if (c.kind === 'item' && names.has(c.id as string)) c.expert_display_name = names.get(c.id as string);
}

// One side of a conflict, in the shape of a citation (KConflictSide).
const CONFLICT_SIDE = ['kind', 'id', 'title', 'value'] as const;

export function knowledgeRoutes(deps: GatewayDeps): RouteDef[] {
  const { authorizer, ai } = deps;
  const status = (id: string, s: string): Record<string, unknown> => ({ id, status: s });

  return [
    // ------------------------------------------------------------------ documents
    gatewayRoute(deps, 'createSource',
      async ({ subject, body }) => {
        const contributor = uuidOrNull(body.contributor_person_id);
        if (body.company_document === true && contributor !== null) throw problems.unprocessable('Name a contributor or declare a company document, not both');
        if (body.company_document !== true && contributor === null) throw problems.unprocessable('Name a contributor or declare a company document');
        return newRef('source', subject.tenant_id, {
          department_id: uuidOrNull(body.department_id), sensitivity: body.sensitivity ?? 1, owner_person_id: contributor,
        });
      },
      async ({ body }) => ({
        path: '/internal/sources', action: 'source.create',
        json: {
          title: body.title, department_id: body.department_id ?? null, sensitivity: body.sensitivity ?? 1,
          contributor_person_id: body.contributor_person_id ?? null, company_document: body.company_document === true,
        },
        status: 201, map: (r) => pick(r, ['id', 'status', 'title']),
      })),
    gatewayRoute(deps, 'uploadSourceContent',
      ({ tx, subject, params }) => sourceRef(tx, subject.tenant_id, params.source_id),
      async ({ params, body, resource, contentType }) => {
        if (!Buffer.isBuffer(body) || body.length === 0) throw problems.badRequest([{ path: 'body', message: 'the file is empty' }]);
        if ((resource as ResourceRef & { status: string }).status !== 'awaiting_content') {
          throw problems.conflict('not-awaiting-content', 'This document is not waiting for its file');
        }
        return {
          path: `/internal/sources/${params.source_id}/content`, method: 'PUT', action: 'source.content', subject: params.source_id,
          bytes: { data: body, contentType: contentType ?? 'application/octet-stream' }, filterAction: 'source:read',
          map: (r) => pick(r, UPLOAD_RESULT),
        };
      }, MAX_UPLOAD_BYTES),
    {
      operationId: 'listSources',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('source', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'source:read', SOURCE_DESCRIPTOR, ctx, 4);
        const { rows } = await tx.query<SourceRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${SOURCE_COLUMNS} FROM sources WHERE status <> 'withdrawn' AND ($1::text IS NULL OR status = $1)
              AND ($2::uuid IS NULL OR id > $2::uuid) AND ${filter.sql} ORDER BY id LIMIT $3`,
          [query.status ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiSource), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'getSource',
      kind: 'gateway',
      policy: { resource: ({ tx, subject, params }) => sourceRef(tx, subject.tenant_id, params.source_id) },
      prepare: async ({ tx, subject, decision, ctx, params, resource }) => {
        // A document still being embedded continues on each status request (there is no background worker).
        if ((resource as ResourceRef & { status: string }).status !== 'processing') {
          return { body: await sourceDetail(tx, subject.tenant_id, params.source_id) };
        }
        const claims = baseClaims(subject, decision, ctx);
        return {
          call: async ({ withTx }) => {
            await ai.call({ path: `/internal/sources/${params.source_id}/continue`, action: 'source.continue', subject: params.source_id, claims });
            return { body: await withTx((tx2) => sourceDetail(tx2, subject.tenant_id, params.source_id)) };
          },
        };
      },
    },
    gatewayRoute(deps, 'confirmSource',
      ({ tx, subject, params }) => sourceRef(tx, subject.tenant_id, params.source_id),
      async ({ params }) => ({
        path: `/internal/sources/${params.source_id}/confirm`, action: 'source.confirm', subject: params.source_id,
        map: (r) => pick(r, ['id', 'status']),
      })),
    gatewayRoute(deps, 'withdrawSource',
      ({ tx, subject, params }) => sourceRef(tx, subject.tenant_id, params.source_id),
      async ({ params }) => ({
        path: `/internal/sources/${params.source_id}/withdraw`, action: 'source.withdraw', subject: params.source_id,
        map: (r) => pick(r, ['id', 'status', 'items_withdrawn', 'items_back_in_review']),
      })),
    gatewayRoute(deps, 'setSourceLabels',
      async ({ tx, subject, params, body }) => {
        const ref = await sourceRef(tx, subject.tenant_id, params.source_id);
        // the caller must be allowed the higher of the old and the new level
        return ref && { ...ref, sensitivity: Math.max(ref.sensitivity ?? 0, body.sensitivity) };
      },
      async ({ params, body }) => ({
        path: `/internal/labels/source/${params.source_id}`, action: 'label.change', subject: params.source_id,
        json: { department_id: body.department_id ?? null, sensitivity: body.sensitivity },
        map: (r) => ({ id: params.source_id, rows: r.rows }),
      })),

    // ------------------------------------------------------------------ asking (two steps, approval in between)
    {
      operationId: 'askKnowledge',
      kind: 'gateway',
      listFilter: 'delegated',
      policy: { resource: async ({ subject }) => collectionRef('knowledge', subject.tenant_id) },
      prepare: async ({ tx, subject, decision, ctx, body }) => {
        const expert = uuidOrNull(body.expert_person_id);
        if (expert !== null) {
          const { rows } = await tx.query<{ ok: boolean }>("SELECT consent_is_valid($1, $2, 'named_expert', now()) AS ok", [subject.tenant_id, expert]);
          if (rows[0]?.ok !== true) throw problems.unprocessable('This person cannot be asked by name');
        }
        const claims = baseClaims(subject, decision, ctx);
        claims.filter = await authorizer.filterSpec(tx, subject, 'knowledge:read', ctx);
        const limits = await aiLimits(tx, subject.tenant_id);
        const question = String(body.question);
        return {
          call: async ({ withTx }) => {
            // Step 1: candidate ids only - no text comes back.
            const found = await ai.call<{ candidates: Array<{ id: string; kind: string }> }>({
              path: '/internal/knowledge/candidates', action: 'knowledge.candidates', claims, json: { question, expert_person_id: expert },
            });
            // Lock 3: every candidate is checked again by the policy decision point, from the database.
            const approved = await withTx(async (tx2) => {
              const refs = await chunkRefs(tx2, subject.tenant_id, found.candidates.map((c) => c.id));
              const ok: string[] = [];
              for (const ref of refs) {
                const d = await authorizer.decideOnly(tx2, subject, 'knowledge:read', ref, ctx);
                if (d.effect === 'allow' && ref.id !== undefined) ok.push(ref.id);
              }
              return ok;
            });
            // Step 2: only approved passages may reach the prompt.
            const answer = await ai.call<any>({
              path: '/internal/knowledge/answer', action: 'knowledge.answer', claims: { ...claims, approved, limits },
              json: { question, expert_person_id: expert },
            });
            const citations = Array.isArray(answer.citations) ? answer.citations.map(citation) : [];
            await withTx((tx3) => addExpertNames(tx3, subject.tenant_id, citations));
            return {
              body: {
                outcome: answer.outcome, answer: answer.answer ?? null, reason: answer.reason ?? null, confidence: answer.confidence ?? null,
                contains_unverified_sources: answer.contains_unverified_sources === true, citations, can_ask_expert: answer.can_ask_expert === true,
                // feature 23/22: the record to give feedback on, who found a conflict, and what disagrees (titles and values
                // of the passages that were approved for this card - nothing it could not read anyway)
                answer_id: typeof answer.answer_id === 'string' ? answer.answer_id : null,
                conflict_found_by: answer.conflict_found_by === 'value_check' || answer.conflict_found_by === 'ai_model' ? answer.conflict_found_by : null,
                conflicts: (Array.isArray(answer.conflicts) ? answer.conflicts : []).slice(0, 5)
                  .map((c: any) => ({ measure: c.measure, a: pick(c.a ?? {}, CONFLICT_SIDE), b: pick(c.b ?? {}, CONFLICT_SIDE) })),
                conflict_check_partial: answer.conflict_check_partial === true,
              },
            };
          },
        };
      },
    },

    // ------------------------------------------------------------------ knowledge items
    withListFilter('delegated', gatewayRoute(deps, 'listKnowledgeItems',
      async ({ subject }) => collectionRef('knowledge_item', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/items/list', action: 'item.list', filterAction: 'knowledge:read',
        json: { status: query.status ?? null, owner_me: query.mine === true, limit: query.limit, after: decodeIdCursor(query.cursor) },
        map: (r) => ({ items: (r.items ?? []).map((i: any) => pick(i, ITEM_SUMMARY)), next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null }),
      }))),
    gatewayRoute(deps, 'getKnowledgeItem',
      ({ tx, subject, params }) => itemRef(tx, subject.tenant_id, params.item_id),
      async ({ params }) => ({
        path: `/internal/items/${params.item_id}/read`, action: 'item.read', subject: params.item_id, filterAction: 'knowledge:read',
        topicFilter: true,   // the item's topics are narrowed by topic:read, not by the right to read the item
        map: (r) => ({
          ...pick(r, [...ITEM_SUMMARY, 'body', 'self_verified']),
          versions: (r.versions ?? []).map((v: any) => pick(v, ['version_no', 'change_kind', 'author_person_id', 'created_at', 'erased_at', 'current'])),
          provenance: (r.provenance ?? []).map((p: any) => pick(p, ['source_id', 'title', 'page_from', 'page_to'])),
          topics: (r.topics ?? []).map((t: any) => pick(t, ['topic_id', 'name', 'link_source'])),
          // a conflict with an item this card may not read arrives as one entry with restricted = true and nothing else
          conflicts: (r.conflicts ?? []).map((c: any) => ({
            restricted: c.restricted === true, measure: c.measure ?? null, this: c.this ? pick(c.this, CONFLICT_SIDE) : null,
            other: c.other ? pick(c.other, CONFLICT_SIDE) : null, detected_at: c.detected_at ?? null,
          })),
        }),
      })),
    gatewayRoute(deps, 'createKnowledgeItem',
      async ({ subject, body }) => newRef('knowledge_item', subject.tenant_id, {
        department_id: uuidOrNull(body.department_id), sensitivity: body.sensitivity ?? 1, owner_person_id: uuidOrNull(body.contributor_person_id),
      }),
      async ({ body }) => ({
        path: '/internal/items', action: 'item.write', status: 201,
        json: { title: body.title, body: body.body, department_id: body.department_id ?? null, sensitivity: body.sensitivity ?? 1,
          contributor_person_id: body.contributor_person_id ?? null },
        map: (r) => pick(r, ['id', 'status']),
      })),
    ...(['submit', 'verify', 'reject', 'retire'] as const).map((step) => gatewayRoute(deps,
      { submit: 'submitKnowledgeItem', verify: 'verifyKnowledgeItem', reject: 'rejectKnowledgeItem', retire: 'retireKnowledgeItem' }[step],
      ({ tx, subject, params }) => itemRef(tx, subject.tenant_id, params.item_id),
      async ({ params }) => ({
        path: `/internal/items/${params.item_id}/${step}`, action: `item.${step}`, subject: params.item_id,
        map: (r) => status(params.item_id, r.status),
      }))),
    gatewayRoute(deps, 'reopenKnowledgeItem',
      ({ tx, subject, params }) => itemRef(tx, subject.tenant_id, params.item_id),
      async ({ params, body }) => ({
        path: `/internal/items/${params.item_id}/reopen`, action: 'item.reopen', subject: params.item_id,
        json: { rollback_to_version: body?.rollback_to_version ?? null },
        map: (r) => status(params.item_id, r.status),
      })),
    gatewayRoute(deps, 'proposeItemVersion',
      ({ tx, subject, params }) => itemRef(tx, subject.tenant_id, params.item_id),
      async ({ params, body }) => ({
        path: `/internal/items/${params.item_id}/versions`, action: 'item.propose', subject: params.item_id, json: { body: body.body },
        status: 201, map: (r) => pick(r, ['id', 'status', 'version_no']),
      })),
    gatewayRoute(deps, 'setItemLabels',
      async ({ tx, subject, params, body }) => {
        const ref = await itemRef(tx, subject.tenant_id, params.item_id);
        return ref && {
          ...ref, sensitivity: Math.max(ref.sensitivity ?? 0, body.sensitivity), releases_to_learners: body.sensitivity === 0 && ref.sensitivity !== 0,
        };
      },
      async ({ params, body }) => ({
        path: `/internal/labels/knowledge_item/${params.item_id}`, action: 'label.change', subject: params.item_id,
        json: { department_id: body.department_id ?? null, sensitivity: body.sensitivity },
        map: (r) => ({ id: params.item_id, rows: r.rows }),
      })),
    // A reviewer says which topics an item belongs to (docs/phase2/05 "a reviewer can add or remove a link, and manual
    // links win"). It is a label of the item, so it needs knowledge:label on THAT item; and every topic named must be
    // one this card may read - a topic it cannot see is answered exactly like one that does not exist.
    // Second-reviewer rule: once an item is verified, its topics decide what learners are tested on and what the gap
    // report counts, so its contributor and the author of its current version may not change them (forTopicChange).
    gatewayRoute(deps, 'setItemTopics',
      async ({ tx, subject, params }) => {
        const ref = await itemRef(tx, subject.tenant_id, params.item_id);
        return ref && forTopicChange(ref);
      },
      async ({ tx, subject, params, body, ctx }) => {
        const ids = [...new Set(body.topic_ids as string[])];
        for (const id of ids) {
          const topic = await topicRef(tx, subject.tenant_id, id);
          if (!topic || (await authorizer.decideOnly(tx, subject, 'topic:read', topic, ctx)).effect !== 'allow') throw problems.unprocessable('unknown topic');
        }
        return {
          path: `/internal/items/${params.item_id}/topics`, action: 'item.topics', subject: params.item_id, json: { topic_ids: ids },
          // the AI service replaces only links to topics this card may read: a link it cannot see is left alone
          topicFilter: true,
          map: (r) => ({ id: params.item_id, topics: (r.topics ?? []).map((t: any) => pick(t, ['topic_id', 'name', 'link_source'])) }),
        };
      }),
    gatewayRoute(deps, 'revertVerifications',
      async ({ subject }) => collectionRef('knowledge_item', subject.tenant_id),
      async ({ body }) => ({
        path: '/internal/verifications/revert', action: 'verification.revert',
        json: { verifier_card_id: body.card_id, since: body.since, until: body.until },
        map: (r) => ({ count: r.count }),
      })),
    gatewayRoute(deps, 'listMyContributions',
      async ({ subject }) => newRef('knowledge_item', subject.tenant_id, { owner_person_id: subject.person_id, sensitivity: 0 }),
      async ({ query }) => ({
        path: '/internal/items/list', action: 'item.list', filterAction: 'knowledge:read',
        json: { status: null, owner_me: true, limit: query.limit, after: decodeIdCursor(query.cursor) },
        map: (r) => ({ items: (r.items ?? []).map((i: any) => pick(i, ITEM_SUMMARY)), next_cursor: r.next_cursor ? encodeCursor(r.next_cursor) : null }),
      })),
    gatewayRoute(deps, 'restrictContribution',
      async ({ tx, subject, params }) => itemRef(tx, subject.tenant_id, params.item_id),
      async ({ params, body }) => ({
        path: `/internal/items/${params.item_id}/restrict`, action: 'item.restrict', subject: params.item_id, json: { sensitivity: body.sensitivity },
        map: (r) => pick(r, ['id', 'sensitivity']),
      })),
  ];
}

export { sourceDetail };
