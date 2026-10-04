// The company's term as the billing module sees it (the CompanyTermPort).
//
// The term IS the company card's validity (decision D19): its expiry date is the one renewal date of the whole
// company, and renewing it is the existing card renewal - new dates and a rotated secret code. Nothing about renewal
// is re-implemented here. The company card is not a login, so the new secret code is not handed to anyone.
import type { CompanyTerm, CompanyTermPort } from '../../billing/index.ts';
import { getSettings, type Tx } from '../../platform/index.ts';
import { CARD_COLUMNS, type CardRow, type CardService } from './cards.ts';

const COMPANY_CARD = `SELECT ${CARD_COLUMNS} FROM cards WHERE tenant_id = $1 AND kind = 'company' AND state NOT IN ('revoked', 'replaced')`;

async function termOf(tx: Tx, tenantId: string, card: CardRow): Promise<CompanyTerm> {
  const settings = await getSettings(tx, tenantId);
  const used = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM cards WHERE tenant_id = $1 AND kind = 'person' AND state NOT IN ('revoked', 'replaced')`, [tenantId]);
  return {
    expiresAt: card.expires_at, graceUntil: card.grace_until, renewalDue: card.renewal_due,
    termDays: settings.card_validity_days, personCards: used.rows[0]?.n ?? 0,
  };
}

export function companyTerm(cards: CardService): CompanyTermPort {
  return {
    term: async (tx, tenantId) => {
      const { rows } = await tx.query<CardRow>(COMPANY_CARD, [tenantId]);
      return rows[0] ? termOf(tx, tenantId, rows[0]) : null;
    },
    renew: async (tx, tenantId, ctx) => {
      const { rows } = await tx.query<CardRow>(`${COMPANY_CARD} FOR UPDATE`, [tenantId]);
      const card = rows[0];
      if (!card) throw new Error('companyTerm: the company has no company card');
      const settings = await getSettings(tx, tenantId);
      // actor null = the system (billing): the audit row and the card's history say so
      const renewed = await cards.renew(tx, card, undefined, null, settings, ctx);
      return termOf(tx, tenantId, renewed.card);
    },
  };
}
