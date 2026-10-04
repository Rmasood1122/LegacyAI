// Glue between the pure policy functions and the database: loads the data a decision
// needs, calls decide(), honours usage counters, and writes EVERY decision to the audit log.
import { actingCardId, type CardSubject, type Decision, type RequestContext, type ResourceRef, type Subject } from '../../../shared/policy-types.ts';
import type { BillingPort } from '../../billing/index.ts';
import { getSettings, getTenant, writeAudit, type Tx } from '../../platform/index.ts';
import { accessPhase } from './lifecycle.ts';
import {
  buildResourceFilter, buildResourceFilterSpec, decide, heldGrants, usageKey,
  type FilterSpec, type Grant, type Matrix, type PermissionDef, type PolicyContext, type ResourceDescriptor, type ResourceFilter,
  type Restriction,
} from './policy.ts';
import { loadCompanyCard, sessionExtras, subjectForCard } from './sessions.ts';

const MATRIX_TTL_MS = 60_000;
const RESTRICTION_DENIALS = new Set(['DENY_CARD_LIMIT', 'DENY_CARD_HOURS', 'DENY_CARD_NETWORK', 'DENY_CARD_READ_ONLY']);

export async function loadMatrix(tx: Tx): Promise<Matrix> {
  const perms = await tx.query<PermissionDef>('SELECT permission_key, is_write, platform_only FROM permissions');
  const grants = await tx.query<Grant>('SELECT role_key, permission_key, scope, max_sensitivity, grant_source FROM role_permissions');
  return { permissions: new Map(perms.rows.map((p) => [p.permission_key, p])), grants: grants.rows };
}

function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Company settings that belong to the knowledge module; it supplies them (this module does not read its tables). */
export type KnowledgeSettingsLoader = (tx: Tx, tenantId: string) => Promise<{ learner_verified_only: boolean; second_reviewer_required: boolean }>;

/** Actions whose decisions depend on the knowledge settings. */
const KNOWLEDGE_NAMESPACES = ['knowledge:', 'source:', 'capture:', 'quiz:', 'expert_question:', 'interview:', 'gap:', 'topic:', 'review:'];

/** What a decision's audit row says besides the decision: the obligations, and the API key that asked (its id only). */
function recordDetails(subject: Subject, decision: Decision): Record<string, string> | undefined {
  const details: Record<string, string> = { ...auditDetailsOf(subject) };
  if (decision.obligations.length > 0) details.obligations = decision.obligations.map((o) => o.type).sort().join(',');
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * How the audit trail names who asked. The actor column holds a CARD: the card itself, or - for a key - the card the
 * key acts for, with the key's id in the details. (The audit writer knows the actor kinds "card" and "service"; a
 * third kind would mean changing the rules of the tamper-evident table, which a rollback could not undo.)
 */
export function auditDetailsOf(subject: Subject): Record<string, string> {
  return subject.kind === 'api_key' ? { api_key_id: subject.key_id } : {};
}

export class Authorizer {
  readonly #billing: BillingPort;
  #matrix: { value: Matrix; loadedAt: number } | null = null;
  #knowledgeSettings: KnowledgeSettingsLoader | null = null;

  constructor(billing: BillingPort) {
    this.#billing = billing;
  }

  /** Plugged in once by app.ts. Without it the safe defaults apply (verified only, second reviewer). */
  useKnowledgeSettings(loader: KnowledgeSettingsLoader): void {
    this.#knowledgeSettings = loader;
  }

  async matrix(tx: Tx): Promise<Matrix> {
    if (this.#matrix === null || Date.now() - this.#matrix.loadedAt > MATRIX_TTL_MS) {
      this.#matrix = { value: await loadMatrix(tx), loadedAt: Date.now() };
    }
    return this.#matrix.value;
  }

