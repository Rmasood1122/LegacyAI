// PUBLIC SURFACE of the knowledge-gateway module (Phase 2).
// The API's door to captured knowledge: every route decides with the policy decision point, and
// everything that touches captured text or a model is done by the private AI service, called with a
// short-lived service token (docs/phase2/01). Other modules may import ONLY from this file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Authorizer, PersonHoldingsLoader } from '../identity-access/index.ts';
import type { Config, Database, Notifier, RateLimiter, RouteDef } from '../platform/index.ts';
import { AiServiceClient, loadInternalContract } from './internal/client.ts';
import { personHoldingsLoader } from './internal/holdings.ts';
import { adminRoutes, knowledgePolicySettings } from './internal/routes-admin.ts';
import { insightRoutes } from './internal/routes-insight.ts';
import { knowledgeRoutes } from './internal/routes-knowledge.ts';
import { offlineRoutes } from './internal/routes-offline.ts';
import { qualityRoutes } from './internal/routes-quality.ts';
import { scenarioRoutes } from './internal/routes-scenarios.ts';
import { workflowRoutes } from './internal/routes-workflow.ts';

export { TOKEN_LIFETIME_SECONDS } from './internal/client.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The internal contract, generated from the AI service's code (services/ai/app/contract.py). */
export const INTERNAL_CONTRACT_PATH = path.resolve(here, '..', '..', '..', '..', '..', 'contracts', 'ai-internal.openapi.json');

export interface KnowledgeGatewayDeps {
  config: Config;
  db: Database;
  authorizer: Authorizer;
  notifier: Notifier;
  /** For limits per card on costly operations (taking the knowledge map out). */
  rateLimiter: RateLimiter;
}

export interface KnowledgeGateway {
  routes: RouteDef[];
  /** For the identity module's retirement radar (plugged in by app.ts): what is held from a person, narrowed by the asking card's rights. */
  personHoldings: PersonHoldingsLoader;
  /**
   * The AI service's own housekeeping for ONE company (docs/phase2/01): items past their date become stale, expired
   * questions and attempts are closed, answers older than the company's retention time are removed, and content
   * written readable before decision D41 step 4b is sealed, a bounded amount per call. Returns the service's counts.
   * Run by the housekeeping command.
   */
  upkeep(tenantId: string, requestId: string): Promise<Record<string, number>>;
}

/** The card id a job sends when it acts for nobody: the AI service needs one, and no real card has it. */
const NO_CARD = '00000000-0000-0000-0000-000000000000';

export function createKnowledgeGateway(deps: KnowledgeGatewayDeps): KnowledgeGateway {
  const ai = new AiServiceClient(deps.config.aiServiceUrl, deps.config.aiServiceTimeoutMs, deps.config.serviceTokenKey,
    loadInternalContract(INTERNAL_CONTRACT_PATH), deps.config.aiServiceIdentity);
  // The policy decision point needs two of this module's settings; it is given a way to read them.
  deps.authorizer.useKnowledgeSettings(knowledgePolicySettings);
  const g = { db: deps.db, authorizer: deps.authorizer, ai, notifier: deps.notifier, rateLimiter: deps.rateLimiter };
  return {
    routes: [...knowledgeRoutes(g), ...workflowRoutes(g), ...adminRoutes(g), ...qualityRoutes(g), ...insightRoutes(g), ...scenarioRoutes(g), ...offlineRoutes(g)],
    personHoldings: personHoldingsLoader(deps.authorizer),
    upkeep: async (tenantId, requestId) => {
      const res = await ai.call<{ done?: Record<string, number> }>({
        path: '/internal/housekeeping', action: 'housekeeping.run',
        claims: { tenant_id: tenantId, card_id: NO_CARD, person_id: null, roles: [], card_phase: 'normal', request_id: requestId },
      });
      return res.done ?? {};
    },
  };
}
