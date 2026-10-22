// SCIM endpoints for the company's directory (feature 16, part B; docs/phase4/07-sso-scim.md, decision D34).
// Base address /v1/scim/v2 - what a directory is configured with, together with a directory key.
//
// As everywhere: handlers make no access decisions. The policy decides (person:scim is a key-only permission, so a
// signed-in card is refused; nobody whose card holds the Owner role is within reach). What the directory sees and
// changes is narrowed in the queries below to the people it manages (scim_managed): everybody else is "not found".
import { problems } from '../../../shared/errors.ts';
import { actingCardId, type RequestContext, type ResourceRef, type Subject } from '../../../shared/policy-types.ts';
import { writeAudit, type RouteDef, type Tx } from '../../platform/index.ts';
import { lockTenantRoles, type CardService } from './cards.ts';
import { offboardPerson, personRank } from './departure.ts';
import {
  applyPatch, parseScimFilter, SCIM_LIST_SCHEMA, SCIM_PERSON_COLUMNS, scimStateOf, ScimInputError, serviceProviderConfig, stateOfRow, toScimUser,
  type PatchOperation, type ScimPersonRow, type ScimState,
} from './scim.ts';

const BASE = '/v1/scim/v2';
const location = (id: string): string => `${BASE}/Users/${id}`;
/** Nobody whose live card holds a role of this rank or above appears to the directory (the policy refuses them too). */
const OWNER_RANK = 100;
const NOT_AN_OWNER = `NOT EXISTS (SELECT 1 FROM cards c JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
                                   JOIN roles r ON r.role_key = cr.role_key
                                  WHERE c.tenant_id = people.tenant_id AND c.person_id = people.id
                                    AND c.state NOT IN ('revoked', 'replaced') AND r.rank >= ${OWNER_RANK})`;

const inputError = (err: unknown): never => {
  if (err instanceof ScimInputError) throw problems.badRequest([{ path: 'body', message: err.message }]);
  throw err;
};

const collection = async ({ subject }: { subject: Subject }): Promise<ResourceRef> => ({ type: 'person', tenant_id: subject.tenant_id, collection: true });

// tenant_id as well as row-level security: defence in depth
const MANAGED = `SELECT ${SCIM_PERSON_COLUMNS} FROM people WHERE tenant_id = $2 AND id = $1 AND scim_managed`;
const MANAGED_FOR_UPDATE = `${MANAGED} FOR UPDATE`;

async function managedPerson(tx: Tx, tenantId: string, personId: string, forUpdate = false): Promise<ScimPersonRow | null> {
  const { rows } = await tx.query<ScimPersonRow>(forUpdate ? MANAGED_FOR_UPDATE : MANAGED, [personId, tenantId]);
  return rows[0] ?? null;
}

/** One person, as the policy needs it: only people the directory manages, and how high their live card ranks. */
async function onePerson({ tx, subject, params }: { tx: Tx; subject: Subject; params: { person_id: string } }): Promise<ResourceRef | null> {
  const row = await managedPerson(tx, subject.tenant_id, params.person_id);
  if (row === null) return null;
  // the roles of the company cannot change between this rank and the work it guards (as for updatePerson): otherwise
  // an Owner card issued at the same moment could be revoked by a directory that read the person as no Owner
  await lockTenantRoles(tx, subject.tenant_id);
  return { type: 'person', id: row.id, tenant_id: subject.tenant_id, owner_person_id: row.id, target_rank: await personRank(tx, subject.tenant_id, row.id) };
}

const keyDetails = (subject: Subject): Record<string, string> => (subject.kind === 'api_key' ? { api_key_id: subject.key_id } : {});

