// HTTP endpoints for the retirement radar (feature 11): a person's planned leaving date, and the list of people
// who leave soon.
//
// As everywhere: handlers make no access decisions. Each route names what is acted on; the HTTP layer asks the
// policy decision point before the handler runs.
import { problems } from '../../../shared/errors.ts';
import { isUuid } from '../../../shared/crypto.ts';
import type { RequestContext, ResourceRef, Subject } from '../../../shared/policy-types.ts';
import { pageOf, writeAudit, type Notifier, type RouteDef, type Tx } from '../../platform/index.ts';
import type { Authorizer } from './authz.ts';
import { lockTenantRoles, maxRank } from './cards.ts';
import {
  clearLeavingDate, getLeavingDate, isRealDate, monthsLeft, radarEnd, setLeavingDate, stageOf, sweepRetirementNudges, today, validateLeavingDate,
} from './leaving.ts';
import type { ResourceDescriptor } from './policy.ts';
import { loadRoles } from './sessions.ts';

/**
 * What the knowledge side holds from a person, ALREADY narrowed to what the asking card may read there.
 * Null = the card has no right to that kind of thing (it is then not told a number at all).
 * Implemented by the knowledge module and plugged in by app.ts: this module reads no knowledge table.
 */
export interface PersonHoldings { job_roles: string[] | null; verified_items: number | null; interviews_completed: number | null }
export type PersonHoldingsLoader = (tx: Tx, subject: Subject, personIds: readonly string[], ctx: RequestContext) => Promise<Map<string, PersonHoldings>>;
const NOTHING_KNOWN: PersonHoldings = { job_roles: null, verified_items: null, interviews_completed: null };

export interface LeavingRouteDeps {
  authorizer: Authorizer;
  notifier: Notifier;
  /** Looked up at request time: app.ts plugs the loader in after both modules exist. */
  holdings: () => PersonHoldingsLoader | null;
}

const PERSON_DESCRIPTOR: ResourceDescriptor = {
  type: 'person', tenantExpr: 'people.tenant_id', ownerPersonExpr: 'people.id', departmentExpr: 'people.department_id',
};

interface PersonLite { id: string; department_id: string | null }
async function findPerson(tx: Tx, personId: string): Promise<PersonLite | null> {
  const { rows } = await tx.query<PersonLite>('SELECT id, department_id FROM people WHERE id = $1', [personId]);
  return rows[0] ?? null;
}

/** For READING a person's leaving date: the person's own access rule (a person may read their own). */
const personToRead = async ({ tx, subject, params }: { tx: Tx; subject: Subject; params: { person_id: string } }): Promise<ResourceRef | null> => {
  const p = await findPerson(tx, params.person_id);
  return p ? { type: 'person', id: p.id, tenant_id: subject.tenant_id, owner_person_id: p.id, department_id: p.department_id } : null;
};

/** For CHANGING it: guarded like every change to a person - not on yourself, not on someone who outranks you. */
const personToChange = async ({ tx, subject, params }: { tx: Tx; subject: Subject; params: { person_id: string } }): Promise<ResourceRef | null> => {
  const p = await findPerson(tx, params.person_id);
  if (!p) return null;
  await lockTenantRoles(tx, subject.tenant_id);
  const ref: ResourceRef = { type: 'person', id: p.id, tenant_id: subject.tenant_id, owner_person_id: p.id, department_id: p.department_id, target_rank: 0 };
  const live = await tx.query<{ id: string }>(`SELECT id FROM cards WHERE person_id = $1 AND state NOT IN ('revoked', 'replaced')`, [p.id]);
  const card = live.rows[0];
  if (card) {
    ref.owner_card_id = card.id;
    ref.target_rank = maxRank(await loadRoles(tx, subject.tenant_id, card.id));
  }
  return ref;
};

function leavingBody(personId: string, row: { leaving_on: string; updated_at: string } | null, now: Date): Record<string, unknown> {
  return {
    person_id: personId,
    leaving_on: row?.leaving_on ?? null,
    months_left: row ? monthsLeft(row.leaving_on, now) : null,
    stage: row ? stageOf(row.leaving_on, now) : null,
    updated_at: row?.updated_at ?? null,
  };
}

// The radar is ordered by (leaving date, person id); its cursor is the last pair of the page.
const invalidCursor = (): Error => problems.badRequest([{ path: 'query/cursor', message: 'invalid cursor' }]);
export function encodeRadarCursor(leavingOn: string, personId: string): string {
  return Buffer.from(`${leavingOn}|${personId}`, 'utf8').toString('base64url');
}
export function decodeRadarCursor(cursor: unknown): { leaving_on: string; person_id: string } | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string' || cursor.length > 200) throw invalidCursor();
  const [date, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (date === undefined || id === undefined || extra !== undefined || !isRealDate(date) || !isUuid(id)) throw invalidCursor();
  return { leaving_on: date, person_id: id };
}

