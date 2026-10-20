// HTTP endpoints for outgoing webhooks (feature 28, part B). Company Owner only (webhook:read, webhook:manage);
// none of them takes an API key. As everywhere, handlers make no access decisions: each route names what is acted
// on and the HTTP layer asks the policy decision point before the handler runs.
import { problems } from '../../../shared/errors.ts';
import type { CardSubject, ResourceRef } from '../../../shared/policy-types.ts';
import { decodeIdCursor, encodeCursor, pageOf, writeAudit, type RouteDef, type Tx } from '../../platform/index.ts';
import { urlProblem, type AddressProblem } from './address.ts';
import { statusOf, toApiDelivery, toApiEndpoint, type EndpointChange, type NewEndpointRequest, type WebhookStore } from './endpoints.ts';
import { TOPIC_TEXT, TOPICS, WEBHOOK_LIMITS } from './rules.ts';

export interface WebhookRouteDeps {
  store: WebhookStore;
  /** Whether this server sends anything at all (WEBHOOK_DELIVERY). Shown to the Owner; it changes no rule. */
  deliveryEnabled: boolean;
}

const ADDRESS_TEXT: Readonly<Record<AddressProblem, string>> = {
  'not-https': 'The address must start with https://',
  credentials: 'The address must not contain a user name or password',
  fragment: 'The address must not contain a # part',
  'ip-literal': 'Use a host name, not an IP address',
  'bad-host': 'The host name cannot be read',
  'internal-host': 'The address must be reachable on the public internet, not an internal name',
  'too-long': 'The address is too long',
  unreadable: 'The address cannot be read',
};

const collection = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({ type: 'webhook_endpoint', tenant_id: subject.tenant_id, collection: true });

