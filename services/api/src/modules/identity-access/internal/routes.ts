// HTTP endpoints of the identity-access module.
//
// Handlers here do NOT make access decisions. Each route names a `resource` loader that
// describes what is being acted on; the HTTP layer passes it to the policy decision point
// before the handler runs. Handlers only do the work.
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { problems } from '../../../shared/errors.ts';
import type { RequestContext, ResourceRef, RoleKey, CardSubject } from '../../../shared/policy-types.ts';
import {
  countAuditRows, createTenant, decodeIdCursor, encodeCursor, getPlan, getSettings, getTenant, listTenants, toApiTenant, updateSettings,
  writeAudit,
  type Database, type Notifier, type RouteDef, type Tx,
} from '../../platform/index.ts';
import { sessionBody, type AuthService } from './auth.ts';
import type { Authorizer } from './authz.ts';
import type { BillingPort } from '../../billing/index.ts';
import {
  CARD_COLUMNS, getCard, lockTenantRoles, maxRank, otherUsableOwners, personDepartment, toApiCard, withSecrets,
  type CardRow, type CardService, type RoleInput,
} from './cards.ts';
import { normalizeCardNumber } from './card-number.ts';
import type { ResourceDescriptor } from './policy.ts';
import { clearLeavingDate } from './leaving.ts';
import { loadRoles, revokeSession, rotateSession } from './sessions.ts';

export interface IdentityRouteDeps {
  db: Database;
  auth: AuthService;
  cards: CardService;
  authorizer: Authorizer;
  notifier: Notifier;
  /** For the seats line of the usage page (numbers of cards, never money). */
  billing: BillingPort;
}

const CARD_DESCRIPTOR: ResourceDescriptor = {
  type: 'card',
  tenantExpr: 'cards.tenant_id',
  ownerCardExpr: 'cards.id',
  ownerPersonExpr: 'cards.person_id',
  departmentExpr: '(SELECT p.department_id FROM people p WHERE p.id = cards.person_id)',
};
const PERSON_DESCRIPTOR: ResourceDescriptor = {
  type: 'person',
  tenantExpr: 'people.tenant_id',
  ownerPersonExpr: 'people.id',
  departmentExpr: 'people.department_id',
};

interface PersonRow {
  id: string;
  display_name: string;
  email: string | null;
  department_id: string | null;
  status: 'active' | 'departed';
  created_at: Date;
}
const PERSON_COLUMNS = 'people.id, people.display_name, people.email, people.department_id, people.status, people.created_at';
const toApiPerson = (p: PersonRow): Record<string, unknown> => ({
  id: p.id, display_name: p.display_name, email: p.email, department_id: p.department_id, status: p.status,
  created_at: p.created_at.toISOString(),
});

const COMPANY_CARD_RANK = 100;

async function roleRanks(tx: Tx): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ role_key: string; rank: number }>('SELECT role_key, rank FROM roles');
  return new Map(rows.map((r) => [r.role_key, r.rank]));
}

function rankOf(ranks: Map<string, number>, roleKeys: readonly string[]): number {
  // An unknown role gets an impossibly high rank so the rank guard refuses it.
  return roleKeys.reduce((m, k) => Math.max(m, ranks.get(k) ?? Number.MAX_SAFE_INTEGER), 0);
}

/** Describes a card to the policy decision point. `lastOwnerCheck` asks "would this leave no active Owner?". */
async function cardResource(
  tx: Tx, subject: CardSubject, cardId: string, now: Date, opts: { lastOwnerCheck?: boolean; serialize?: boolean } = {},
): Promise<{ ref: ResourceRef; card: CardRow } | null> {
  // Changes to who holds which role (and who is the last Owner) are decided one at a time per
  // tenant, so two simultaneous requests cannot each see "there is still another Owner".
  if (opts.lastOwnerCheck === true || opts.serialize === true) await lockTenantRoles(tx, subject.tenant_id);
  const card = await getCard(tx, cardId);
  if (!card) return null;
  const roles = await loadRoles(tx, card.tenant_id, card.id);
  const ref: ResourceRef = {
    type: 'card', id: card.id, tenant_id: card.tenant_id, owner_card_id: card.id, owner_person_id: card.person_id,
    department_id: await personDepartment(tx, card.person_id), card_kind: card.kind,
    // The company card ranks with the Company Owner: nobody below an Owner may act on it.
    target_rank: card.kind === 'company' ? COMPANY_CARD_RANK : maxRank(roles),
  };
  if (opts.lastOwnerCheck === true && roles.some((r) => r.role_key === 'company_owner') && card.state === 'active') {
    ref.removes_last_owner = (await otherUsableOwners(tx, subject.tenant_id, card.id, now)) === 0;
  }
  return { ref, card };
}

const cardLoader = (opts: { lastOwnerCheck?: boolean; serialize?: boolean } = {}) =>
  async ({ tx, subject, params, ctx }: { tx: Tx; subject: CardSubject; params: { card_id: string }; ctx: RequestContext }): Promise<ResourceRef | null> =>
    (await cardResource(tx, subject, params.card_id, ctx.now, opts))?.ref ?? null;

const selfResource = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type: 'session', id: subject.session_id, tenant_id: subject.tenant_id, owner_card_id: subject.card_id,
});
const collection = (type: string) => async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({
  type, tenant_id: subject.tenant_id, collection: true,
});

async function mustGetCard(tx: Tx, cardId: string): Promise<CardRow> {
  const card = await getCard(tx, cardId, true);
  if (!card) throw problems.notFound();
  return card;
}

