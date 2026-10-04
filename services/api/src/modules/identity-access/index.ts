// PUBLIC SURFACE of the identity-access module (backend Part 1).
// Other modules may import ONLY from this file - never from ./internal/*.

import type { BillingPort } from '../billing/index.ts';
import type { AuthPort, Config, Database, ExportRegistry, Notifier, RateLimiter, RouteDef, Tx } from '../platform/index.ts';
import { AnomalyGuard, type AnomalySettings } from './internal/anomaly.ts';
import { AuthService, DEFAULT_AUTH_LIMITS, type AuthLimits } from './internal/auth.ts';
import { Authorizer } from './internal/authz.ts';
import { CardService } from './internal/cards.ts';
import { SeedCipher } from './internal/factors.ts';
import { sweepRetirementNudges } from './internal/leaving.ts';
import { identityRoutes } from './internal/routes.ts';
import { leavingRoutes, type PersonHoldingsLoader } from './internal/routes-leaving.ts';
import { safetyRoutes } from './internal/routes-safety.ts';
import { SecretCodeHasher } from './internal/secret-code.ts';
import { resolveSession, tenantOfToken } from './internal/sessions.ts';

export {
  ANOMALY_DEFAULTS, ANOMALY_LIMITS, COUNTED_REASONS, countsTowardAnomaly, shouldLockForDenials, shouldLockForSecondAddress, UNCOUNTED_REASONS,
  validateAnomalyPatch, type AnomalySettings,
} from './internal/anomaly.ts';
export { shownRule } from './internal/routes-safety.ts';
export { DEFAULT_AUTH_LIMITS, type AuthLimits } from './internal/auth.ts';
export {
  addMonths, isRealDate, monthsLeft, NUDGE_STAGES, RADAR_HORIZON_MONTHS, stageOf, sweepRetirementNudges, validateLeavingDate,
} from './internal/leaving.ts';
export { decodeRadarCursor, encodeRadarCursor, type PersonHoldings, type PersonHoldingsLoader } from './internal/routes-leaving.ts';
export { bootstrapOperator, recoverOperator, type BootstrapResult } from './internal/bootstrap.ts';
export { Authorizer, loadMatrix, type KnowledgeSettingsLoader } from './internal/authz.ts';
export {
  dammCheckDigit, dammValid, formatCardNumber, generateCardNumber, isValidCardNumber, luhnValid, maskCardNumber, normalizeCardNumber,
} from './internal/card-number.ts';
export { CardService } from './internal/cards.ts';
export { SeedCipher, StrongFactorProof } from './internal/factors.ts';
export {
  accessPhase, canTransition, CARD_STATES, computeDates, effectiveState, LEGAL_TRANSITIONS, TERMINAL_STATES,
} from './internal/lifecycle.ts';
export {
  buildResourceFilter, buildResourceFilterSpec, decide, usageKey,
  type FilterGrant, type FilterSpec, type Grant, type Matrix, type PermissionDef, type PolicyContext, type ResourceDescriptor,
  type ResourceFilter, type Restriction,
} from './internal/policy.ts';
export { ScProof, SecretCodeHasher } from './internal/secret-code.ts';
export { createSession, csrfTokenFor, tenantOfToken, VerifiedLogin } from './internal/sessions.ts';

export interface IdentityAccessDeps {
  config: Config;
  db: Database;
  rateLimiter: RateLimiter;
  notifier: Notifier;
  billing: BillingPort;
  exports: ExportRegistry;
  limits?: AuthLimits;
  /** Anomaly-lock rules for companies that have not set their own (default: ANOMALY_DEFAULTS). */
  anomalyDefaults?: AnomalySettings;
  /** Where a failure of the anomaly counter is reported (it must never fail the refusal it was counting). */
  log?: { error(fields: Record<string, unknown>, message: string): void };
}

export interface IdentityAccess {
  routes: RouteDef[];
  /** Plugged into the platform HTTP layer by app.ts. */
  authPort: AuthPort;
  cards: CardService;
  authorizer: Authorizer;
  hasher: SecretCodeHasher;
  /** Creates the retirement-radar nudges that are due for one company (each once). Run by the housekeeping job. */
  retirementSweep(tx: Tx, tenantId: string, now: Date, requestId: string): Promise<number>;
  /** Plugs in what the knowledge module holds from a person (job roles, counts), narrowed by the asking card's rights there. */
  usePersonHoldings(loader: PersonHoldingsLoader): void;
}