  async policyContext(tx: Tx, subject: Subject, action: string, ctx: RequestContext): Promise<PolicyContext> {
    if (subject.kind === 'api_key') return this.#keyContext(tx, subject.tenant_id, subject.acts_for.card_id, action, ctx);
    const extras = sessionExtras(subject);
    const tenant = extras?.tenant ?? (await getTenant(tx, subject.tenant_id));
    if (!tenant) throw new Error('authorize: tenant not found');
    const settings = extras?.settings ?? (await getSettings(tx, subject.tenant_id));
    const companyCard = extras ? extras.companyCard : await loadCompanyCard(tx, subject.tenant_id);

    const restrictions = (
      await tx.query<Restriction>('SELECT type, enabled, config FROM card_restrictions WHERE tenant_id = $1 AND card_id = $2', [
        subject.tenant_id, subject.card_id,
      ])
    ).rows;
    const usage = new Map<string, number>();
    for (const r of restrictions) {
      if (r.type !== 'usage_cap' || r.enabled !== true) continue;
      const limitKey = r.config.limit_key;
      const windowSeconds = r.config.window_seconds;
      if (typeof limitKey !== 'string' || !Number.isInteger(windowSeconds) || (windowSeconds as number) < 1) continue;
      const { rows } = await tx.query<{ count: number }>(
        'SELECT count FROM card_usage_counters WHERE tenant_id = $1 AND card_id = $2 AND limit_key = $3 AND window_start = $4',
        [subject.tenant_id, subject.card_id, usageKey(limitKey, windowSeconds as number), windowStart(ctx.now, windowSeconds as number)],
      );
      usage.set(usageKey(limitKey, windowSeconds as number), rows[0]?.count ?? 0);
    }

    const plan = await this.#billing.checkLimit({ tx, tenantId: subject.tenant_id, planCode: tenant.plan_code, action });
    const knowledge = this.#knowledgeSettings !== null && KNOWLEDGE_NAMESPACES.some((n) => action.startsWith(n))
      ? await this.#knowledgeSettings(tx, subject.tenant_id)
      : {};
    return {
      now: ctx.now, ip: ctx.ip, tenant: { status: tenant.status }, settings: { ...settings, ...knowledge }, matrix: await this.matrix(tx),
      companyCard, restrictions, usage, planAllows: plan.allowed === true,
    };
  }