function validateRestrictions(restrictions: Array<{ type: string; config: Record<string, unknown> }>): void {
  for (const r of restrictions) {
    if (r.type === 'time_window') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: String(r.config.timezone) });
      } catch {
        throw problems.unprocessable('Unknown time zone', [{ path: 'body/restrictions', message: 'timezone is not a known IANA time zone' }]);
      }
    }
    if (r.type === 'network_allowlist') {
      for (const cidr of r.config.cidrs as string[]) {
        const [net, prefix] = cidr.split('/');
        const family = isIP(net ?? '');
        const bits = prefix === undefined ? 0 : Number(prefix);
        if (family === 0 || (prefix !== undefined && !/^[0-9]{1,3}$/.test(prefix)) || bits > (family === 4 ? 32 : 128)) {
          throw problems.unprocessable('Invalid network range', [{ path: 'body/restrictions', message: 'each entry must be an IP address or CIDR range' }]);
        }
      }
    }
  }
}

async function restrictionsBody(tx: Tx, card: CardRow): Promise<Record<string, unknown>> {
  const items = await tx.query<{ type: string; enabled: boolean; config: Record<string, unknown> }>(
    'SELECT type, enabled, config FROM card_restrictions WHERE tenant_id = $1 AND card_id = $2 ORDER BY id', [card.tenant_id, card.id]);
  const counters = await tx.query<{ limit_key: string; window_start: Date; count: number }>(
    'SELECT limit_key, window_start, count FROM card_usage_counters WHERE tenant_id = $1 AND card_id = $2 ORDER BY window_start DESC LIMIT 50',
    [card.tenant_id, card.id]);
  return {
    items: items.rows,
    counters: counters.rows.map((c) => ({ limit_key: c.limit_key, window_start: c.window_start.toISOString(), count: c.count })),
  };
}

async function roleAssignments(tx: Tx, card: CardRow): Promise<Array<Record<string, unknown>>> {
  const { rows } = await tx.query<{ role_key: string; department_id: string | null; assigned_at: Date }>(
    'SELECT role_key, department_id, assigned_at FROM card_roles WHERE tenant_id = $1 AND card_id = $2 ORDER BY role_key', [card.tenant_id, card.id]);
  return rows.map((r) => ({ role_key: r.role_key, department_id: r.department_id, assigned_at: r.assigned_at.toISOString() }));
}

