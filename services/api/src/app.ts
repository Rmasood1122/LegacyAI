// Wires the modules together. This file and main.ts are the ONLY places allowed to do so.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StubBilling, type BillingPort } from './modules/billing/index.ts';
import { createIdentityAccess, type AuthLimits, type IdentityAccess } from './modules/identity-access/index.ts';
import {
  createHttpServer, createLogger, Database, ExportRegistry, LogNotifier, platformRoutes, PostgresIdempotencyStore,
  PostgresRateLimiter, type Config, type HttpServer, type Logger, type Notifier, type RateLimiter,
} from './modules/platform/index.ts';
import { systemClock, type Clock } from './shared/clock.ts';

export interface AppOverrides {
  clock?: Clock;
  logger?: Logger;
  notifier?: Notifier;
  rateLimiter?: RateLimiter;
  billing?: BillingPort;
  authLimits?: AuthLimits;
  generalLimit?: { limit: number; windowSeconds: number };
}

export interface App {
  http: HttpServer;
  db: Database;
  log: Logger;
  identity: IdentityAccess;
  exports: ExportRegistry;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = path.resolve(here, '..', 'openapi.yaml');

export async function createApp(config: Config, overrides: AppOverrides = {}): Promise<App> {
  const log = overrides.logger ?? createLogger(config.logLevel);
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
  const notifier = overrides.notifier ?? new LogNotifier(log);
  const exports = new ExportRegistry();
  exports.register({
    table: 'audit_log',
    columns: ['seq', 'occurred_at', 'actor_card_id', 'actor_kind', 'action', 'resource_type', 'resource_id', 'decision', 'reason_code', 'request_id', 'ip', 'details', 'prev_hash', 'row_hash'],
    orderBy: 'seq',
  });

  const identity = createIdentityAccess({
    config, db, rateLimiter, notifier, billing: overrides.billing ?? new StubBilling(), exports, limits: overrides.authLimits,
  });

  const http = await createHttpServer({
    config, db, log, clock, auth: identity.authPort, rateLimiter, idempotency: new PostgresIdempotencyStore(),
    contractPath: CONTRACT_PATH, generalLimit: overrides.generalLimit,
  });
  http.defineRoutes(platformRoutes({ config, db, exports }));
  http.defineRoutes(identity.routes);

  // Every operation in openapi.yaml must have a route, and vice versa.
  const registered = new Set(http.registeredRoutes().map((r) => r.operationId));
  const missing = [...http.contract.operations.keys()].filter((id) => !registered.has(id));
  if (missing.length > 0) {
    await db.close();
    throw new Error(`openapi.yaml declares operations with no route: ${missing.join(', ')}`);
  }

  await http.app.ready();
  return {
    http, db, log, identity, exports,
    close: async () => {
      await http.app.close();
      await db.close();
    },
  };
}
