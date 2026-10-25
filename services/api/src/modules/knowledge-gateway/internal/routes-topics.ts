// Topics, job roles and the gap report (feature 10). The role -> topic map and who holds a job role are tables the API
// owns, so these lists are answered here; topic names and descriptions, and the gap report, come from the AI service.
import { problems } from '../../../shared/errors.ts';
import type { Decision, RequestContext, Subject } from '../../../shared/policy-types.ts';
import { decodeIdCursor, decodeNameCursor, encodeCursor, encodeNameCursor, pageOf, writeAudit, type RouteDef, type Tx } from '../../platform/index.ts';
import { baseClaims, gatewayRoute, keyGatewayRoute, pick, uuidOrNull, withListFilter, type GatewayDeps } from './common.ts';
import type { TokenClaims } from './client.ts';
import { collectionRef, newRef, sourceRef, topicRef } from './resources.ts';
import { DEPARTMENT_TEMPLATES, findTemplate, type DepartmentTemplate } from './templates.ts';

const TOPIC_DESCRIPTOR = { type: 'topic', tenantExpr: 'topics.tenant_id', departmentExpr: 'topics.department_id', sensitivityExpr: 'topics.sensitivity' };
// People are narrowed by their own department (a Department Manager's gap:read is department-wide).
const ROLE_PERSON_DESCRIPTOR = { type: 'person', tenantExpr: 'p.tenant_id', departmentExpr: 'p.department_id' };

/** Links a topic to a job role. `replace`: an existing link takes the new values; otherwise it is left alone. Returns whether a row was written. */
async function linkRoleTopic(
  tx: Tx, tenantId: string, cardId: string, link: { job_role: string; topic_id: string; required: boolean; importance: number }, replace: boolean,
): Promise<boolean> {
  const written = await tx.query(
    replace
      ? `INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance, created_by_card_id) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, job_role, topic_id) DO UPDATE SET required = EXCLUDED.required, importance = EXCLUDED.importance`
      : `INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance, created_by_card_id) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, job_role, topic_id) DO NOTHING`,
    [tenantId, link.job_role, link.topic_id, link.required, link.importance, cardId]);
  return written.rowCount > 0;
}

// Topic names and descriptions are written and read only by the AI service (decision D41, step 6 part 4b; the
// founder's choice of 2026-10-25), so they can be stored sealed: the API login cannot read them. The API keeps the
// rest of a topic - its labels, origin and status - and every check of who may do what.
interface TopicRow { id: string; department_id: string | null; sensitivity: number; origin: string; status: string; created_at: Date }
interface TopicText { name: string; description: string }
const TOPIC_COLUMNS = 'id, department_id, sensitivity, origin, status, created_at';
const toApiTopic = (r: TopicRow, text: TopicText | undefined): Record<string, unknown> => ({
  id: r.id, name: text?.name ?? '', description: text?.description ?? '', department_id: r.department_id, sensitivity: r.sensitivity,
  origin: r.origin, status: r.status, created_at: r.created_at.toISOString(),
});
/** A topic as the AI service answers it (it wrote it): the same fields, the time as text. */
const fromAi = (r: any): Record<string, unknown> => ({
  ...pick(r, ['id', 'name', 'description', 'department_id', 'sensitivity', 'origin', 'status']), created_at: new Date(r.created_at).toISOString(),
});

const toApiTemplate = (t: DepartmentTemplate): Record<string, unknown> => ({
  key: t.key, name: t.name, summary: t.summary,
  topics: t.topics.map((x) => ({ key: x.key, name: x.name, description: x.description })),
  roles: t.roles.map((r) => ({ job_role: r.job_role, topics: r.topics.map((l) => ({ key: l.key, required: l.required, importance: l.importance })) })),
});

/** A job role in the body is optional (so the answer of the read can be sent back); if given it must be the one in the address. */
function sameRole(body: { job_role?: unknown }, role: string): void {
  if (body.job_role !== undefined && body.job_role !== role) throw problems.unprocessable('The job role in the body is not the one in the address');
}

