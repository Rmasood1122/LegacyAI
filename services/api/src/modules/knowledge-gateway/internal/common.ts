// Helpers shared by the knowledge-gateway routes.
import { isUuid } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';
import type { ApprovalRef, CardSubject, Decision, RequestContext, ResourceRef, Subject } from '../../../shared/policy-types.ts';
import type { Authorizer } from '../../identity-access/index.ts';
import type {
  AuthorizedHandlerArgs, CallerHandlerArgs, Database, GatewayPrepared, ListFilter, Notifier, RateLimiter, RouteDef, SessionHandlerArgs, Tx,
} from '../../platform/index.ts';
import type { AiCall, AiServiceClient, TokenClaims } from './client.ts';

export interface GatewayDeps {
  db: Database;
  authorizer: Authorizer;
  ai: AiServiceClient;
  notifier: Notifier;
  rateLimiter: RateLimiter;
}

export type Loader<S extends Subject = CardSubject> = (args: { tx: Tx; subject: S; params: any; body: any; query: any; ctx: RequestContext }) => Promise<ResourceRef | null>;

export const phaseOf = (decision: Decision): 'normal' | 'grace' => (decision.obligations.some((o) => o.type === 'read_only') ? 'grace' : 'normal');

/**
 * Who the AI service is told is asking. A card: itself and its roles. An API key: the key (claim `actor`), no roles
 * at all, and - as card and person - the ones the key acts for, so that "mine" and the audit trail have a card.
 */
export function baseClaims(subject: Subject, decision: Decision, ctx: RequestContext): TokenClaims {
  const who = subject.kind === 'card'
    ? { card_id: subject.card_id, person_id: subject.person_id, roles: subject.roles.map((r) => r.role_key) }
    : { card_id: subject.acts_for.card_id, person_id: subject.acts_for.person_id, roles: [], actor: { kind: 'api_key' as const, id: subject.key_id } };
  return { tenant_id: subject.tenant_id, ...who, card_phase: phaseOf(decision), request_id: ctx.requestId };
}

/**
 * The AI limits for this company: the plan's defaults, with the company's own monthly cap if the
 * operator set one. Passed in the token; the AI service enforces them (docs/phase2/04).
 */
export async function aiLimits(tx: Tx, tenantId: string): Promise<Record<string, number>> {
  const { rows } = await tx.query<{ monthly_cap_micro_usd: string; max_input_tokens: number; max_output_tokens: number; calls_per_hour: number }>(
    `SELECT COALESCE(b.monthly_cap_micro_usd, d.monthly_cap_micro_usd)::text AS monthly_cap_micro_usd,
            d.max_input_tokens, d.max_output_tokens, d.calls_per_hour
       FROM tenants t JOIN ai_plan_defaults d ON d.plan_code = t.plan_code
       LEFT JOIN ai_budgets b ON b.tenant_id = t.id
      WHERE t.id = $1`, [tenantId]);
  const r = rows[0];
  if (!r) return {};
  return {
    monthly_cap_micro_usd: Number(r.monthly_cap_micro_usd), max_input_tokens: r.max_input_tokens,
    max_output_tokens: r.max_output_tokens, calls_per_hour: r.calls_per_hour,
  };
}

export interface CallPlan extends Omit<AiCall, 'claims'> {
  /** Add the access filter of this permission to the token (for reads of stored content). */
  filterAction?: string;
  /**
   * Also add the card's topic:read filter, as a second and separate filter. The right to read knowledge up to a level
   * says nothing about topics, so the topics of an item are never narrowed with `filterAction`.
   */
  topicFilter?: boolean;
  /**
   * Also add the card's filters of these READ permissions, each under its own name (claim `filters`). For operations
   * whose answer holds several kinds of thing, each narrowed by the right to read that kind.
   */
  moreFilters?: readonly string[];
  /** Add the AI limits to the token (only for operations that may call a model). */
  ai?: boolean;
  approved?: string[];
  status?: number;
  /** Picks what the public answer contains. Nothing from the AI service reaches the caller unpicked. */
  map: (result: any) => unknown;
}

/** A gateway route: decide and commit, then call the AI service with nothing held open. */
/** Adds the collection-read declaration (see ListFilter in the platform module) to a route built by gatewayRoute. */
export const withListFilter = (listFilter: ListFilter, route: RouteDef): RouteDef => (route.kind === 'public' ? route : { ...route, listFilter });

/**
 * Operations that APPROVE what somebody wrote. They share their permission with edit and retire, so the policy can
 * only apply the second-person rule if the route names the writers. These operations must therefore be registered
 * with approvalRoute(), whose loader has to return an ApprovalRef; gatewayRoute() refuses to register them.
 */