export function scimRoutes(deps: { cards: CardService }): RouteDef[] {
  const { cards } = deps;

  const audit = (tx: Tx, subject: Subject, ctx: RequestContext, personId: string, reasonCode: string, changed: string[]): Promise<void> => writeAudit(tx, {
    tenantId: subject.tenant_id, actorCardId: actingCardId(subject), actorKind: 'card', action: 'person:scim', resourceType: 'person',
    resourceId: personId, decision: 'event', reasonCode, requestId: ctx.requestId, ip: ctx.ip,
    details: { ...keyDetails(subject), changed: changed.sort().join(',') },
  });

  /** Writes the directory's view of a person; marks them departed (and offboards them) when active turns false. */
  async function write(tx: Tx, subject: Subject, ctx: RequestContext, before: ScimPersonRow, next: ScimState): Promise<ScimPersonRow> {
    let rows: ScimPersonRow[];
    try {
      ({ rows } = await tx.query<ScimPersonRow>(
        `UPDATE people SET scim_user_name = $2, display_name = $3, email = $4, external_id = $5,
                status = CASE WHEN $6::boolean THEN 'active' ELSE 'departed' END, updated_at = $7
          WHERE tenant_id = $8 AND id = $1 AND scim_managed RETURNING ${SCIM_PERSON_COLUMNS}`,
        [before.id, next.userName, next.displayName, next.email, next.externalId, next.active, ctx.now, subject.tenant_id]));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw problems.conflict('scim-uniqueness', 'Another person already has this userName, externalId or e-mail address');
      throw err;
    }
    const after = rows[0] as ScimPersonRow;
    const was = stateOfRow(before);
    const changed = (Object.keys(next) as Array<keyof ScimState>).filter((k) => next[k] !== was[k]);
    if (was.active && !next.active) {
      await offboardPerson(tx, cards, { tenantId: subject.tenant_id, personId: before.id, actorCardId: actingCardId(subject) }, ctx);
      await audit(tx, subject, ctx, before.id, 'SCIM_USER_DEPARTED', changed);
    } else if (changed.length > 0) {
      await audit(tx, subject, ctx, before.id, 'SCIM_USER_UPDATED', changed);
    }
    return after;
  }

  return [
    {
      operationId: 'scimServiceProviderConfig',
      kind: 'session-or-key',   // a directory key (openapi.yaml: x-api-key); the policy refuses a signed-in card
      listFilter: { unfiltered: 'A fixed description of what this server supports; nothing of the company is listed.' },
      policy: { resource: collection },
      handler: async () => ({ body: serviceProviderConfig('docs/phase4/07-sso-scim.md') }),
    },
    {
      operationId: 'scimListUsers',
      kind: 'session-or-key',
      listFilter: { unfiltered: 'The people the directory manages, of the whole company (never an Owner): a directory key is made for the whole company.' },
      policy: { resource: collection },
      handler: async ({ tx, query }) => {
        let filter;
        try {
          filter = parseScimFilter(query.filter);
        } catch (err) {
          inputError(err);
        }
        const where = `people.scim_managed AND ${NOT_AN_OWNER}
          AND ($1::text IS NULL OR lower(people.scim_user_name) = lower($1)) AND ($2::text IS NULL OR people.external_id = $2)`;
        const args = [filter?.attribute === 'userName' ? filter.value : null, filter?.attribute === 'externalId' ? filter.value : null];
        const startIndex = query.startIndex ?? 1;
        const count = query.count ?? 100;
        // eslint-disable-next-line no-restricted-syntax -- `where` is written in this file from constants; all values are bound
        const total = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM people WHERE ${where}`, args);
        // eslint-disable-next-line no-restricted-syntax -- as above
        const { rows } = await tx.query<ScimPersonRow>(`SELECT ${SCIM_PERSON_COLUMNS} FROM people WHERE ${where} ORDER BY people.id OFFSET $3 LIMIT $4`,
          [...args, startIndex - 1, count]);
        return {
          body: {
            schemas: [SCIM_LIST_SCHEMA], totalResults: total.rows[0]?.n ?? 0, startIndex, itemsPerPage: rows.length,
            Resources: rows.map((r) => toScimUser(r, location(r.id))),
          },
        };
      },
    },
    {
      operationId: 'scimCreateUser',
      kind: 'session-or-key',
      policy: { resource: collection },
      handler: async ({ tx, subject, body, ctx }) => {
        let state: ScimState;
        try {
          state = scimStateOf(body);
        } catch (err) {
          return inputError(err);
        }
        let rows: ScimPersonRow[];
        try {
          ({ rows } = await tx.query<ScimPersonRow>(
            `INSERT INTO people (tenant_id, display_name, email, status, scim_managed, scim_user_name, external_id, created_at, updated_at)
             VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN 'active' ELSE 'departed' END, true, $5, $6, $7, $7) RETURNING ${SCIM_PERSON_COLUMNS}`,
            [subject.tenant_id, state.displayName, state.email, state.active, state.userName, state.externalId, ctx.now]));
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw problems.conflict('scim-uniqueness', 'Another person already has this userName, externalId or e-mail address');
          throw err;
        }
        const row = rows[0] as ScimPersonRow;
        await audit(tx, subject, ctx, row.id, 'SCIM_USER_CREATED', Object.keys(state));
        return { status: 201, body: toScimUser(row, location(row.id)) };
      },
    },
    {
      operationId: 'scimGetUser',
      kind: 'session-or-key',
      policy: { resource: onePerson },
      handler: async ({ tx, subject, params }) => {
        const row = await managedPerson(tx, subject.tenant_id, params.person_id);
        if (row === null) throw problems.notFound();
        return { body: toScimUser(row, location(row.id)) };
      },
    },
    {
      operationId: 'scimReplaceUser',
      kind: 'session-or-key',
      policy: { resource: onePerson },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const before = await managedPerson(tx, subject.tenant_id, params.person_id, true);
        if (before === null) throw problems.notFound();
        let next: ScimState;
        try {
          next = scimStateOf(body);
        } catch (err) {
          return inputError(err);
        }
        const after = await write(tx, subject, ctx, before, next);
        return { body: toScimUser(after, location(after.id)) };
      },
    },
    {
      operationId: 'scimPatchUser',
      kind: 'session-or-key',
      policy: { resource: onePerson },
      handler: async ({ tx, subject, params, body, ctx }) => {
        const before = await managedPerson(tx, subject.tenant_id, params.person_id, true);
        if (before === null) throw problems.notFound();
        let next: ScimState;
        try {
          next = applyPatch(stateOfRow(before), (body as { Operations: PatchOperation[] }).Operations);
        } catch (err) {
          return inputError(err);
        }
        const after = await write(tx, subject, ctx, before, next);
        return { body: toScimUser(after, location(after.id)) };
      },
    },
    {
      // RFC 7644 3.6: afterwards the directory must get 404 for this person. The person is NOT erased (their history
      // stays): they are marked as left, their cards are revoked, and they leave the directory's reach - an ordinary
      // departed person that an administrator manages.
      operationId: 'scimDeleteUser',
      kind: 'session-or-key',
      policy: { resource: onePerson },
      handler: async ({ tx, subject, params, ctx }) => {
        const before = await managedPerson(tx, subject.tenant_id, params.person_id, true);
        if (before === null) throw problems.notFound();
        await tx.query(
          `UPDATE people SET status = 'departed', scim_managed = false, scim_user_name = NULL, external_id = NULL, updated_at = $2 WHERE tenant_id = $3 AND id = $1`,
          [before.id, ctx.now, subject.tenant_id]);
        if (before.status === 'active') await offboardPerson(tx, cards, { tenantId: subject.tenant_id, personId: before.id, actorCardId: actingCardId(subject) }, ctx);
        await audit(tx, subject, ctx, before.id, 'SCIM_USER_REMOVED', ['active']);
        return { status: 204 };
      },
    },
  ];
}