export function webhookRoutes(deps: WebhookRouteDeps): RouteDef[] {
  const { store } = deps;
  const oneEndpoint = async ({ tx, subject, params }: { tx: Tx; subject: CardSubject; params: { webhook_id: string } }): Promise<ResourceRef | null> => {
    const row = await store.get(tx, subject.tenant_id, params.webhook_id);
    return row === null ? null : { type: 'webhook_endpoint', id: row.id, tenant_id: subject.tenant_id };
  };
  const audit = (tx: Tx, subject: CardSubject, id: string, reasonCode: string, ctx: { requestId: string; ip: string }, extra: Record<string, string> = {}): Promise<void> =>
    writeAudit(tx, {
      tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'webhook:manage', resourceType: 'webhook_endpoint',
      resourceId: id, decision: 'event', reasonCode, requestId: ctx.requestId, ip: ctx.ip, details: { webhook_id: id, ...extra },
    });
  return [
    {
      operationId: 'listWebhookEndpoints',
      kind: 'session',
      // Only the Company Owner holds this permission, for the whole company (decision D23, as for API keys).
      listFilter: { unfiltered: 'The endpoints of the whole company; they are not tied to a department or a level.' },
      policy: { resource: collection },
      handler: async ({ tx, subject, query }) => {
        const rows = await store.list(tx, subject.tenant_id, decodeIdCursor(query.cursor), query.limit + 1);
        return { body: pageOf(rows.map(toApiEndpoint), query.limit, (last) => encodeCursor(last.id as string)) };
      },
    },
    {
      operationId: 'getWebhookOptions',
      kind: 'session',
      listFilter: { unfiltered: 'Nothing of the company is listed: the answer describes the events and the limits.' },
      policy: { resource: collection },
      handler: async () => ({
        body: {
          topics: TOPICS.map((topic) => ({ topic, description: TOPIC_TEXT[topic] })),
          delivery_enabled: deps.deliveryEnabled,
          limits: {
            max_endpoints: WEBHOOK_LIMITS.maxPerCompany, max_attempts: WEBHOOK_LIMITS.maxAttempts,
            timeout_seconds: WEBHOOK_LIMITS.timeoutMs / 1000, pause_after_failures: WEBHOOK_LIMITS.pauseAfterFailures,
          },
        },
      }),
    },
    {
      operationId: 'createWebhookEndpoint',
      kind: 'session',
      policy: { resource: collection },
      handler: async ({ tx, subject, body, ctx }) => {
        const request = body as NewEndpointRequest;
        const problem = urlProblem(request.url);
        if (problem !== null) throw problems.unprocessable(ADDRESS_TEXT[problem]);
        const made = await store.create(tx, subject.tenant_id, subject.card_id, request, ctx.now);
        if (made === 'too-many-endpoints') throw problems.conflict('too-many-endpoints', 'The company has as many endpoints as it may have; remove one first');
        await audit(tx, subject, made.row.id, 'WEBHOOK_CREATED', ctx, { scope: made.row.topics.join(',') });
        // The ONLY time the secret leaves the server in a creation answer. The copy kept for a retried request has
        // `signing_secret` removed (x-one-time-secrets), so a replay cannot show it again.
        return { status: 201, body: { ...toApiEndpoint(made.row), signing_secret: made.secret, secret_already_shown: false } };
      },
    },
    {
      operationId: 'updateWebhookEndpoint',
      kind: 'session',
      policy: { resource: oneEndpoint },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const change = body as EndpointChange;
        const row = await store.update(tx, subject.tenant_id, params.webhook_id, change, ctx.now);
        if (row === null) throw problems.conflict('webhook-removed', 'The endpoint was removed');
        await audit(tx, subject, row.id, 'WEBHOOK_UPDATED', ctx, { changed: Object.keys(change).sort().join(','), status: statusOf(row) });
        return { body: toApiEndpoint(row) };
      },
    },
    {
      operationId: 'removeWebhookEndpoint',
      kind: 'session',
      policy: { resource: oneEndpoint },
      handler: async ({ tx, subject, params, ctx }) => {
        if (await store.remove(tx, subject.tenant_id, params.webhook_id, subject.card_id, ctx.now)) {
          await audit(tx, subject, params.webhook_id, 'WEBHOOK_REMOVED', ctx);
        }
        const row = await store.get(tx, subject.tenant_id, params.webhook_id);
        if (row === null) throw problems.notFound();
        return { body: toApiEndpoint(row) };
      },
    },
    {
      operationId: 'rotateWebhookSecret',
      kind: 'session',
      policy: { resource: oneEndpoint },
      handler: async ({ tx, subject, params, ctx }) => {
        const rotated = await store.rotate(tx, subject.tenant_id, params.webhook_id, ctx.now);
        if (rotated === null) throw problems.conflict('webhook-removed', 'The endpoint was removed');
        await audit(tx, subject, params.webhook_id, 'WEBHOOK_SECRET_ROTATED', ctx);
        return { body: { ...toApiEndpoint(rotated.row), signing_secret: rotated.secret, secret_already_shown: false } };
      },
    },
    {
      operationId: 'sendWebhookTest',
      kind: 'session',
      policy: { resource: oneEndpoint },
      handler: async ({ tx, subject, params, ctx }) => {
        const row = await store.get(tx, subject.tenant_id, params.webhook_id);
        if (row === null) throw problems.notFound();
        if (statusOf(row) !== 'active') throw problems.conflict('webhook-not-active', 'Switch the endpoint on first; a removed endpoint sends nothing');
        const delivery = await store.queueTest(tx, subject.tenant_id, row, ctx.now);
        await audit(tx, subject, row.id, 'WEBHOOK_TEST_QUEUED', ctx);
        return { status: 202, body: toApiDelivery(delivery) };
      },
    },
    {
      operationId: 'listWebhookDeliveries',
      kind: 'session',
      listFilter: { unfiltered: "One endpoint's deliveries; the endpoint itself was checked like any single resource." },
      policy: { resource: oneEndpoint },
      handler: async ({ tx, subject, params, query }) => {
        const rows = await store.deliveries(tx, subject.tenant_id, params.webhook_id, decodeIdCursor(query.cursor), query.limit + 1);
        return { body: pageOf(rows.map(toApiDelivery), query.limit, (last) => encodeCursor(last.id as string)) };
      },
    },
  ];
}