export function topicRoutes(deps: GatewayDeps): RouteDef[] {
  const { authorizer, ai } = deps;
  /** The token claims for an AI-service call that names topics: only those this caller may read (topic:read). */
  const readClaims = async (tx: Tx, subject: Subject, decision: Decision, ctx: RequestContext): Promise<TokenClaims> =>
    ({ ...baseClaims(subject, decision, ctx), filter: await authorizer.filterSpec(tx, subject, 'topic:read', ctx) });
  return [
    withListFilter('delegated', keyGatewayRoute(deps, 'getGapReport',
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
      kind: 'gateway-or-key',   // also takes a machine's API key (openapi.yaml: x-api-key); the names come from the AI service
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('topic', subject.tenant_id) },
      prepare: async ({ tx, subject, query, ctx, decision }) => {
        const after = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'topic:read', TOPIC_DESCRIPTOR, ctx, 4);
        const { rows } = await tx.query<TopicRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${TOPIC_COLUMNS} FROM topics
            WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR id > $2::uuid) AND ${filter.sql} ORDER BY id LIMIT $3`,
          [query.status ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        const next = rows.length > query.limit && last ? encodeCursor(last.id) : null;
        const claims = await readClaims(tx, subject, decision, ctx);
        return {
          call: async () => {
            // Without the AI service there are no names: the request fails (502/503) instead of showing wrong ones.
            const texts = page.length === 0 ? {} : (await ai.call<{ topics: Record<string, TopicText> }>({
              path: '/internal/topics/texts', action: 'topic.texts', claims, json: { ids: page.map((r) => r.id) },
            })).topics ?? {};
            return { body: { items: page.map((r) => toApiTopic(r, texts[r.id])), next_cursor: next } };
          },
        };
      },
    },
    {
      operationId: 'createTopic',
      kind: 'gateway',
      policy: { resource: async ({ subject, body }) => newRef('topic', subject.tenant_id, { department_id: uuidOrNull(body.department_id), sensitivity: body.sensitivity ?? 0 }) },
      prepare: async ({ subject, decision, ctx, body }) => {
        const claims = baseClaims(subject, decision, ctx);
        const json = { name: body.name, description: body.description ?? '', department_id: body.department_id ?? null, sensitivity: body.sensitivity ?? 0 };
        return {
          call: async () => {
            // The AI service adds the topic and its search vector in one step; a topic of that name -> 409 duplicate-topic.
            const made = await ai.call({ path: '/internal/topics', action: 'topic.create', claims, json });
            return { status: 201, body: fromAi(made) };
          },
        };
      },
    },
    {
      operationId: 'updateTopic',
      kind: 'gateway',
      policy: { resource: ({ tx, subject, params }) => topicRef(tx, subject.tenant_id, params.topic_id) },
      prepare: async ({ subject, decision, ctx, params, body }) => {
        const claims = baseClaims(subject, decision, ctx);
        const json = { name: body.name ?? null, description: body.description ?? null, status: body.status ?? null };
        return {
          call: async () => {
            // The AI service checks the status change (409 illegal-transition) and the name (409 duplicate-topic).
            const after = await ai.call({ path: `/internal/topics/${params.topic_id}/change`, action: 'topic.update', subject: params.topic_id, claims, json });
            return { body: fromAi(after) };
          },
        };
      },
    },
    // Job roles are names, not records: the list is what the topic maps hold. A role appears only through topics the
    // caller may read, so a narrower grant sees fewer roles (and smaller counts), never another department's.
    {
      operationId: 'listJobRoles',
      kind: 'session-or-key',   // also takes a machine's API key (openapi.yaml: x-api-key)
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('topic', subject.tenant_id) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeNameCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'topic:read', TOPIC_DESCRIPTOR, ctx, 3);
        const { rows } = await tx.query<{ job_role: string; topic_count: number }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT m.job_role, count(*)::int AS topic_count
             FROM role_topic_maps m JOIN topics ON topics.tenant_id = m.tenant_id AND topics.id = m.topic_id
            WHERE topics.status <> 'retired' AND ($1::text IS NULL OR m.job_role > $1) AND ${filter.sql}
            GROUP BY m.job_role ORDER BY m.job_role LIMIT $2`,
          [after, query.limit + 1, ...filter.params]);
        return { body: pageOf(rows, query.limit, (last) => encodeNameCursor(last.job_role)) };
      },
    },
    {
      operationId: 'getRoleTopics',
      kind: 'session-or-key',   // also takes a machine's API key (openapi.yaml: x-api-key)
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('topic', subject.tenant_id) },
      handler: async ({ tx, subject, params, ctx }) => {
        const filter = await authorizer.filter(tx, subject, 'topic:read', TOPIC_DESCRIPTOR, ctx, 2);
        const { rows } = await tx.query<{ topic_id: string; required: boolean; importance: number }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT m.topic_id, m.required, m.importance
             FROM role_topic_maps m JOIN topics ON topics.tenant_id = m.tenant_id AND topics.id = m.topic_id
            WHERE m.job_role = $1 AND topics.status <> 'retired' AND ${filter.sql} ORDER BY m.importance DESC, m.topic_id`,
          [params.job_role, ...filter.params]);
        return { body: { job_role: params.job_role, topics: rows } };
      },
    },
    // Who holds a job role and who is to follow them is part of the gap picture, so it is read with gap:read.
    {
      operationId: 'getRolePeople',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => collectionRef('gap', subject.tenant_id) },
      handler: async ({ tx, subject, params, ctx }) => {
        const filter = await authorizer.filter(tx, subject, 'gap:read', ROLE_PERSON_DESCRIPTOR, ctx, 2);
        const { rows } = await tx.query<{ person_id: string; relation: string }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT j.person_id, j.relation
             FROM person_job_roles j JOIN people p ON p.tenant_id = j.tenant_id AND p.id = j.person_id
            WHERE j.job_role = $1 AND ${filter.sql} ORDER BY j.relation, j.person_id`,
          [params.job_role, ...filter.params]);
        return { body: { job_role: params.job_role, people: rows } };
      },
    },
    // The list REPLACES the role's topics among those this card can see: topics it may read (topic:read) that are not
    // retired - exactly what getRoleTopics shows it. A topic it cannot see keeps its place: it is neither shown nor
    // removed, and naming it answers 422 like a topic that does not exist (the same rule as setItemTopics).
    {
      operationId: 'setRoleTopics',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        sameRole(body, params.job_role);
        const entries = body.topics as Array<{ topic_id: string; required?: boolean; importance?: number }>;
        const visible = await authorizer.filter(tx, subject, 'topic:read', TOPIC_DESCRIPTOR, ctx, 2);
        const ids = [...new Set(entries.map((t) => t.topic_id))];
        const known = await tx.query<{ id: string }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT id FROM topics WHERE id = ANY($1::uuid[]) AND status <> 'retired' AND ${visible.sql}`, [ids, ...visible.params]);
        if (known.rows.length !== ids.length) throw problems.unprocessable('Unknown topic');
        const mine = await authorizer.filter(tx, subject, 'topic:read', TOPIC_DESCRIPTOR, ctx, 3);
        await tx.query(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `DELETE FROM role_topic_maps m USING topics
            WHERE topics.tenant_id = m.tenant_id AND topics.id = m.topic_id AND m.tenant_id = $1 AND m.job_role = $2
              AND topics.status <> 'retired' AND ${mine.sql}`,
          [subject.tenant_id, params.job_role, ...mine.params]);
        for (const t of entries) {
          await linkRoleTopic(tx, subject.tenant_id, subject.card_id,
            { job_role: params.job_role, topic_id: t.topic_id, required: t.required ?? true, importance: t.importance ?? 2 }, true);
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'topic:role_map', decision: 'event',
          reasonCode: 'ROLE_TOPICS_SET', requestId: ctx.requestId, ip: ctx.ip, details: { count: entries.length },
        });
        return { body: { job_role: params.job_role, topics: entries.map((t) => ({ topic_id: t.topic_id, required: t.required ?? true, importance: t.importance ?? 2 })) } };
      },
    },
    // The same rule for people: the list replaces the people of the role among those this card's gap report covers
    // (gap:read - what getRolePeople shows it); a person outside it keeps their place and cannot be named.
    {
      operationId: 'setRolePeople',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        sameRole(body, params.job_role);
        const entries = body.people as Array<{ person_id: string; relation: 'holder' | 'successor' }>;
        const visible = await authorizer.filter(tx, subject, 'gap:read', ROLE_PERSON_DESCRIPTOR, ctx, 2);
        const ids = [...new Set(entries.map((p) => p.person_id))];
        const known = await tx.query<{ id: string }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT p.id FROM people p WHERE p.id = ANY($1::uuid[]) AND ${visible.sql}`, [ids, ...visible.params]);
        if (known.rows.length !== ids.length) throw problems.unprocessable('Unknown person');
        const mine = await authorizer.filter(tx, subject, 'gap:read', ROLE_PERSON_DESCRIPTOR, ctx, 3);
        await tx.query(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `DELETE FROM person_job_roles j USING people p
            WHERE p.tenant_id = j.tenant_id AND p.id = j.person_id AND j.tenant_id = $1 AND j.job_role = $2 AND ${mine.sql}`,
          [subject.tenant_id, params.job_role, ...mine.params]);
        for (const p of entries) {
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
    // ---------------------------------------------------------------- department templates (feature 26)
    // The library is data in the repository (templates.ts), the same for every company; reading it shows no company data.
    {
      operationId: 'listTopicTemplates',
      kind: 'session',
      policy: { resource: async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }) },
      handler: async () => ({ body: { items: DEPARTMENT_TEMPLATES.map(toApiTemplate) } }),
    },
    // Applying a template ADDS what is missing and changes nothing that exists: a topic of the same name is kept as it
    // is, a map entry that exists is left alone. So applying twice creates nothing the second time.
    {
      operationId: 'applyTopicTemplate',
      kind: 'gateway',
      policy: { resource: async ({ subject }) => newRef('topic', subject.tenant_id, { sensitivity: 0 }) },
      prepare: async ({ tx, subject, decision, ctx, params }) => {
        const template = findTemplate(String(params.template_key));
        if (!template) throw problems.notFound();
        // An existing topic of the same name is used for the maps only if THIS card may read it; otherwise it is
        // skipped (and nothing says whether it exists at a level the card cannot see - "skipped" also counts retired
        // ones). The AI service decides that, with this card's topic:read filter: it alone can read the names.
        const claims = await readClaims(tx, subject, decision, ctx);
        const json = { topics: template.topics.map((t) => ({ key: t.key, name: t.name, description: t.description })) };
        return {
          call: async ({ withTx }) => {
            // Step 1: the AI service adds the missing topics (each with its search vector) and finds the existing ones.
            const r = await ai.call<{ topics: Array<{ key: string; id: string | null; created: boolean }> }>({
              path: '/internal/topics/template', action: 'topic.template', claims, json,
            });
            const idOf = new Map<string, string>();
            const createdIds: string[] = [];
            let skipped = 0;
            for (const t of r.topics ?? []) {
              if (t.id === null) {
                skipped += 1;
                continue;
              }
              idOf.set(t.key, t.id);
              if (t.created) createdIds.push(t.id);
            }
            // Step 2: the job-role maps and the audit entry. The topics above are ALREADY committed when this runs: if
            // it fails, they stay, and applying the template again adds the missing links.
            const body = await withTx(async (tx2) => {
              let linksCreated = 0;
              let linksExisting = 0;
              for (const role of template.roles) {
                for (const link of role.topics) {
                  const topicId = idOf.get(link.key);
                  if (topicId === undefined) continue;
                  const written = await linkRoleTopic(tx2, subject.tenant_id, subject.card_id,
                    { job_role: role.job_role, topic_id: topicId, required: link.required, importance: link.importance }, false);
                  if (written) linksCreated += 1;
                  else linksExisting += 1;
                }
              }
              await writeAudit(tx2, {
                tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'topic:template', decision: 'event',
                reasonCode: 'TOPIC_TEMPLATE_APPLIED', requestId: ctx.requestId, ip: ctx.ip, details: { template_key: template.key, count: createdIds.length },
              });
              return {
                template_key: template.key, topics_created: createdIds.length, created_topic_ids: createdIds,
                topics_existing: idOf.size - createdIds.length, topics_skipped: skipped, links_created: linksCreated, links_existing: linksExisting,
              };
            });
            return { status: 200, body };
          },
        };
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
  ];
}