  /**
   * What a decision about an API key needs: the card that made it as it is NOW (its state, expiry and roles decide
   * what the key may do), and nothing that belongs to a card's own use - no card restrictions, no usage cap.
   */
  async #keyContext(tx: Tx, tenantId: string, makerCardId: string, action: string, ctx: RequestContext): Promise<PolicyContext> {
    const tenant = await getTenant(tx, tenantId);
    if (!tenant) throw new Error('authorize: tenant not found');
    const plan = await this.#billing.checkLimit({ tx, tenantId, planCode: tenant.plan_code, action });
    const knowledge = this.#knowledgeSettings !== null && KNOWLEDGE_NAMESPACES.some((n) => action.startsWith(n))
      ? await this.#knowledgeSettings(tx, tenantId)
      : {};
    return {
      now: ctx.now, ip: ctx.ip, tenant: { status: tenant.status }, settings: { ...(await getSettings(tx, tenantId)), ...knowledge },
      matrix: await this.matrix(tx), companyCard: await loadCompanyCard(tx, tenantId), restrictions: [], usage: new Map(),
      planAllows: plan.allowed === true, keyMaker: await subjectForCard(tx, tenantId, makerCardId),
    };
  }

  /** Decides without writing anything. Used only where the caller records the outcome itself (login). */
  async decideOnly(tx: Tx, subject: Subject, action: string, resource: ResourceRef, ctx: RequestContext): Promise<Decision> {
    try {
      return decide(subject, action, resource, await this.policyContext(tx, subject, action, ctx));
    } catch {
      return { effect: 'deny', reason_code: 'DENY_PDP_ERROR', obligations: [] };
    }
  }

  /** The policy decision point as the HTTP layer sees it: decide and count usage. The HTTP layer then calls record(). */
  async authorize(tx: Tx, subject: Subject, action: string, resource: ResourceRef, ctx: RequestContext): Promise<Decision> {
    const decision = await this.decideOnly(tx, subject, action, resource, ctx);
    // usage caps and restriction events belong to a CARD: a key has neither and writes nothing on its maker's card
    if (subject.kind !== 'card') return decision;

    if (decision.effect === 'allow') {
      for (const o of decision.obligations) {
        if (o.type !== 'count_usage') continue;
        await tx.query(
          `INSERT INTO card_usage_counters (tenant_id, card_id, limit_key, window_start, count) VALUES ($1, $2, $3, $4, 1)
           ON CONFLICT (tenant_id, card_id, limit_key, window_start) DO UPDATE SET count = card_usage_counters.count + 1`,
          [subject.tenant_id, subject.card_id, usageKey(o.limit_key, o.window_seconds), windowStart(ctx.now, o.window_seconds)],
        );
      }
    } else if (RESTRICTION_DENIALS.has(decision.reason_code)) {
      await tx.query(
        `INSERT INTO card_events (tenant_id, card_id, event_type, actor_card_id, request_id, metadata)
         VALUES ($1, $2, 'restriction_denied', $2, $3, $4)`,
        [subject.tenant_id, subject.card_id, ctx.requestId, JSON.stringify({ reason: decision.reason_code, action })],
      );
    }

    return decision;
  }

  /**
   * Writes one decision to the audit log. Every decision - allow and deny - is recorded.
   * `actorKind` is 'service' when another service asked on a card's behalf (no session existed).
   */
  async record(
    tx: Tx, subject: Subject, action: string, resource: ResourceRef, decision: Decision, ctx: RequestContext,
    actorKind: 'card' | 'service' = 'card',
  ): Promise<void> {
    await writeAudit(tx, {
      tenantId: subject.tenant_id,
      actorCardId: actingCardId(subject),
      actorKind,
      action,
      resourceType: resource.type,
      resourceId: resource.id ?? null,
      decision: decision.effect,
      reasonCode: decision.reason_code,
      requestId: ctx.requestId,
      ip: ctx.ip,
      details: recordDetails(subject, decision),
    });
  }

  /** Retrieval-time filter for list queries (feature 17 hook). */
  async filter(
    tx: Tx, subject: Subject, action: string, descriptor: ResourceDescriptor, ctx: RequestContext, firstParam: number,
  ): Promise<ResourceFilter> {
    try {
      return buildResourceFilter(subject, action, descriptor, await this.policyContext(tx, subject, action, ctx), firstParam);
    } catch {
      return { sql: 'FALSE', params: [] };
    }
  }

  /** The access filter as data, for the AI service (docs/phase2/03, lock 2). Any error means "nothing". */
  async filterSpec(tx: Tx, subject: Subject, action: string, ctx: RequestContext): Promise<FilterSpec> {
    try {
      return buildResourceFilterSpec(subject, action, await this.policyContext(tx, subject, action, ctx));
    } catch {
      return { v: 1, tenant_id: subject.tenant_id, action, nothing: true, only_verified: true, any_of: [] };
    }
  }

  /**
   * Every permission the card holds through its roles, with the highest level it holds it at. Used when a card
   * makes an API key: the key may name only what its maker holds, and no level above its maker's. A card only:
   * a key holds nothing in its own right and cannot make keys.
   */
  async heldLevels(tx: Tx, subject: CardSubject, ctx: RequestContext): Promise<Map<string, number>> {
    const pc = await this.policyContext(tx, subject, 'self:read', ctx);
    const held = new Map<string, number>();
    for (const g of heldGrants(subject.roles, subject.is_platform_tenant, pc)) {
      held.set(g.permission_key, Math.max(held.get(g.permission_key) ?? 0, g.max_sensitivity));
    }
    return held;
  }

  /** What the session endpoint reports: permission keys held, and whether the card is read-only / export-only. */
  async describe(tx: Tx, subject: CardSubject, ctx: RequestContext): Promise<{ permissions: string[]; read_only: boolean; export_only: boolean }> {
    const pc = await this.policyContext(tx, subject, 'self:read', ctx);
    const permissions = new Set(heldGrants(subject.roles, subject.is_platform_tenant, pc).map((g) => g.permission_key));
    const phases = [accessPhase(subject, ctx.now), pc.companyCard ? accessPhase(pc.companyCard, ctx.now) : 'normal'];
    return {
      permissions: [...permissions].sort(),
      read_only: phases.includes('grace') || phases.includes('lapsed'),
      export_only: phases.includes('lapsed'),
    };
  }
}