export function leavingRoutes(deps: LeavingRouteDeps): RouteDef[] {
  const { authorizer, notifier } = deps;
  return [
    {
      operationId: 'getLeavingDate',
      kind: 'session',
      policy: { resource: personToRead },
      handler: async ({ tx, subject, params, ctx }) => ({
        body: leavingBody(params.person_id, await getLeavingDate(tx, subject.tenant_id, params.person_id), ctx.now),
      }),
    },
    {
      operationId: 'setLeavingDate',
      kind: 'session',
      policy: { resource: personToChange },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const leavingOn = String(body.leaving_on);
        validateLeavingDate(leavingOn, ctx.now);
        await setLeavingDate(tx, subject.tenant_id, params.person_id, leavingOn, subject.card_id, ctx.now);
        await writeAudit(tx, {
          tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'person:update', resourceType: 'person',
          resourceId: params.person_id, decision: 'event', reasonCode: 'LEAVING_DATE_SET', requestId: ctx.requestId, ip: ctx.ip,
          details: { changed: 'leaving_on' },
        });
        // only this person's nudge: the company-wide sweep belongs to the housekeeping job, not to a request
        await sweepRetirementNudges(tx, subject.tenant_id, ctx.now, notifier, ctx.requestId, params.person_id);
        return { body: leavingBody(params.person_id, await getLeavingDate(tx, subject.tenant_id, params.person_id), ctx.now) };
      },
    },
    {
      operationId: 'clearLeavingDate',
      kind: 'session',
      policy: { resource: personToChange },
      handler: async ({ tx, subject, params, ctx }) => {
        if (await clearLeavingDate(tx, subject.tenant_id, params.person_id)) {
          await writeAudit(tx, {
            tenantId: subject.tenant_id, actorCardId: subject.card_id, actorKind: 'card', action: 'person:update', resourceType: 'person',
            resourceId: params.person_id, decision: 'event', reasonCode: 'LEAVING_DATE_CLEARED', requestId: ctx.requestId, ip: ctx.ip,
            details: { changed: 'leaving_on' },
          });
        }
        return { status: 204 };
      },
    },
    // People who leave in less than 24 months, soonest first. Narrowed like the people list: a card that may read
    // only its own person sees only its own entry. What the knowledge side holds from each person comes from that
    // module, narrowed by the card's rights THERE; a card without those rights gets no numbers.
    {
      operationId: 'getRetirementRadar',
      kind: 'session',
      listFilter: 'applied',
      policy: { resource: async ({ subject }) => ({ type: 'person', tenant_id: subject.tenant_id, collection: true }) },
      handler: async ({ tx, subject, query, ctx }) => {
        const after = decodeRadarCursor(query.cursor);
        const filter = await authorizer.filter(tx, subject, 'person:read', PERSON_DESCRIPTOR, ctx, 6);
        const { rows } = await tx.query<{ id: string; display_name: string; department_id: string | null; leaving_on: string }>(
          // eslint-disable-next-line no-restricted-syntax -- filter.sql is built by the policy module from code constants; all values are bound
          `SELECT people.id, people.display_name, people.department_id, l.leaving_on::text AS leaving_on
             FROM person_leaving l JOIN people ON people.tenant_id = l.tenant_id AND people.id = l.person_id
            WHERE people.status = 'active' AND l.leaving_on >= $1::date AND l.leaving_on < $2::date
              AND ($3::date IS NULL OR (l.leaving_on, people.id) > ($3::date, $4::uuid))
              AND ${filter.sql}
            ORDER BY l.leaving_on, people.id LIMIT $5`,
          [today(ctx.now), radarEnd(ctx.now), after?.leaving_on ?? null, after?.person_id ?? null, query.limit + 1, ...filter.params]);
        const page = pageOf(rows, query.limit, (last) => encodeRadarCursor(last.leaving_on, last.id));
        const loader = deps.holdings();
        const held = loader === null || page.items.length === 0
          ? new Map<string, PersonHoldings>() : await loader(tx, subject, page.items.map((r) => r.id), ctx);
        return {
          body: {
            items: page.items.map((r) => ({
              person_id: r.id, display_name: r.display_name, department_id: r.department_id, leaving_on: r.leaving_on,
              months_left: monthsLeft(r.leaving_on, ctx.now), stage: stageOf(r.leaving_on, ctx.now),
              ...(held.get(r.id) ?? NOTHING_KNOWN),
            })),
            next_cursor: page.next_cursor,
          },
        };
      },
    },
  ];
}
