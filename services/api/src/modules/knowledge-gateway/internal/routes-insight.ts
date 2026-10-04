// Activity numbers (feature 27) and the knowledge map (feature 30). Both read what the AI service owns, so the
// API decides and passes the request on with the caller's own filters (docs/phase4/03-analytics-graph-scenarios-qr.md,
// decision D27). Nothing from the AI service reaches the caller unpicked.
import { problems } from '../../../shared/errors.ts';
import type { RouteDef } from '../../platform/index.ts';
import { gatewayRoute, pick, withListFilter, type GatewayDeps } from './common.ts';
import { collectionRef } from './resources.ts';

const MONTH = ['month_start', 'documents_added', 'items_captured', 'items_verified', 'median_hours_to_verify', 'interviews_completed', 'tests_handed_in'] as const;
const JOB_ROLE = ['job_role', 'state', 'people', 'attempts', 'mean_score'] as const;
const NODE = ['kind', 'id', 'label', 'status'] as const;
const GROUP_ORDER = ['topics', 'items', 'sources', 'job_roles', 'conflicting_items'] as const;

// Declared "unfiltered" (decision D23) because the answer cannot be narrowed BY THIS ROUTE'S OWN PERMISSION to a
// department or a person: a card holding knowledge_settings:read at a narrower scope - no role does today - is
// refused. Inside the answer every number IS narrowed, by the right that governs what it counts: documents and
// items by knowledge:read, interviews by interview:read, tests by quiz:read_results (the three filters go in the
// token); a number the card has no right to at all is null.
const COMPANY_NUMBERS = {
  unfiltered: 'One table of activity counts for the company; it has no department or owner to narrow by. Each count is narrowed by the caller\'s own right to read what it counts.',
};
/** The read permissions, besides knowledge:read, whose filters the activity numbers need. */
const ACTIVITY_FILTERS = ['interview:read', 'quiz:read_results'] as const;

/** Taking the whole map out: at most this many times per card in an hour. */
export const GRAPH_EXPORTS_PER_HOUR = 5;

const node = (n: any) => pick(n, NODE);
const ref = (r: any) => pick(r, ['kind', 'id']);

export function insightRoutes(deps: GatewayDeps): RouteDef[] {
  return [
    withListFilter(COMPANY_NUMBERS, gatewayRoute(deps, 'getActivity',
      async ({ subject }) => collectionRef('quality', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/analytics/activity', action: 'analytics.activity', filterAction: 'knowledge:read', moreFilters: ACTIVITY_FILTERS,
        json: { months: query.months ?? 6 },
        map: (r) => ({
          months: (r.months ?? []).map((m: any) => pick(m, MONTH)),
          items_now: pick(r.items_now, ['verified', 'stale_items', 'not_yet_verified']),
          job_role_results: {
            ...pick(r.job_role_results, ['state', 'window_start', 'window_end', 'minimum_group', 'max_rows']),
            truncated: r.job_role_results?.truncated === true,
            rows: (r.job_role_results?.rows ?? []).map((j: any) => pick(j, JOB_ROLE)),
          },
        }),
      }))),
    // The map is read with the right to read knowledge; both filters go along (items and documents by
    // knowledge:read, topics by topic:read), so the list is narrowed where the data lives.
    withListFilter('delegated', gatewayRoute(deps, 'getGraphNeighbourhood',
      async ({ subject }) => collectionRef('knowledge_item', subject.tenant_id),
      async ({ query }) => ({
        path: '/internal/graph/neighbours', action: 'graph.read', filterAction: 'knowledge:read', topicFilter: true,
        json: { kind: query.kind, id: query.id },
        map: (r) => {
          const groups: any[] = Array.isArray(r.neighbours) ? r.neighbours : [];
          return {
            node: node(r.node),
            // only the groups this kind of node has, in a fixed order
            neighbours: GROUP_ORDER.flatMap((name) => groups.filter((g) => g?.group === name)).map((g) => ({
              group: g.group, edge_kind: g.edge_kind, truncated: g.truncated === true,
              nodes: (g.nodes ?? []).map((n: any) => ({ node: node(n.node), origin: n.origin ?? null })),
            })),
            limit_per_group: r.limit_per_group,
          };
        },
      }))),
    // Taking the whole map out is an EXPORT (decision D27): it needs the right to export - a write permission, held
    // by the Company Owner - and is limited per card. What goes into the file is still narrowed by the card's own
    // rights to read knowledge and topics, and the AI service writes the audit entry (counts only).
    gatewayRoute(deps, 'exportKnowledgeGraph',
      async ({ subject }) => collectionRef('export', subject.tenant_id),   // as createExport does: a company-wide grant is needed
      async ({ subject, ctx }) => {
        const hit = await deps.rateLimiter.hit(`graph-export:${subject.card_id}`, GRAPH_EXPORTS_PER_HOUR, 3600, ctx.now);
        if (!hit.allowed) throw problems.tooManyRequests(hit.retryAfterSeconds);
        return {
          path: '/internal/graph/export', action: 'graph.export', filterAction: 'knowledge:read', topicFilter: true,
          map: (r) => ({
            schema: r.schema,
            nodes: (r.nodes ?? []).map(node),
            edges: (r.edges ?? []).map((e: any) => ({ kind: e.kind, from: ref(e.from), to: ref(e.to), origin: e.origin ?? null })),
            truncated: r.truncated === true,
            limits: pick(r.limits, ['nodes_per_kind', 'edges']),
          }),
        };
      }),
  ];
}
