// HTTP endpoints for API keys (feature 28, part A): make one (its secret is shown once), list them, revoke one.
// These endpoints themselves never take a key: a key cannot make, list or revoke keys.
//
// As everywhere: handlers make no access decisions. Each route names what is acted on; the HTTP layer asks the
// policy decision point before the handler runs.
import { problems } from '../../../shared/errors.ts';
import type { ResourceRef, CardSubject } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, pageOf, writeAudit, type RouteDef, type Tx } from '../../platform/index.ts';
import { API_KEY_LIMITS, ApiKeyService, formatApiKey, keyRequestProblem, toApiKey, type KeyRequestProblem, type NewKeyRequest } from './api-keys.ts';
import type { Authorizer } from './authz.ts';
import { API_KEY_PERMISSIONS } from './policy.ts';

export interface ApiKeyRouteDeps {
  authorizer: Authorizer;
  apiKeys: ApiKeyService;
}

const PROBLEM_TEXT: Readonly<Record<KeyRequestProblem, string>> = {
  'empty-scope': 'Choose at least one thing the key may do',
  'permission-not-allowed-for-keys': 'A key cannot be given this permission',
  'permission-not-held': 'A key cannot do what the card that makes it cannot do',
  'level-above-own': 'A key cannot reach a level above the level of the card that makes it',
  'bad-expiry': 'A key must expire within a year',
  'bad-networks': 'The list of networks cannot be read',
  'bad-ask-limit': 'The number of questions per hour is outside what a key may have',
};

/** Of everything a card holds, what a key made by it may carry: permission -> highest level. Pure. */
export function heldForKeys(held: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...held].filter(([permission]) => API_KEY_PERMISSIONS.has(permission)));
}

const collection = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({ type: 'api_key', tenant_id: subject.tenant_id, collection: true });

export function apiKeyRoutes(deps: ApiKeyRouteDeps): RouteDef[] {
  const { authorizer, apiKeys } = deps;
  const oneKey = async ({ tx, subject, params }: { tx: Tx; subject: CardSubject; params: { api_key_id: string } }): Promise<ResourceRef | null> => {
    const row = await apiKeys.get(tx, subject.tenant_id, params.api_key_id);
    return row === null ? null : { type: 'api_key', id: row.id, tenant_id: subject.tenant_id };
  };
  return [
    {
      operationId: 'listApiKeys',
      kind: 'session',
      // Only the Company Owner holds this permission, for the whole company. A card holding it more narrowly - no
      // role does - is refused rather than given every key (decision D23).
      listFilter: { unfiltered: 'The keys of the whole company; they are not tied to a department or a level.' },
      policy: { resource: collection },
      handler: async ({ tx, subject, query, ctx }) => {
        const rows = await apiKeys.list(tx, subject.tenant_id, decodeIdCursor(query.cursor), query.limit + 1);
        return { body: pageOf(rows.map((r) => toApiKey(r, ctx.now)), query.limit, (last) => encodeCursor(last.id as string)) };
      },
    },
    {
      // What a key made by THIS card could carry, and the limits a key may have - so a screen offers nothing the API
      // would refuse. The answer is about the asking card, not about the company's keys.
      operationId: 'getApiKeyOptions',
      kind: 'session',
      listFilter: { unfiltered: 'Nothing of the company is listed: the answer describes what the asking card itself holds.' },
      policy: { resource: collection },
      handler: async ({ tx, subject, ctx }) => {
        const grantable = heldForKeys(await authorizer.heldLevels(tx, subject, ctx));
        return {
          body: {
            grantable: [...grantable].map(([permission, max_sensitivity]) => ({ permission, max_sensitivity })).sort((a, b) => a.permission.localeCompare(b.permission)),
            limits: {
              max_expires_in_days: API_KEY_LIMITS.maxDays, requests_per_minute: API_KEY_LIMITS.requestsPerMinute,
              default_asks_per_hour: API_KEY_LIMITS.defaultAsksPerHour, max_asks_per_hour: API_KEY_LIMITS.maxAsksPerHour,
            },
          },
        };
      },
    },
    {
      operationId: 'createApiKey',
      kind: 'session',
      policy: { resource: collection },
      handler: async ({ tx, subject, body, ctx }) => {
        const request = body as NewKeyRequest;
        const problem = keyRequestProblem(request, heldForKeys(await authorizer.heldLevels(tx, subject, ctx)));
        if (problem !== null) throw problems.unprocessable(PROBLEM_TEXT[problem]);
        const made = await apiKeys.create(tx, subject.tenant_id, subject.card_id, request, ctx);
        if (made === 'too-many-keys') throw problems.conflict('too-many-keys', 'The company has as many live keys as it may have; revoke one first');
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'api_key:manage', resourceType: 'api_key',
          resourceId: made.row.id, decision: 'event', reasonCode: 'API_KEY_CREATED', requestId: ctx.requestId, ip: ctx.ip,
          details: { api_key_id: made.row.id, scope: [...made.row.scope].sort().join(',') },
        });
        // The ONLY time the secret leaves the server. It is not stored: only its hash is - and the copy of this answer
        // kept for a retried request has `api_key` removed (the contract lists it under x-one-time-secrets), so a replay
        // cannot show it again.
        return {
          status: 201,
          body: { ...toApiKey(made.row, ctx.now), api_key: formatApiKey(subject.tenant_id, made.row.id, made.secret), secret_already_shown: false },
        };
      },
    },
    {
      operationId: 'revokeApiKey',
      kind: 'session',
      policy: { resource: oneKey },
      handler: async ({ tx, subject, params, ctx }) => {
        const revoked = await apiKeys.revoke(tx, subject.tenant_id, params.api_key_id, subject.card_id, ctx.now);
        if (revoked) {
          await writeAudit(tx, {
            tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'api_key:manage', resourceType: 'api_key',
            resourceId: params.api_key_id, decision: 'event', reasonCode: 'API_KEY_REVOKED', requestId: ctx.requestId, ip: ctx.ip,
            details: { api_key_id: params.api_key_id },
          });
        }
        const row = await apiKeys.get(tx, subject.tenant_id, params.api_key_id);
        if (row === null) throw problems.notFound();
        return { body: toApiKey(row, ctx.now) };
      },
    },
  ];
}
