// Helpers shared by the knowledge-gateway routes.
import { problems } from '../../../shared/errors.ts';
import type { Decision, RequestContext, ResourceRef, Subject } from '../../../shared/policy-types.ts';
import type { Authorizer } from '../../identity-access/index.ts';
import type { Database, GatewayPrepared, Notifier, RouteDef, SessionHandlerArgs, Tx } from '../../platform/index.ts';
import type { AiCall, AiServiceClient, TokenClaims } from './client.ts';

export interface GatewayDeps {
  db: Database;
  authorizer: Authorizer;
  ai: AiServiceClient;
  notifier: Notifier;
}

export type Loader = (args: { tx: Tx; subject: Subject; params: any; body: any; query: any; ctx: RequestContext }) => Promise<ResourceRef | null>;

export const phaseOf = (decision: Decision): 'normal' | 'grace' => (decision.obligations.some((o) => o.type === 'read_only') ? 'grace' : 'normal');

export function baseClaims(subject: Subject, decision: Decision, ctx: RequestContext): TokenClaims {
  return {
    tenant_id: subject.tenant_id, card_id: subject.card_id, person_id: subject.person_id, roles: subject.roles.map((r) => r.role_key),
    card_phase: phaseOf(decision), request_id: ctx.requestId,
  };
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
  /** Add the AI limits to the token (only for operations that may call a model). */
  ai?: boolean;
  approved?: string[];
  status?: number;
  /** Picks what the public answer contains. Nothing from the AI service reaches the caller unpicked. */
  map: (result: any) => unknown;
}

/** A gateway route: decide and commit, then call the AI service with nothing held open. */
export function gatewayRoute(
  deps: GatewayDeps, operationId: string, load: Loader,
  plan: (a: SessionHandlerArgs) => Promise<CallPlan | { result: { status?: number; body?: unknown } }>,
  bodyLimit?: number,
): RouteDef {
  return {
    operationId,
    kind: 'gateway',
    policy: { resource: load },
    ...(bodyLimit !== undefined ? { bodyLimit } : {}),
    prepare: async (a): Promise<GatewayPrepared> => {
      const p = await plan(a);
      if ('result' in p) return p.result;
      const claims: TokenClaims = baseClaims(a.subject, a.decision, a.ctx);
      if (p.filterAction !== undefined) claims.filter = await deps.authorizer.filterSpec(a.tx, a.subject, p.filterAction, a.ctx);
      if (p.ai === true) claims.limits = await aiLimits(a.tx, a.subject.tenant_id);
      if (p.approved !== undefined) claims.approved = p.approved;
      const call: AiCall = { path: p.path, method: p.method, action: p.action, subject: p.subject, json: p.json, bytes: p.bytes, claims };
      return {
        call: async () => {
          const result = await deps.ai.call(call);
          return { status: p.status ?? 200, body: p.map(result) };
        },
      };
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
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)) throw problems.badRequest([{ path: 'body', message: 'invalid id' }]);
  return v;
}
