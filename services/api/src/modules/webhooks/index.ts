// PUBLIC SURFACE of the webhooks module (Phase 4, feature 28 part B; docs/phase4/06-open-api-webhooks-email.md).
//
// What it does: the Company Owner registers https endpoints; knowledge events written to the outbox by the database
// (in the same transaction as the change) are sent to them as signed messages (the Standard Webhooks format),
// retried with growing waits, and an endpoint that keeps failing is paused. What it does NOT do: send anything while
// WEBHOOK_DELIVERY=none (the default); deliver events to endpoints that were off or paused when they happened; send
// any title, text or name - events hold identifiers and labels only.
//
// Nothing here imports another feature module: the platform gives it the database, the notifier and the keyring.
import type { Config, Database, Notifier, RouteDef, TenantSealing, Tx } from '../platform/index.ts';
import { runCompany, type RunResult } from './internal/deliver.ts';
import { WebhookStore } from './internal/endpoints.ts';
import { webhookRoutes } from './internal/routes.ts';
import { HttpsTransport, type WebhookTransport } from './internal/transport.ts';

export { checkedAddress, isPublicAddress, MAX_URL_LENGTH, pinnedLookup, urlProblem, type AddressProblem, type ResolvedAddress, type Resolver } from '../platform/index.ts';
export { endpointGets, messageBody, nextAttemptAt, shouldPause, TEST_TOPIC, TOPIC_TEXT, TOPICS, WEBHOOK_LIMITS, type OutboxEvent, type Topic } from './internal/rules.ts';
export { newSigningSecret, SECRET_PREFIX, SIGNATURE_TOLERANCE_SECONDS, signatureOf, signedHeaders, verifySignature } from './internal/signing.ts';
export { HttpsTransport, type HttpsTransportOptions, type SendError, type SendOutcome, type WebhookRequest, type WebhookTransport } from './internal/transport.ts';
export { fanOut, type RunResult } from './internal/deliver.ts';
export { secretAad, statusOf } from './internal/endpoints.ts';

export interface WebhooksModule {
  routes: RouteDef[];
  /** Whether this server sends anything (WEBHOOK_DELIVERY, or a transport given by a test). */
  readonly deliveryEnabled: boolean;
  /**
   * One delivery run for one company: turn its new events into deliveries, send what is due, record the outcomes.
   * Does nothing (all zeros) when delivery is switched off. Run by `npm run outbound:deliver` and by housekeeping.
   */
  runCompany(tenantId: string, now?: () => Date): Promise<RunResult>;
  /**
   * Housekeeping: events and finished deliveries older than `before` are removed. An event that was never sent
   * (delivery switched off, or nobody subscribed) goes too: the outbox is not an archive.
   */
  purge(tx: Tx, tenantId: string, before: Date): Promise<number>;
}

export function createWebhooks(deps: {
  config: Config; db: Database; notifier: Notifier;
  /** Seals endpoint signing secrets: with the platform's key, or the company's own (D35). */
  sealing: TenantSealing;
  /** For tests: a stand-in sender. Default: HttpsTransport when WEBHOOK_DELIVERY=https, otherwise nothing is sent. */
  transport?: WebhookTransport;
}): WebhooksModule {
  const store = new WebhookStore(deps.sealing);
  const transport = deps.transport ?? (deps.config.webhooks.delivery === 'https' ? new HttpsTransport() : null);
  const deliveryEnabled = transport !== null;
  return {
    routes: webhookRoutes({ store, deliveryEnabled }),
    deliveryEnabled,
    runCompany: async (tenantId, now = () => new Date()) => {
      if (transport === null) return { published: 0, queued: 0, delivered: 0, failed: 0, paused: 0 };
      return runCompany({ store, transport, notifier: deps.notifier, withTx: (fn) => deps.db.withTenantTx(tenantId, fn) }, tenantId, now);
    },
    purge: async (tx, tenantId, before) => {
      const events = await tx.query('DELETE FROM outbox_events WHERE tenant_id = $1 AND created_at < $2', [tenantId, before]);
      const deliveries = await tx.query(
        `DELETE FROM webhook_deliveries WHERE tenant_id = $1 AND status IN ('delivered', 'failed', 'cancelled') AND created_at < $2`, [tenantId, before]);
      return events.rowCount + deliveries.rowCount;
    },
  };
}
