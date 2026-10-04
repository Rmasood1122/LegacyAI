// HTTP endpoints for the anomaly lock (feature 5): the company's rules, and the times a rule fired.
// (The retirement radar's endpoints are in routes-leaving.ts.)
//
// As everywhere: handlers make no access decisions. Each route names what is acted on; the HTTP layer asks the
// policy decision point before the handler runs.
import type { ResourceRef, CardSubject } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, pageOf, writeAudit, type RouteDef } from '../../platform/index.ts';
import type { AnomalyGuard, AnomalySettings } from './anomaly.ts';
import type { Authorizer } from './authz.ts';
import { maskCardNumber } from './card-number.ts';
import type { ResourceDescriptor } from './policy.ts';

export interface SafetyRouteDeps {
  authorizer: Authorizer;
  anomaly: AnomalyGuard;
}

// A usage-history row is narrowed like the card it belongs to.
const EVENT_CARD_DESCRIPTOR: ResourceDescriptor = {
  type: 'card',
  tenantExpr: 'e.tenant_id',
  ownerCardExpr: 'e.card_id',
  ownerPersonExpr: 'c.person_id',
  departmentExpr: '(SELECT p.department_id FROM people p WHERE p.tenant_id = c.tenant_id AND p.id = c.person_id)',
};

const settingsResource = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type: 'tenant_settings', id: subject.tenant_id, tenant_id: subject.tenant_id,
});

/** What is shown of a stored rule name. Something this code does not know is shown as "unknown", never as a rule it is not. */
export const shownRule = (stored: unknown): 'denials' | 'second_address' | 'unknown' =>
  (stored === 'denials' || stored === 'second_address' ? stored : 'unknown');

export function safetyRoutes(deps: SafetyRouteDeps): RouteDef[] {
  const { authorizer, anomaly } = deps;
  return [
    {
      operationId: 'getAnomalySettings',
      kind: 'session',
      policy: { resource: settingsResource },
      handler: async ({ tx, subject }) => ({ body: await anomaly.settings(tx, subject.tenant_id) }),
    },
    {
      operationId: 'updateAnomalySettings',
      kind: 'session',
      policy: { resource: settingsResource },
      handler: async ({ tx, subject, body, ctx }) => {
        const { settings, changes } = await anomaly.update(tx, subject.tenant_id, body as Partial<AnomalySettings>, subject.card_id, ctx.now);
        // One row per changed setting, with the old and the new value (switches and numbers only), so that
        // "the lock was switched off" can be told apart from any other edit.
        for (const change of changes) {
          await writeAudit(tx, {
            tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'tenant_settings:update',
            resourceType: 'tenant_settings', resourceId: subject.tenant_id, decision: 'event', reasonCode: 'ANOMALY_SETTINGS_CHANGED',
            requestId: ctx.requestId, ip: ctx.ip, details: { changed: change.key, state_from: String(change.from), state_to: String(change.to) },
          });
        }
        return { body: settings };
      },
    },
    // The times a rule fired, newest first: which card, which rule, how many, and what happened to the card THEN
    // (it may have been unlocked since - the card itself says whether it is locked now). No addresses, no names.
    {
      operationId: 'listAnomalyEvents',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => ({ type: 'card', tenant_id: subject.tenant_id, collection: true }) },
      handler: async ({ tx, subject, query, ctx }) => {
        const before = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'card_events:read', EVENT_CARD_DESCRIPTOR, ctx, 3);
        const { rows } = await tx.query<{
          id: string; card_id: string; card_number: string; occurred_at: Date; event_type: string; metadata: { rule?: unknown; count?: unknown };
        }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT e.id, e.card_id, c.card_number, e.occurred_at, e.event_type, e.metadata
             FROM card_events e JOIN cards c ON c.tenant_id = e.tenant_id AND c.id = e.card_id
            WHERE e.event_type IN ('anomaly_locked', 'anomaly_not_locked') AND ($1::uuid IS NULL OR e.id < $1::uuid) AND ${filter.sql}
            ORDER BY e.id DESC LIMIT $2`,
          [before, query.limit + 1, ...filter.params]);
        return {
          body: pageOf(rows.map((e) => ({
            id: e.id, card_id: e.card_id, card_number: maskCardNumber(e.card_number), occurred_at: e.occurred_at.toISOString(),
            outcome: e.event_type === 'anomaly_locked' ? 'locked' : 'not_locked_last_owner',
            rule: shownRule(e.metadata.rule),
            count: typeof e.metadata.count === 'number' ? e.metadata.count : null,
          })), query.limit, (last) => encodeCursor(last.id)),
        };
      },
    },
  ];
}
