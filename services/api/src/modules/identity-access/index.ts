// PUBLIC SURFACE of the identity-access module (backend Part 1).
// Other modules may import ONLY from this file - never from ./internal/*.

import type { BillingPort } from '../billing/index.ts';
import type { AuthPort, Config, Database, ExportRegistry, Notifier, RateLimiter, RouteDef } from '../platform/index.ts';
import { AuthService, DEFAULT_AUTH_LIMITS, type AuthLimits } from './internal/auth.ts';
import { Authorizer } from './internal/authz.ts';
import { CardService } from './internal/cards.ts';
import { SeedCipher } from './internal/factors.ts';
import { identityRoutes } from './internal/routes.ts';
import { SecretCodeHasher } from './internal/secret-code.ts';
import { resolveSession, tenantOfToken } from './internal/sessions.ts';

export { DEFAULT_AUTH_LIMITS, type AuthLimits } from './internal/auth.ts';
export { bootstrapOperator, type BootstrapResult } from './internal/bootstrap.ts';
export { Authorizer, loadMatrix } from './internal/authz.ts';
export {
  dammCheckDigit, dammValid, formatCardNumber, generateCardNumber, isValidCardNumber, luhnValid, maskCardNumber, normalizeCardNumber,
} from './internal/card-number.ts';
export { CardService } from './internal/cards.ts';
export { SeedCipher, StrongFactorProof } from './internal/factors.ts';
export {
  accessPhase, canTransition, CARD_STATES, computeDates, effectiveState, LEGAL_TRANSITIONS, TERMINAL_STATES,
} from './internal/lifecycle.ts';
export {
  buildResourceFilter, decide, usageKey,
  type Grant, type Matrix, type PermissionDef, type PolicyContext, type ResourceDescriptor, type ResourceFilter, type Restriction,
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
}

export interface IdentityAccess {
  routes: RouteDef[];
  /** Plugged into the platform HTTP layer by app.ts. */
  authPort: AuthPort;
  cards: CardService;
  authorizer: Authorizer;
  hasher: SecretCodeHasher;
}

export function createIdentityAccess(deps: IdentityAccessDeps): IdentityAccess {
  const { config, db } = deps;
  const hmacKey = config.hmacIndexKey.reveal();
  const hasher = new SecretCodeHasher(config.scPepper, config.argon2);
  const cipher = new SeedCipher(config.credentialEnc);
  const cards = new CardService({ hasher, notifier: deps.notifier, hmacKey });
  const authorizer = new Authorizer(deps.billing);
  const auth = new AuthService({
    db, hasher, cipher, cards, authorizer, rateLimiter: deps.rateLimiter, notifier: deps.notifier, hmacKey,
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
    routes: identityRoutes({ db, auth, cards, authorizer }),
    authPort: {
      tenantOfToken,
      resolveSession,
      authorize: (tx, subject, action, resource, ctx) => authorizer.authorize(tx, subject, action, resource, ctx),
      recordDecision: (tx, subject, action, resource, decision, ctx) => authorizer.record(tx, subject, action, resource, decision, ctx),
    },
    cards,
    authorizer,
    hasher,
  };
}