export function createIdentityAccess(deps: IdentityAccessDeps): IdentityAccess {
  const { config, db } = deps;
  const hmacKey = config.hmacIndexKey.reveal();
  const hasher = new SecretCodeHasher(config.scPepper, config.argon2);
  const cipher = new SeedCipher(config.credentialEnc);
  const cards = new CardService({ hasher, notifier: deps.notifier, hmacKey });
  const authorizer = new Authorizer(deps.billing);
  let holdings: PersonHoldingsLoader | null = null;
  const anomaly = new AnomalyGuard({ cards, notifier: deps.notifier, hmacKey, defaults: deps.anomalyDefaults });
  const auth = new AuthService({
    db, hasher, cipher, cards, authorizer, anomaly, rateLimiter: deps.rateLimiter, notifier: deps.notifier, hmacKey,
    webauthn: { rpId: config.webauthn.rpId, rpName: config.webauthn.rpName, origins: config.allowedOrigins },
    limits: deps.limits ?? DEFAULT_AUTH_LIMITS,
  });

  // What a tenant export contains from this module. Column lists are explicit: no SC hashes,
  // no credential key material, no session or token hashes.
  deps.exports.register({ table: 'departments', columns: ['id', 'name', 'created_at'], orderBy: 'id' });
  deps.exports.register({ table: 'people', columns: ['id', 'display_name', 'email', 'department_id', 'status', 'created_at'], orderBy: 'id' });
  deps.exports.register({
    table: 'cards',
    columns: ['id', 'kind', 'person_id', 'card_number', 'state', 'issued_at', 'activated_at', 'expires_at', 'grace_until', 'renewal_due', 'renewal_count', 'replaced_by_card_id'],
    orderBy: 'id',
  });
  deps.exports.register({ table: 'card_roles', columns: ['card_id', 'role_key', 'department_id', 'assigned_at'], orderBy: 'card_id' });
  deps.exports.register({ table: 'card_restrictions', columns: ['id', 'card_id', 'type', 'config', 'enabled', 'created_at'], orderBy: 'id' });
  deps.exports.register({
    table: 'card_events', columns: ['id', 'card_id', 'occurred_at', 'event_type', 'actor_card_id', 'request_id', 'metadata'], orderBy: 'id',
  });

  return {
    routes: [
      ...identityRoutes({ db, auth, cards, authorizer, notifier: deps.notifier }),
      ...safetyRoutes({ authorizer, anomaly }),
      ...leavingRoutes({ authorizer, notifier: deps.notifier, holdings: () => holdings }),
    ],
    authPort: {
      tenantOfToken,
      resolveSession,
      authorize: (tx, subject, action, resource, ctx) => authorizer.authorize(tx, subject, action, resource, ctx),
      // This is the HTTP layer's decision about a request that carried a live session of the card. A refusal here is
      // what the anomaly rule "denials" counts (re-checks inside handlers go through the authorizer and are not counted).
      recordDecision: async (tx, subject, action, resource, decision, ctx) => {
        await authorizer.record(tx, subject, action, resource, decision, ctx);
        if (decision.effect === 'allow') return;
        // Counting must never cost the refusal: inside a savepoint, so that a failure here is undone on its own and
        // the deny row above still commits and the caller still gets its 403.
        await tx.query('SAVEPOINT anomaly_count');
        try {
          await anomaly.denied(tx, subject, decision.reason_code, ctx);
          await tx.query('RELEASE SAVEPOINT anomaly_count');
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT anomaly_count');
          await tx.query('RELEASE SAVEPOINT anomaly_count');
          deps.log?.error({ err, request_id: ctx.requestId }, 'the anomaly counter failed; the refusal itself was recorded');
        }
      },
    },
    cards,
    authorizer,
    hasher,
    retirementSweep: (tx, tenantId, now, requestId) => sweepRetirementNudges(tx, tenantId, now, deps.notifier, requestId),
    usePersonHoldings: (loader) => {
      holdings = loader;
    },
  };
}
