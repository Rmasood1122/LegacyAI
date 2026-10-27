// Offline packs (feature 9; the founder's choices of 2026-10-27): the verified knowledge of one job role, for the web
// app to read and search without a connection. What may go in is decided by the AI service (verified, level 0 or 1,
// what this card may read, linked to the role's topics: services/ai/app/knowledge/offline.py); the API stamps when the
// pack was made and until when it may be opened offline, and writes the audit entry. A card only - not a machine's key.
import { writeAudit, type RouteDef } from '../../platform/index.ts';
import { baseClaims, pick, withListFilter, type GatewayDeps } from './common.ts';
import { collectionRef } from './resources.ts';

/** How long a pack may be opened without a connection (the founder's choice of 2026-10-27). */
export const OFFLINE_PACK_DAYS = 7;
const DAY_MS = 86_400_000;

export function offlineRoutes(deps: GatewayDeps): RouteDef[] {
  const { authorizer, ai } = deps;
  return [
    // the read filters are applied by the AI service (both are in the token), like the knowledge list
    withListFilter('delegated', {
      operationId: 'getOfflinePack',
      kind: 'gateway',
      policy: { resource: async ({ subject }) => collectionRef('knowledge_item', subject.tenant_id) },
      prepare: async ({ tx, subject, decision, ctx, query }) => {
        const claims = {
          ...baseClaims(subject, decision, ctx),
          filter: await authorizer.filterSpec(tx, subject, 'knowledge:read', ctx),
          topic_filter: await authorizer.filterSpec(tx, subject, 'topic:read', ctx),
        };
        const asOf = ctx.now;
        return {
          call: async ({ withTx }) => {
            const r = await ai.call<any>({ path: '/internal/offline/pack', action: 'offline.pack', claims, json: { job_role: query.job_role } });
            const items = (r.items ?? []).map((i: any) => pick(i, ['id', 'title', 'body', 'status', 'sensitivity', 'verified_at', 'topic_ids']));
            await withTx((tx2) => writeAudit(tx2, {
              tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'knowledge:offline_pack', decision: 'event',
              reasonCode: 'OFFLINE_PACK_ISSUED', requestId: ctx.requestId, ip: ctx.ip,
              details: { count: items.length },
            }));
            return {
              body: {
                job_role: query.job_role, as_of: asOf.toISOString(), expires_at: new Date(asOf.getTime() + OFFLINE_PACK_DAYS * DAY_MS).toISOString(),
                max_sensitivity: 1, topics: (r.topics ?? []).map((t: any) => pick(t, ['topic_id', 'name'])), items, truncated: r.truncated === true,
              },
            };
          },
        };
      },
    }),
  ];
}
