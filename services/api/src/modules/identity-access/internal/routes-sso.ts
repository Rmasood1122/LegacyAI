// HTTP endpoints for SSO (feature 16, part A; D33): the Owner's connection to the company's identity provider, and
// the two public steps of a sign-in there. As everywhere: handlers make no access decisions of their own.
import { problems } from '../../../shared/errors.ts';
import type { CardSubject, ResourceRef } from '../../../shared/policy-types.ts';
import { writeAudit, type RouteDef } from '../../platform/index.ts';
import type { AuthService } from './auth.ts';
import type { CardService } from './cards.ts';
import { toApiConnection, type ConnectionInput, type ConnectionProblem, type SsoService } from './sso.ts';

const PROBLEM_TEXT: Readonly<Record<ConnectionProblem, [number, string, string]>> = {
  'issuer-changed': [409, 'sso-issuer-changed', 'The provider of a connection cannot change; remove the connection first'],
  'secret-required': [422, 'unprocessable', 'A new connection needs the client secret'],
  'bad-issuer': [422, 'unprocessable', 'The issuer must be a public https address (port 443, a host name, no query or fragment)'],
};

const theConnection = async ({ subject }: { subject: CardSubject }): Promise<ResourceRef> => ({ type: 'sso_connection', tenant_id: subject.tenant_id, collection: true });

export function ssoRoutes(deps: { auth: AuthService; sso: SsoService; cards: CardService }): RouteDef[] {
  const { auth, sso, cards } = deps;
  return [
    {
      operationId: 'ssoStart',
      kind: 'public',
      policy: { public: true, reason: 'Signing in at the company identity provider happens before there is a session. Decided by the company named, never by the card.' },
      flowCookie: true,
      handler: ({ ctx, body }) => auth.ssoStart(ctx, body),
    },
    {
      operationId: 'ssoFinish',
      kind: 'public',
      policy: { public: true, reason: 'The identity provider sends the browser back before there is a session. Redeems a single-use state; one answer for every failure.' },
      flowCookie: true,
      handler: ({ ctx, body, flowCookie }) => auth.ssoFinish(ctx, body, flowCookie),
    },
    {
      operationId: 'getSsoConnection',
      kind: 'session',
      listFilter: { unfiltered: "The company's one connection; it is not tied to a department or a level." },
      policy: { resource: theConnection },
      handler: async ({ tx, subject }) => {
        const row = await sso.get(tx, subject.tenant_id);
        return { body: { connection: row === null ? null : toApiConnection(row, sso.redirectUriFor(subject.tenant_id)), redirect_uri: sso.redirectUriFor(subject.tenant_id) } };
      },
    },
    {
      operationId: 'putSsoConnection',
      kind: 'session',
      policy: { resource: theConnection },
      handler: async ({ tx, subject, body, ctx }) => {
        const result = await sso.put(tx, subject.tenant_id, subject.card_id, body as ConnectionInput, ctx.now);
        if (typeof result === 'string') {
          const [status, code, title] = PROBLEM_TEXT[result];
          throw status === 409 ? problems.conflict(code, title) : problems.unprocessable(title);
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'sso:manage', resourceType: 'sso_connection',
          resourceId: result.id, decision: 'event', reasonCode: 'SSO_CONNECTION_SET', requestId: ctx.requestId, ip: ctx.ip,
          details: { sso_connection_id: result.id, changed: Object.keys(body as object).filter((k) => k !== 'client_secret').sort().join(','), status: result.enabled ? 'on' : 'off' },
        });
        return { body: toApiConnection(result, sso.redirectUriFor(subject.tenant_id)) };
      },
    },
    {
      operationId: 'removeSsoConnection',
      kind: 'session',
      policy: { resource: theConnection },
      handler: async ({ tx, subject, ctx }) => {
        const removed = await sso.remove(tx, subject.tenant_id, ctx.now);
        if (removed === null) throw problems.notFound();
        // Every SSO factor linked through it was revoked: the sessions opened with each end now, through the one
        // function that ends sessions (it also ends the API keys those cards made - a key does not outlive a change
        // of its maker's sign-in, D30).
        for (const r of removed.revoked) {
          await cards.revokeSessions(tx, { id: r.cardId, tenant_id: subject.tenant_id }, 'credentials_reset', ctx.now, { openedWithCredentialId: r.credentialId });
          await cards.event(tx, { id: r.cardId, tenant_id: subject.tenant_id }, 'credential_removed', subject.card_id, ctx, {}, r.credentialId);
        }
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'sso:manage', resourceType: 'sso_connection',
          resourceId: removed.connectionId, decision: 'event', reasonCode: 'SSO_CONNECTION_REMOVED', requestId: ctx.requestId, ip: ctx.ip,
          details: { sso_connection_id: removed.connectionId, count: removed.revoked.length },
        });
        return { body: { removed: true, factors_revoked: removed.revoked.length } };
      },
    },
  ];
}