export const APPROVAL_OPERATIONS: ReadonlySet<string> = new Set(['approveScenario', 'approveQuizQuestion']);
const viaApprovalRoute = Symbol('approvalRoute');

export type ApprovalLoader = (args: Parameters<Loader>[0]) => Promise<ApprovalRef | null>;

/** A gateway route for an approval: the resource must say who wrote the thing (see APPROVAL_OPERATIONS). */
export function approvalRoute(
  deps: GatewayDeps, operationId: string, load: ApprovalLoader,
  plan: (a: SessionHandlerArgs) => Promise<CallPlan | { result: { status?: number; body?: unknown } }>,
): RouteDef {
  if (!APPROVAL_OPERATIONS.has(operationId)) throw new Error(`${operationId} is not listed in APPROVAL_OPERATIONS`);
  const checked: Loader = async (a) => {
    const ref = await load(a);
    // belt and braces for JavaScript callers that get past the type: an approval without its writers is not described at all
    if (ref !== null && (ref.approval !== true || ref.not_by === undefined)) throw new Error(`${operationId}: an approval must name who may not approve`);
    return ref;
  };
  return gatewayRoute(deps, operationId, checked, plan, undefined, viaApprovalRoute);
}

export function gatewayRoute(
  deps: GatewayDeps, operationId: string, load: Loader,
  plan: (a: SessionHandlerArgs) => Promise<CallPlan | { result: { status?: number; body?: unknown } }>,
  bodyLimit?: number,
  via?: symbol,
): RouteDef {
  if (APPROVAL_OPERATIONS.has(operationId) && via !== viaApprovalRoute) {
    throw new Error(`${operationId} approves what somebody wrote: register it with approvalRoute(), which requires the writers to be named`);
  }
  return {
    operationId,
    kind: 'gateway',
    policy: { resource: load },
    ...(bodyLimit !== undefined ? { bodyLimit } : {}),
    prepare: async (a) => prepareCall(deps, a, await plan(a)),
  };
}

/**
 * The same, for an operation that also takes a machine's API key: its loader and its plan are handed "a card or a
 * key" and so cannot use anything only a card has. Approvals never take a key.
 */
export function keyGatewayRoute(
  deps: GatewayDeps, operationId: string, load: Loader<Subject>,
  plan: (a: CallerHandlerArgs) => Promise<CallPlan | { result: { status?: number; body?: unknown } }>,
): RouteDef {
  if (APPROVAL_OPERATIONS.has(operationId)) throw new Error(`${operationId} approves what somebody wrote: it cannot take an API key`);
  return { operationId, kind: 'gateway-or-key', policy: { resource: load }, prepare: async (a) => prepareCall(deps, a, await plan(a)) };
}

/** Builds the service token for the planned call - the access filters are the asking subject's own - and returns the call. */
async function prepareCall<S extends Subject>(
  deps: GatewayDeps, a: AuthorizedHandlerArgs<S>, p: CallPlan | { result: { status?: number; body?: unknown } },
): Promise<GatewayPrepared<S>> {
  if ('result' in p) return p.result;
  const claims: TokenClaims = baseClaims(a.subject, a.decision, a.ctx);
  if (p.filterAction !== undefined) claims.filter = await deps.authorizer.filterSpec(a.tx, a.subject, p.filterAction, a.ctx);
  if (p.topicFilter === true) claims.topic_filter = await deps.authorizer.filterSpec(a.tx, a.subject, 'topic:read', a.ctx);
  if (p.moreFilters !== undefined) {
    claims.filters = {};
    for (const permission of p.moreFilters) claims.filters[permission] = await deps.authorizer.filterSpec(a.tx, a.subject, permission, a.ctx);
  }
  if (p.ai === true) claims.limits = await aiLimits(a.tx, a.subject.tenant_id);
  if (p.approved !== undefined) claims.approved = p.approved;
  const call: AiCall = { path: p.path, method: p.method, action: p.action, subject: p.subject, json: p.json, bytes: p.bytes, claims };
  return {
    call: async () => {
      const result = await deps.ai.call(call);
      return { status: p.status ?? 200, body: p.map(result) };
    },
  };
}

/** Picks the listed keys of a plain object (missing keys become null). */
export function pick<K extends string>(obj: any, keys: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  for (const k of keys) out[k] = obj?.[k] ?? null;
  return out;
}

export function uuidOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw problems.badRequest([{ path: 'body', message: 'invalid id' }]);
  return v;
}
