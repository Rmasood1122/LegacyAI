// Wires the modules together. This file and main.ts are the ONLY places allowed to do so.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBilling, type BillingModule, type BillingPort, type PaymentProvider } from './modules/billing/index.ts';
import { createIdentityAccess, type AnomalySettings, type AuthLimits, type IdentityAccess, type OidcHttp } from './modules/identity-access/index.ts';
import { createKnowledgeGateway, type KnowledgeGateway } from './modules/knowledge-gateway/index.ts';
import { createMail, type MailModule, type MailSender } from './modules/mail/index.ts';
import { createWebhooks, type WebhookTransport, type WebhooksModule } from './modules/webhooks/index.ts';
import {
  createHttpServer, createLogger, Database, ExportRegistry, keyServiceFrom, LogNotifier, platformRoutes, PostgresIdempotencyStore,
  PostgresRateLimiter, SealingCipher, StaticSite, TenantSealing, type Config, type HttpServer, type KeyService, type Logger, type Notifier, type RateLimiter,
} from './modules/platform/index.ts';
import { systemClock, type Clock } from './shared/clock.ts';

export interface AppOverrides {
  clock?: Clock;
  logger?: Logger;
  notifier?: Notifier;
  rateLimiter?: RateLimiter;
  /** Replaces the plan-limit answer only (tests of other modules); the billing routes stay the real ones. */
  billing?: BillingPort;
  /** A stand-in payment provider for tests. Default: what the configuration names ('none' or 'fake'). */
  paymentProvider?: PaymentProvider;
  /** For tests: how long a payment provider gets to answer (default 10 seconds). */
  providerTimeoutMs?: number;
  authLimits?: AuthLimits;
  anomalyDefaults?: AnomalySettings;
  generalLimit?: { limit: number; windowSeconds: number };
  /** A stand-in for company identity providers in tests (SSO). Default: the guarded https client. */
  oidcHttp?: OidcHttp;
  /** A stand-in webhook sender for tests. Default: what WEBHOOK_DELIVERY names ('none' sends nothing). */
  webhookTransport?: WebhookTransport;
  /** A stand-in e-mail sender for tests. Default: what MAIL_SENDER names ('none' queues and sends nothing). */
  mailSender?: MailSender;
  /** Bring-your-own-key: a key service for tests (a LocalKeyService the test can switch keys off in). Default: KEY_SERVICE. */
  keyService?: KeyService;
  /** How long unwrapped company data keys are kept in memory (default 300 seconds; tests use 0). */
  keyCacheSeconds?: number;
}

export interface App {
  http: HttpServer;
  db: Database;
  log: Logger;
  identity: IdentityAccess;
  billing: BillingModule;
  /** The knowledge module's jobs (its routes are already on `http`). */
  knowledge: Pick<KnowledgeGateway, 'upkeep'>;
  webhooks: WebhooksModule;
  mail: MailModule;
  exports: ExportRegistry;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = path.resolve(here, '..', 'openapi.yaml');

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const log = overrides.logger ?? createLogger(config.logLevel);
  // Read before anything is opened: a folder that is not a usable web build stops start-up.
  const staticSite = config.webDistDir === null ? undefined : StaticSite.load(config.webDistDir);
  const db = new Database(config.databaseUrl.reveal(), config.dbPoolMax);

  // Refuse to run with a database role that could bypass tenant isolation.
  try {
    await db.assertSafeRole();
  } catch (err) {
    await db.close();
    throw err;
  }

  const clock = overrides.clock ?? systemClock;
  const rateLimiter = overrides.rateLimiter ?? new PostgresRateLimiter(db, config.hmacIndexKey.reveal());
  // Notices are logged as before; when an e-mail sender is configured they are also queued for e-mail (part C).
  const mail = createMail({ config, db, log, notifier: overrides.notifier ?? new LogNotifier(log), sender: overrides.mailSender });
  const notifier = mail.notifier;
  const exports = new ExportRegistry();
  exports.register({
    table: 'audit_log',
    columns: ['seq', 'occurred_at', 'actor_card_id', 'actor_kind', 'action', 'resource_type', 'resource_id', 'decision', 'reason_code', 'request_id', 'ip', 'details', 'prev_hash', 'row_hash'],
    orderBy: 'seq',
  });

  // Billing answers the policy decision point's plan-limit question; the identity module gives billing the company's
  // term (the company card's dates). Each knows the other only through a port.
  const billing = createBilling({ config, db, notifier, rateLimiter, log, provider: overrides.paymentProvider, providerTimeoutMs: overrides.providerTimeoutMs });
  // Every secret the API keeps for a company is sealed by ONE sealer: the platform's key, or the company's own (D35).
  const sealing = new TenantSealing({
    platform: new SealingCipher(config.credentialEnc), keys: overrides.keyService ?? keyServiceFrom(config.keyService), cacheSeconds: overrides.keyCacheSeconds,
  });
  const identity = createIdentityAccess({
    config, db, rateLimiter, notifier, billing: overrides.billing ?? billing.port, exports, limits: overrides.authLimits, anomalyDefaults: overrides.anomalyDefaults, log,
    oidcHttp: overrides.oidcHttp, sealing,
  });

  const http = await createHttpServer({
    config, db, log, clock, auth: identity.authPort, rateLimiter, idempotency: new PostgresIdempotencyStore(),
    contractPath: CONTRACT_PATH, generalLimit: overrides.generalLimit, staticSite,
  });
  http.defineRoutes(platformRoutes({ config, db, exports }));
  billing.useTerm(identity.companyTerm);
  http.defineRoutes(identity.routes);
  http.defineRoutes(billing.routes);
  const knowledge = createKnowledgeGateway({ config, db, authorizer: identity.authorizer, notifier, rateLimiter });
  // the retirement radar (identity) shows what is held from a person; the knowledge module answers that, by its own rules
  identity.usePersonHoldings(knowledge.personHoldings);
  http.defineRoutes(knowledge.routes);
  // who receives a notice by e-mail is the identity module's answer; the mail module only asks
  mail.useDirectory(identity.recipients);
  const webhooks = createWebhooks({ config, db, notifier, transport: overrides.webhookTransport, sealing });
  http.defineRoutes(webhooks.routes);

  // Every operation in openapi.yaml must have a route, and vice versa.
  const registered = new Set(http.registeredRoutes().map((r) => r.operationId));
  const missing = [...http.contract.operations.keys()].filter((id) => !registered.has(id));
  if (missing.length > 0) {
    await db.close();
    throw new Error(`openapi.yaml declares operations with no route: ${missing.join(', ')}`);
  }

  await http.app.ready();
  return {
    http, db, log, identity, billing, knowledge, webhooks, mail, exports,
    close: async () => {
      await http.app.close();
      await mail.flush();
      await db.close();
    },
  };
}
