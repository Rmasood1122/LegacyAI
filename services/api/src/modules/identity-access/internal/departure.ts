// A person has left the company: the one way it happens, whoever records it (an administrator through updatePerson,
// or the company's directory through SCIM, D34). Every live card of the person is revoked (which ends its sessions
// and the API keys it made), and the planned leaving date - personal data that has served its purpose - goes.
import type { RequestContext } from '../../../shared/policy-types.ts';
import type { Tx } from '../../platform/index.ts';
import { CARD_COLUMNS, type CardRow, type CardService } from './cards.ts';
import { clearLeavingDate } from './leaving.ts';

/** The person must already be marked departed by the caller (in the same transaction). */
export async function offboardPerson(
  tx: Tx, cards: CardService, p: { tenantId: string; personId: string; actorCardId: string | null }, ctx: RequestContext,
): Promise<void> {
  const live = await tx.query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM cards WHERE tenant_id = $2 AND person_id = $1 AND state NOT IN ('revoked', 'replaced') FOR UPDATE`, [p.personId, p.tenantId]);
  for (const card of live.rows) await cards.revoke(tx, card, 'offboarded', p.actorCardId, ctx);
  await clearLeavingDate(tx, p.tenantId, p.personId);
}

/** The highest role rank held by the person's live cards (0 without one): what the rank guards look at. */
export async function personRank(tx: Tx, tenantId: string, personId: string): Promise<number> {
  const { rows } = await tx.query<{ rank: number | null }>(
    `SELECT max(r.rank)::int AS rank FROM cards c
       JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
       JOIN roles r ON r.role_key = cr.role_key
      WHERE c.tenant_id = $1 AND c.person_id = $2 AND c.state NOT IN ('revoked', 'replaced')`, [tenantId, personId]);
  return rows[0]?.rank ?? 0;
}