export function identityRoutes(deps: IdentityRouteDeps): RouteDef[] {
  const { db, auth, cards, authorizer, notifier } = deps;

  /** The thing a platform operator acts on when working on a customer tenant: that tenant, named by id. */
  const targetTenant = async ({ subject, params }: { subject: CardSubject; params: { tenant_id: string } }): Promise<ResourceRef> => ({
    type: 'tenant', id: params.tenant_id, tenant_id: subject.tenant_id,
  });
  /** Loads a customer tenant inside withinTenant(); the operator tenant itself is never a target. */
  const mustGetCustomerTenant = async (tx: Tx, tenantId: string): Promise<void> => {
    const tenant = await getTenant(tx, tenantId);
    if (!tenant || tenant.is_platform) throw problems.notFound();
  };

  const roleChangeAudit = async (tx: Tx, subject: CardSubject, card: CardRow, ctx: { requestId: string; ip: string }, roleKey: string, removed: boolean): Promise<void> => {
    await writeAudit(tx, {
      tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card',
      action: removed ? 'card_roles:remove' : 'card_roles:assign', resourceType: 'card', resourceId: card.id,
      decision: 'event', reasonCode: removed ? 'ROLE_REMOVED' : 'ROLE_ASSIGNED', requestId: ctx.requestId, ip: ctx.ip, details: { role_key: roleKey },
    });
  };

  return [
    // ------------------------------------------------------------------- auth
    {
      operationId: 'loginBegin',
      kind: 'public',
      policy: { public: true, reason: 'Sign-in must be reachable without a session. Returns the same shape for every card number.' },
      handler: ({ ctx, body }) => auth.loginBegin(ctx, body),
    },
    {
      operationId: 'loginVerify',
      kind: 'public',
      policy: { public: true, reason: 'Sign-in must be reachable without a session. Requires SC and a strong factor together.' },
      handler: ({ ctx, body }) => auth.loginVerify(ctx, body),
    },
    {
      operationId: 'enrollmentBegin',
      kind: 'public',
      policy: { public: true, reason: 'First strong-factor enrollment happens before any session can exist. Requires a one-time enrollment token.' },
      handler: ({ ctx, body }) => auth.enrollmentBegin(ctx, body),
    },
    {
      operationId: 'enrollmentComplete',
      kind: 'public',
      policy: { public: true, reason: 'Completes enrollment started with a one-time enrollment token; creates no session.' },
      handler: ({ ctx, body }) => auth.enrollmentComplete(ctx, body),
    },
    {
      operationId: 'getSession',
      kind: 'session',
      policy: { resource: selfResource },
      handler: async ({ tx, subject, csrfToken, ctx }) => ({ body: await sessionBody(tx, authorizer, subject, csrfToken, ctx) }),
    },
    {
      operationId: 'logout',
      kind: 'session',
      policy: { resource: selfResource },
      handler: async ({ tx, subject, ctx }) => {
        await revokeSession(tx, subject.session_id, 'logout', ctx.now);
        return { status: 204, clearSessionCookie: true };
      },
    },
    {
      operationId: 'listOwnCredentials',
      kind: 'session',
      policy: { resource: selfResource },
      handler: async ({ tx, subject }) => {
        const { rows } = await tx.query<{ id: string; type: string; label: string; created_at: Date; last_used_at: Date | null }>(
          `SELECT id, type, label, created_at, last_used_at FROM credentials WHERE tenant_id = $1 AND card_id = $2 AND status = 'active' ORDER BY id`,
          [subject.tenant_id, subject.card_id]);
        return {
          body: {
            items: rows.map((c) => ({
              id: c.id, type: c.type, label: c.label, created_at: c.created_at.toISOString(),
              last_used_at: c.last_used_at ? c.last_used_at.toISOString() : null,
            })),
          },
        };
      },
    },
    {
      operationId: 'removeOwnCredential',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params }) => {
          const { rows } = await tx.query(
            `SELECT 1 FROM credentials WHERE id = $1 AND tenant_id = $2 AND card_id = $3 AND status = 'active'`,
            [params.credential_id, subject.tenant_id, subject.card_id]);
          return rows[0] ? { type: 'credential', id: params.credential_id, tenant_id: subject.tenant_id, owner_card_id: subject.card_id } : null;
        },
      },
      handler: async ({ tx, subject, params, ctx }) => {
        // Lock the card so two simultaneous removals cannot each think "one factor will remain".
        await tx.query('SELECT 1 FROM cards WHERE id = $1 FOR UPDATE', [subject.card_id]);
        const { rows } = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM credentials WHERE tenant_id = $1 AND card_id = $2 AND status = 'active'`,
          [subject.tenant_id, subject.card_id]);
        if (Number(rows[0]?.n ?? 0) <= 1) throw problems.conflict('last-credential', 'The last strong factor cannot be removed');
        await tx.query(`UPDATE credentials SET status = 'revoked' WHERE id = $1`, [params.credential_id]);
        // Sessions that were opened with the removed factor end now; the others (this one included, if it was opened
        // with another factor) go on. The API keys this card made are ALL revoked: a factor is removed when it is lost
        // or no longer trusted, nothing records which session made which key, and a key must not outlive a change of
        // its maker's sign-in (decision D30). The Owners are told; new keys can be made at once.
        await cards.revokeSessions(tx, { id: subject.card_id, tenant_id: subject.tenant_id }, 'credentials_reset', ctx.now,
          { openedWithCredentialId: params.credential_id });
        await cards.event(tx, { id: subject.card_id, tenant_id: subject.tenant_id }, 'credential_removed', subject.card_id, ctx, {}, params.credential_id);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'self:credential_remove',
          resourceType: 'credential', resourceId: params.credential_id, decision: 'event', reasonCode: 'CREDENTIAL_REMOVED',
          requestId: ctx.requestId, ip: ctx.ip,
        });
        return { status: 204 };
      },
    },

    // ------------------------------------------------------------------ cards
    {
      operationId: 'issueCard',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, body }) => {
          // "Revoke a peer's card, then issue a new one to the same person" must not be a way into
          // that person's identity. So the person counts with the highest rank any of their cards
          // ever held, and the actor must rank strictly above it.
          const held = await tx.query<{ rank: number | null }>(
            `SELECT max(r.rank) AS rank FROM cards c
               JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
               JOIN roles r ON r.role_key = cr.role_key
              WHERE c.tenant_id = $1 AND c.person_id = $2`,
            [subject.tenant_id, body.person_id]);
          return {
            type: 'card', tenant_id: subject.tenant_id, collection: true,
            role_rank: rankOf(await roleRanks(tx), (body.roles as RoleInput[]).map((r) => r.role_key)),
            target_rank: held.rows[0]?.rank ?? 0,
          };
        },
      },
      handler: async ({ tx, subject, body, ctx }) => {
        const settings = await getSettings(tx, subject.tenant_id);
        const issued = await cards.issue(
          tx, { tenantId: subject.tenant_id, kind: 'person', personId: body.person_id, roles: body.roles, actorCardId: subject.card_id },
          settings, ctx);
        return { status: 201, body: withSecrets(await toApiCard(tx, issued.card, ctx.now), issued) };
      },
    },
    {
      operationId: 'listCards',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: collection('card') },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeIdCursor(query.cursor);
        // The retrieval-time filter narrows the result set to what this card may see.
        const filter = await authorizer.filter(tx, subject, 'card:list', CARD_DESCRIPTOR, ctx, 6);
        const { rows } = await tx.query<CardRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${CARD_COLUMNS} FROM cards
            WHERE ($1::text IS NULL OR cards.state = $1) AND ($2::text IS NULL OR cards.kind = $2)
              AND ($3::uuid IS NULL OR cards.person_id = $3::uuid) AND ($4::uuid IS NULL OR cards.id > $4::uuid)
              AND ${filter.sql}
            ORDER BY cards.id ASC LIMIT $5`,
          [query.state ?? null, query.kind ?? null, query.person_id ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        const items = [];
        for (const c of page) items.push(await toApiCard(tx, c, ctx.now));
        return { body: { items, next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'getCard',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, params, ctx }) => ({ body: await toApiCard(tx, await mustGetCard(tx, params.card_id), ctx.now) }),
    },
    {
      operationId: 'suspendCard',
      kind: 'session',
      policy: { resource: cardLoader({ lastOwnerCheck: true }) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const card = await cards.suspend(tx, await mustGetCard(tx, params.card_id), body.reason, subject.card_id, ctx);
        return { body: await toApiCard(tx, card, ctx.now) };
      },
    },
    {
      operationId: 'reinstateCard',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, subject, params, ctx }) => {
        const card = await cards.reinstate(tx, await mustGetCard(tx, params.card_id), subject.card_id, ctx);
        return { body: await toApiCard(tx, card, ctx.now) };
      },
    },
    {
      operationId: 'revokeCard',
      kind: 'session',
      policy: { resource: cardLoader({ lastOwnerCheck: true }) },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const card = await cards.revoke(tx, await mustGetCard(tx, params.card_id), body.reason, subject.card_id, ctx);
        return { body: await toApiCard(tx, card, ctx.now) };
      },
    },
    {
      operationId: 'replaceCard',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const settings = await getSettings(tx, subject.tenant_id);
        const issued = await cards.replace(
          tx, await mustGetCard(tx, params.card_id),
          { reason: body.reason, resetCredentials: body.reset_credentials ?? body.reason === 'compromised' },
          subject.card_id, settings, ctx);
        return { status: 201, body: withSecrets(await toApiCard(tx, issued.card, ctx.now), issued) };
      },
    },
    {
      operationId: 'renewCard',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const settings = await getSettings(tx, subject.tenant_id);
        const renewed = await cards.renew(tx, await mustGetCard(tx, params.card_id), body?.validity_days, subject.card_id, settings, ctx);
        return { body: withSecrets(await toApiCard(tx, renewed.card, ctx.now), renewed) };
      },
    },
    {
      operationId: 'unlockCard',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, subject, params, ctx }) => {
        const unlocked = await cards.unlock(tx, await mustGetCard(tx, params.card_id), subject.card_id, ctx);
        return { body: withSecrets(await toApiCard(tx, unlocked.card, ctx.now), unlocked) };
      },
    },
    {
      operationId: 'issueEnrollmentToken',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const t = await cards.issueEnrollmentToken(tx, await mustGetCard(tx, params.card_id), body?.revoke_existing === true, subject.card_id, ctx);
        return { status: 201, body: { enrollment_token: t.token, enrollment_token_expires_at: t.expiresAt.toISOString(), secret_already_shown: false } };
      },
    },
    {
      operationId: 'listCardEvents',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, params, query }) => {
        const before = decodeIdCursor(query.cursor);
        const { rows } = await tx.query<{
          id: string; card_id: string; occurred_at: Date; event_type: string; actor_card_id: string | null;
          credential_id: string | null; device_hash: Buffer | null; request_id: string | null; metadata: Record<string, unknown>;
        }>(
          `SELECT id, card_id, occurred_at, event_type, actor_card_id, credential_id, device_hash, request_id, metadata
             FROM card_events
            WHERE card_id = $1 AND ($2::text IS NULL OR event_type = $2) AND ($3::uuid IS NULL OR id < $3::uuid)
            ORDER BY id DESC LIMIT $4`,
          [params.card_id, query.event_type ?? null, before, query.limit + 1]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return {
          body: {
            items: page.map((e) => ({
              id: e.id, card_id: e.card_id, occurred_at: e.occurred_at.toISOString(), event_type: e.event_type,
              actor_card_id: e.actor_card_id, credential_id: e.credential_id,
              device: e.device_hash ? e.device_hash.toString('hex').slice(0, 12) : null, request_id: e.request_id, metadata: e.metadata,
            })),
            next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null,
          },
        };
      },
    },
    {
      operationId: 'getCardRestrictions',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, params }) => ({ body: await restrictionsBody(tx, await mustGetCard(tx, params.card_id)) }),
    },
    {
      operationId: 'putCardRestrictions',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const card = await mustGetCard(tx, params.card_id);
        validateRestrictions(body.restrictions);
        await tx.query('DELETE FROM card_restrictions WHERE tenant_id = $1 AND card_id = $2', [card.tenant_id, card.id]);
        for (const r of body.restrictions as Array<{ type: string; config: unknown; enabled: boolean }>) {
          await tx.query(
            'INSERT INTO card_restrictions (tenant_id, card_id, type, config, enabled, created_by_card_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [card.tenant_id, card.id, r.type, JSON.stringify(r.config), r.enabled, subject.card_id]);
        }
        await cards.event(tx, card, 'restrictions_changed', subject.card_id, ctx, { count: body.restrictions.length });
        await writeAudit(tx, {
          tenantId: card.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'card_restrictions:update',
          resourceType: 'card', resourceId: card.id, decision: 'event', reasonCode: 'RESTRICTIONS_CHANGED',
          requestId: ctx.requestId, ip: ctx.ip, details: { count: body.restrictions.length },
        });
        return { body: await restrictionsBody(tx, card) };
      },
    },

    // ------------------------------------------------------------------ roles
    {
      operationId: 'listRoles',
      kind: 'session',
      listFilter: { unfiltered: 'the role list is the same for the whole company; every role holds role:read company-wide' },
      policy: { resource: collection('role') },
      handler: async ({ tx, subject }) => {
        const settings = await getSettings(tx, subject.tenant_id);
        const matrix = await authorizer.matrix(tx);
        const { rows } = await tx.query<{ role_key: RoleKey; display_name: string; rank: number }>(
          'SELECT role_key, display_name, rank FROM roles ORDER BY rank DESC');
        return {
          body: {
            items: rows.map((r) => ({
              role_key: r.role_key, display_name: r.display_name, rank: r.rank,
              enabled_for_tenant: settings.enabled_roles.includes(r.role_key),
              permissions: matrix.grants
                .filter((g) => g.role_key === r.role_key && (g.grant_source === 'base' || settings.pilot_reviewer_grant))
                .map((g) => ({ permission_key: g.permission_key, scope: g.scope }))
                .sort((a, b) => a.permission_key.localeCompare(b.permission_key)),
            })),
          },
        };
      },
    },
    {
      operationId: 'listCardRoles',
      kind: 'session',
      policy: { resource: cardLoader() },
      handler: async ({ tx, params }) => ({ body: { items: await roleAssignments(tx, await mustGetCard(tx, params.card_id)) } }),
    },
    {
      operationId: 'assignCardRole',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params, body, ctx }) => {
          const loaded = await cardResource(tx, subject, params.card_id, ctx.now, { serialize: true });
          return loaded ? { ...loaded.ref, role_rank: rankOf(await roleRanks(tx), [body.role_key]) } : null;
        },
      },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const card = await mustGetCard(tx, params.card_id);
        const settings = await getSettings(tx, subject.tenant_id);
        await cards.assignRoles(tx, card, [body], settings, subject.card_id);
        await cards.event(tx, card, 'role_assigned', subject.card_id, ctx, { role_key: body.role_key });
        await roleChangeAudit(tx, subject, card, ctx, body.role_key, false);
        // Privilege change: the target card's sessions end and it must sign in again.
        await cards.revokeSessions(tx, card, 'privilege_change', ctx.now);
        const assignment = (await roleAssignments(tx, card)).find((r) => r.role_key === body.role_key);
        return { status: 201, body: assignment };
      },
    },
    {
      operationId: 'replaceCardRoles',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params, body, ctx }) => {
          const loaded = await cardResource(tx, subject, params.card_id, ctx.now, { serialize: true });
          if (!loaded) return null;
          const current = (await loadRoles(tx, loaded.card.tenant_id, loaded.card.id)).map((r) => r.role_key as string);
          const next = (body.roles as RoleInput[]).map((r) => r.role_key as string);
          const touched = [...next.filter((k) => !current.includes(k)), ...current.filter((k) => !next.includes(k))];
          const dropsOwner = current.includes('company_owner') && !next.includes('company_owner') && loaded.card.state === 'active';
          return {
            ...loaded.ref,
            role_rank: rankOf(await roleRanks(tx), touched),
            removes_last_owner: dropsOwner && (await otherUsableOwners(tx, subject.tenant_id, loaded.card.id, ctx.now)) === 0,
          };
        },
      },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const card = await mustGetCard(tx, params.card_id);
        const settings = await getSettings(tx, subject.tenant_id);
        const before = (await loadRoles(tx, card.tenant_id, card.id)).map((r) => r.role_key as string);
        const next = (body.roles as RoleInput[]).map((r) => r.role_key as string);
        await tx.query('DELETE FROM card_roles WHERE tenant_id = $1 AND card_id = $2', [card.tenant_id, card.id]);
        await cards.assignRoles(tx, card, body.roles, settings, subject.card_id);
        for (const k of next.filter((x) => !before.includes(x))) {
          await cards.event(tx, card, 'role_assigned', subject.card_id, ctx, { role_key: k });
          await roleChangeAudit(tx, subject, card, ctx, k, false);
        }
        for (const k of before.filter((x) => !next.includes(x))) {
          await cards.event(tx, card, 'role_removed', subject.card_id, ctx, { role_key: k });
          await roleChangeAudit(tx, subject, card, ctx, k, true);
        }
        await cards.revokeSessions(tx, card, 'privilege_change', ctx.now);
        return { body: { items: await roleAssignments(tx, card) } };
      },
    },
    {
      operationId: 'removeCardRole',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params, ctx }) => {
          const loaded = await cardResource(tx, subject, params.card_id, ctx.now, { serialize: true });
          if (!loaded) return null;
          const isOwnerRemoval = params.role_key === 'company_owner' && loaded.card.state === 'active';
          return {
            ...loaded.ref,
            role_rank: rankOf(await roleRanks(tx), [params.role_key]),
            removes_last_owner: isOwnerRemoval && (await otherUsableOwners(tx, subject.tenant_id, loaded.card.id, ctx.now)) === 0,
          };
        },
      },
      handler: async ({ tx, subject, params, ctx }) => {
        const card = await mustGetCard(tx, params.card_id);
        const current = await loadRoles(tx, card.tenant_id, card.id);
        if (!current.some((r) => r.role_key === params.role_key)) throw problems.notFound();
        if (current.length <= 1) throw problems.conflict('last-role', 'A card must keep at least one role; revoke the card instead');
        await tx.query('DELETE FROM card_roles WHERE tenant_id = $1 AND card_id = $2 AND role_key = $3', [card.tenant_id, card.id, params.role_key]);
        await cards.event(tx, card, 'role_removed', subject.card_id, ctx, { role_key: params.role_key });
        await roleChangeAudit(tx, subject, card, ctx, params.role_key, true);
        await cards.revokeSessions(tx, card, 'privilege_change', ctx.now);
        return { status: 204 };
      },
    },

    // ---------------------------------------------------- people, departments
    {
      operationId: 'createPerson',
      kind: 'session',
      policy: { resource: collection('person') },
      handler: async ({ tx, subject, body }) => {
        try {
          const { rows } = await tx.query<PersonRow>(
            `INSERT INTO people (tenant_id, display_name, email, department_id) VALUES ($1, $2, $3, $4) RETURNING ${PERSON_COLUMNS}`,
            [subject.tenant_id, body.display_name, typeof body.email === 'string' ? body.email.toLowerCase() : null, body.department_id ?? null]);
          return { status: 201, body: toApiPerson(rows[0] as PersonRow) };
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === '23505') throw problems.unprocessable('A person with that email already exists');
          if (code === '23503') throw problems.unprocessable('Unknown department');
          throw err;
        }
      },
    },
    {
      operationId: 'listPeople',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: collection('person') },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeIdCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'person:read', PERSON_DESCRIPTOR, ctx, 5);
        const { rows } = await tx.query<PersonRow>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT ${PERSON_COLUMNS} FROM people
            WHERE ($1::uuid IS NULL OR people.department_id = $1::uuid) AND ($2::text IS NULL OR people.status = $2)
              AND ($3::uuid IS NULL OR people.id > $3::uuid) AND ${filter.sql}
            ORDER BY people.id ASC LIMIT $4`,
          [query.department_id ?? null, query.status ?? null, after, query.limit + 1, ...filter.params]);
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiPerson), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'getPerson',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params }) => {
          const { rows } = await tx.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = $1`, [params.person_id]);
          const p = rows[0];
          return p ? { type: 'person', id: p.id, tenant_id: subject.tenant_id, owner_person_id: p.id, department_id: p.department_id } : null;
        },
      },
      handler: async ({ tx, params }) => {
        const { rows } = await tx.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = $1`, [params.person_id]);
        if (!rows[0]) throw problems.notFound();
        return { body: toApiPerson(rows[0]) };
      },
    },
    {
      operationId: 'updatePerson',
      kind: 'session',
      policy: {
        resource: async ({ tx, subject, params, body, ctx }) => {
          const { rows } = await tx.query<PersonRow>(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = $1`, [params.person_id]);
          const p = rows[0];
          if (!p) return null;
          await lockTenantRoles(tx, subject.tenant_id);
          // Changing a person is guarded like acting on their card: not on yourself, and not on someone who outranks you.
          const ref: ResourceRef = {
            type: 'person', id: p.id, tenant_id: subject.tenant_id, owner_person_id: p.id, department_id: p.department_id, target_rank: 0,
          };
          const live = await tx.query<{ id: string; state: string }>(
            `SELECT id, state FROM cards WHERE person_id = $1 AND state NOT IN ('revoked', 'replaced')`, [p.id]);
          const card = live.rows[0];
          if (card) {
            const roles = await loadRoles(tx, subject.tenant_id, card.id);
            ref.owner_card_id = card.id;
            ref.target_rank = maxRank(roles);
            // Offboarding revokes the card, so it must not remove the last active Owner.
            if (body.status === 'departed' && roles.some((r) => r.role_key === 'company_owner') && card.state === 'active') {
              ref.removes_last_owner = (await otherUsableOwners(tx, subject.tenant_id, card.id, ctx.now)) === 0;
            }
          }
          return ref;
        },
      },
      handler: async ({ tx, subject, params, body, ctx }) => {
        let rows: PersonRow[];
        try {
          ({ rows } = await tx.query<PersonRow>(
            `UPDATE people SET
               display_name = COALESCE($2, display_name),
               email = CASE WHEN $3::boolean THEN $4 ELSE email END,
               department_id = CASE WHEN $5::boolean THEN $6::uuid ELSE department_id END,
               status = COALESCE($7, status), updated_at = now()
             WHERE id = $1 RETURNING ${PERSON_COLUMNS}`,
            [
              params.person_id, body.display_name ?? null, 'email' in body, typeof body.email === 'string' ? body.email.toLowerCase() : null,
              'department_id' in body, body.department_id ?? null, body.status ?? null,
            ]));
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === '23505') throw problems.unprocessable('A person with that email already exists');
          if (code === '23503') throw problems.unprocessable('Unknown department');
          throw err;
        }
        const person = rows[0];
        if (!person) throw problems.notFound();
        if (body.status === 'departed') {
          const live = await tx.query<CardRow>(
            `SELECT ${CARD_COLUMNS} FROM cards WHERE person_id = $1 AND state NOT IN ('revoked', 'replaced') FOR UPDATE`, [person.id]);
          for (const card of live.rows) await cards.revoke(tx, card, 'offboarded', subject.card_id, ctx);
          // the planned leaving date has served its purpose and is personal data: it goes when the person has left
          await clearLeavingDate(tx, subject.tenant_id, person.id);
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'person:update',
          resourceType: 'person', resourceId: person.id, decision: 'event', reasonCode: 'PERSON_UPDATED',
          requestId: ctx.requestId, ip: ctx.ip, details: { changed: Object.keys(body).sort().join(',') },
        });
        return { body: toApiPerson(person) };
      },
    },
    {
      operationId: 'createDepartment',
      kind: 'session',
      policy: { resource: collection('department') },
      handler: async ({ tx, subject, body }) => {
        try {
          const { rows } = await tx.query<{ id: string; name: string; created_at: Date }>(
            'INSERT INTO departments (tenant_id, name) VALUES ($1, $2) RETURNING id, name, created_at', [subject.tenant_id, body.name]);
          const d = rows[0] as { id: string; name: string; created_at: Date };
          return { status: 201, body: { id: d.id, name: d.name, created_at: d.created_at.toISOString() } };
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw problems.conflict('department-exists', 'A department with that name already exists');
          throw err;
        }
      },
    },
    {
      operationId: 'listDepartments',
      kind: 'session',
      listFilter: { unfiltered: 'the department list is the same for the whole company; every role holds department:read company-wide' },
      policy: { resource: collection('department') },
      handler: async ({ tx }) => {
        const { rows } = await tx.query<{ id: string; name: string; created_at: Date }>('SELECT id, name, created_at FROM departments ORDER BY name');
        return { body: { items: rows.map((d) => ({ id: d.id, name: d.name, created_at: d.created_at.toISOString() })) } };
      },
    },

    // ---------------------------------------------------------------- tenants
    {
      operationId: 'createTenant',
      kind: 'session',
      policy: { resource: collection('tenant') },
      handler: async ({ tx, subject, body, ctx }) => {
        const tenantId = randomUUID();
        // ONE transaction for everything: the new tenant's rows, the operator's audit row and the
        // idempotency record commit together or not at all. The transaction is switched to the new
        // tenant's id while its rows are written, so row-level security checks every insert.
        const created = await db.withinTenant(tx, tenantId, async () => {
          const tenant = await createTenant(tx, { id: tenantId, name: body.name, slug: body.slug });
          const settings = await getSettings(tx, tenantId);
          const person = await tx.query<PersonRow>(
            `INSERT INTO people (tenant_id, display_name, email) VALUES ($1, $2, $3) RETURNING ${PERSON_COLUMNS}`,
            [tenantId, body.owner_display_name, typeof body.owner_email === 'string' ? body.owner_email.toLowerCase() : null]);
          const owner = person.rows[0] as PersonRow;
          const company = await cards.issue(tx, { tenantId, kind: 'company', personId: null, roles: [], actorCardId: null }, settings, ctx);
          const ownerCard = await cards.issue(
            tx, { tenantId, kind: 'person', personId: owner.id, roles: [{ role_key: 'company_owner' }], actorCardId: null }, settings, ctx);
          await writeAudit(tx, {
            tenantId, actorKind: 'system', action: 'tenant:create', resourceType: 'tenant', resourceId: tenantId,
            decision: 'event', reasonCode: 'TENANT_CREATED', requestId: ctx.requestId, ip: ctx.ip,
          });
          return {
            tenant: toApiTenant(tenant),
            owner_person: toApiPerson(owner),
            company_card: withSecrets(await toApiCard(tx, company.card, ctx.now), company),
            owner_card: withSecrets(await toApiCard(tx, ownerCard.card, ctx.now), ownerCard),
          };
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'tenant:create',
          resourceType: 'tenant', resourceId: tenantId, decision: 'event', reasonCode: 'TENANT_CREATED',
          requestId: ctx.requestId, ip: ctx.ip, details: { target_tenant_id: tenantId },
        });
        await notifier.notify({ type: 'tenant_created', tenantId });
        return { status: 201, body: created };
      },
    },
    {
      // Company-card renewal is the subscription clock. Until billing owns it (Phase 4) only the
      // platform operator can move it; nobody inside the tenant can.
      operationId: 'renewCompanyCard',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const tenantId: string = params.tenant_id;
        const renewed = await db.withinTenant(tx, tenantId, async () => {
          await mustGetCustomerTenant(tx, tenantId);
          const found = await tx.query<CardRow>(
            `SELECT ${CARD_COLUMNS} FROM cards WHERE tenant_id = $1 AND kind = 'company' AND state NOT IN ('revoked', 'replaced') FOR UPDATE`,
            [tenantId]);
          const card = found.rows[0];
          if (!card) throw problems.notFound();
          const settings = await getSettings(tx, tenantId);
          const result = await cards.renew(tx, card, body?.validity_days, { operatorCardId: subject.card_id }, settings, ctx);
          return withSecrets(await toApiCard(tx, result.card, ctx.now), result);
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'tenant:renew_company_card',
          resourceType: 'tenant', resourceId: tenantId, decision: 'event', reasonCode: 'COMPANY_CARD_RENEWED',
          requestId: ctx.requestId, ip: ctx.ip, details: { target_tenant_id: tenantId },
        });
        await notifier.notify({ type: 'company_card_renewed', tenantId });
        return { body: renewed };
      },
    },
    {
      // Recovery of a Company Owner who cannot sign in. See docs/runbooks/owner-recovery.md: the
      // operator must first verify the person's identity out of band and quote that record here.
      operationId: 'recoverOwnerCard',
      kind: 'session',
      policy: { resource: targetTenant },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const tenantId: string = params.tenant_id;
        const reference: string = body.verification_reference;
        // The audit log refuses anything that looks like a card number; say so clearly instead of failing later.
        if (/\d{16}/.test(reference)) {
          throw problems.unprocessable('The reference must be a case id', [{ path: 'body/verification_reference', message: 'must not contain 16 digits in a row' }]);
        }
        const cardNumber = body.card_number === undefined ? null : normalizeCardNumber(body.card_number);
        if (body.card_number !== undefined && cardNumber === null) throw problems.notFound();
        const recovered = await db.withinTenant(tx, tenantId, async () => {
          await mustGetCustomerTenant(tx, tenantId);
          await lockTenantRoles(tx, tenantId);
          // The Owner's card is named by its id or - what the Owner can read off their own card - its number.
          const found = cardNumber === null
            ? await getCard(tx, body.card_id, true)
            : (await tx.query<CardRow>(`SELECT ${CARD_COLUMNS} FROM cards WHERE tenant_id = $1 AND card_number = $2 FOR UPDATE`, [tenantId, cardNumber])).rows[0] ?? null;
          const card = found;
          if (!card) throw problems.notFound();
          const roles = await loadRoles(tx, tenantId, card.id);
          if (card.kind !== 'person' || !roles.some((r) => r.role_key === 'company_owner')) {
            // Everyone below an Owner is recovered inside the tenant, by an Owner or Admin.
            throw problems.conflict('not-an-owner-card', 'Only a Company Owner card can be recovered by the platform operator');
          }
          const settings = await getSettings(tx, tenantId);
          const result = await cards.recoverOwner(tx, card, { operatorCardId: subject.card_id }, reference, settings, ctx);
          // Every OTHER Owner of the company is told that an Owner card was recovered.
          const others = await tx.query<{ id: string }>(
            `SELECT c.id FROM cards c JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
              WHERE c.tenant_id = $1 AND c.id <> $2 AND c.kind = 'person' AND c.state IN ('active', 'expired')
                AND cr.role_key = 'company_owner' ORDER BY c.id`,
            [tenantId, card.id]);
          for (const o of others.rows) {
            await notifier.notify({ type: 'owner_recovered', tenantId, cardId: card.id, recipientCardId: o.id });
          }
          return { cardId: card.id, body: { ...withSecrets(await toApiCard(tx, result.card, ctx.now), result), notified_owner_count: others.rows.length } };
        });
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'tenant:recover_owner',
          resourceType: 'tenant', resourceId: tenantId, decision: 'event', reasonCode: 'OWNER_RECOVERED',
          requestId: ctx.requestId, ip: ctx.ip,
          details: { target_tenant_id: tenantId, target_card_id: recovered.cardId, verification_ref: reference },
        });
        return { status: 201, body: recovered.body };
      },
    },
    {
      operationId: 'listTenants',
      kind: 'session',
      listFilter: { unfiltered: 'platform operator only; the list of companies has no narrower scope' },
      policy: { resource: collection('tenant') },
      handler: async ({ subject, query }) => {
        const after = decodeIdCursor(query.cursor);
        // Read-only cross-tenant listing: reached only after the policy point allowed tenant:list
        // (a platform-only permission).
        const rows = await db.withTenantTx(subject.tenant_id, (ptx) => listTenants(ptx, query.limit + 1, after), { platformScope: true });
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        return { body: { items: page.map(toApiTenant), next_cursor: rows.length > query.limit && last ? encodeCursor(last.id) : null } };
      },
    },
    {
      operationId: 'updateTenantSettings',
      kind: 'session',
      policy: { resource: async ({ subject }) => ({ type: 'tenant_settings', id: subject.tenant_id, tenant_id: subject.tenant_id }) },
      handler: async ({ tx, subject, body, ctx }) => {
        const settings = await updateSettings(tx, subject.tenant_id, body, subject.card_id);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'tenant_settings:update',
          resourceType: 'tenant_settings', resourceId: subject.tenant_id, decision: 'event', reasonCode: 'SETTINGS_CHANGED',
          requestId: ctx.requestId, ip: ctx.ip, details: { changed: Object.keys(body).sort().join(',') },
        });
        // Changing which roles are enabled changes what the caller's own session can do:
        // privilege change => the session id is rotated.
        if ('enabled_roles' in body || 'pilot_reviewer_grant' in body) {
          return { body: settings, setSessionCookie: await rotateSession(tx, subject) };
        }
        return { body: settings };
      },
    },
    {
      operationId: 'getTenantUsage',
      kind: 'session',
      policy: { resource: async ({ subject }) => ({ type: 'tenant_usage', id: subject.tenant_id, tenant_id: subject.tenant_id }) },
      handler: async ({ tx, subject, ctx }) => {
        const tenantId = subject.tenant_id;
        const tenant = await getTenant(tx, tenantId);
        if (!tenant) throw problems.notFound();
        const byState = await tx.query<{ state: string; n: string }>('SELECT state, count(*)::text AS n FROM cards WHERE tenant_id = $1 GROUP BY state', [tenantId]);
        const one = async (text: string, params: unknown[]): Promise<number> => Number((await tx.query<{ n: string }>(text, params)).rows[0]?.n ?? 0);
        return {
          body: {
            cards_by_state: Object.fromEntries(byState.rows.map((r) => [r.state, Number(r.n)])),
            people: await one('SELECT count(*)::text AS n FROM people WHERE tenant_id = $1', [tenantId]),
            active_sessions: await one(
              'SELECT count(*)::text AS n FROM sessions WHERE tenant_id = $1 AND revoked_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2',
              [tenantId, ctx.now]),
            cards_expiring_soon: await one(
              `SELECT count(*)::text AS n FROM cards WHERE tenant_id = $1 AND state = 'active' AND renewal_due <= $2`, [tenantId, ctx.now]),
            audit_rows: await countAuditRows(tx, tenantId),
            logins_last_30_days: await one(
              `SELECT count(*)::text AS n FROM card_events WHERE tenant_id = $1 AND event_type = 'login_success' AND occurred_at > $2`,
              [tenantId, new Date(ctx.now.getTime() - 30 * 86_400_000)]),
            cards_able_to_unlock: await one(
              `SELECT count(DISTINCT c.id)::text AS n FROM cards c JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
                WHERE c.tenant_id = $1 AND c.state = 'active' AND c.expires_at > $2 AND cr.role_key IN ('company_owner', 'admin')`,
              [tenantId, ctx.now]),
            plan: await getPlan(tx, tenant.plan_code),
            // the seats paid for this term and how many are taken: what whoever issues cards needs to know
            seats: (await deps.billing.seats?.(tx, tenantId)) ?? null,
          },
        };
      },
    },
  ];
}

