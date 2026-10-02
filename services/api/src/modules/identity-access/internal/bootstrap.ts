// One-time creation of the first LegacyAI operator card in the platform tenant.
// After this, operators sign in like everyone else (card + SC + strong factor).
import type { RequestContext } from '../../../shared/policy-types.ts';
import { getSettings, PLATFORM_TENANT_ID, writeAudit, type Database } from '../../platform/index.ts';
import { formatCardNumber, normalizeCardNumber } from './card-number.ts';
import { CARD_COLUMNS, type CardRow, type CardService } from './cards.ts';

export interface BootstrapResult {
  card_id: string;
  card_number: string;
  sc: string;
  enrollment_token: string;
  enrollment_token_expires_at: string;
}

export async function bootstrapOperator(db: Database, cards: CardService, ctx: RequestContext): Promise<BootstrapResult> {
  return db.withTenantTx(PLATFORM_TENANT_ID, async (tx) => {
    const existing = await tx.query(
      `SELECT 1 FROM cards c JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id
        WHERE c.tenant_id = $1 AND cr.role_key = 'company_owner' AND c.state NOT IN ('revoked', 'replaced') LIMIT 1`,
      [PLATFORM_TENANT_ID]);
    if (existing.rowCount > 0) {
      throw new Error('The platform tenant already has an operator card. Bootstrap runs once; use the API to add more.');
    }
    const person = await tx.query<{ id: string }>(
      'INSERT INTO people (tenant_id, display_name) VALUES ($1, $2) RETURNING id', [PLATFORM_TENANT_ID, 'Platform Operator']);
    const settings = await getSettings(tx, PLATFORM_TENANT_ID);
    const issued = await cards.issue(
      tx,
      { tenantId: PLATFORM_TENANT_ID, kind: 'person', personId: (person.rows[0] as { id: string }).id, roles: [{ role_key: 'company_owner' }], actorCardId: null },
      settings, ctx);
    await writeAudit(tx, {
      tenantId: PLATFORM_TENANT_ID, actorKind: 'system', action: 'platform:bootstrap', resourceType: 'card', resourceId: issued.card.id,
      decision: 'event', reasonCode: 'OPERATOR_BOOTSTRAPPED', requestId: ctx.requestId,
    });
    return {
      card_id: issued.card.id,
      card_number: formatCardNumber(issued.card.card_number),
      sc: issued.sc,
      enrollment_token: issued.enrollmentToken as string,
      enrollment_token_expires_at: (issued.enrollmentTokenExpiresAt as Date).toISOString(),
    };
  });
}

/**
 * Break-glass recovery of an OPERATOR card (a Company Owner of the platform tenant) that can no
 * longer sign in. Nobody can do this through the API: operators cannot recover each other, and
 * the operator tenant is never a target of the recovery endpoint. This runs from the command
 * line, so it needs what the API itself runs with (database access and the secret keys).
 * Same effect as an Owner recovery: old factors, sessions and SC are dead; a new SC and a
 * one-time enrollment token are returned once. Written to the platform audit chain.
 */
export async function recoverOperator(db: Database, cards: CardService, cardNumber: string, ctx: RequestContext): Promise<BootstrapResult> {
  const digits = normalizeCardNumber(cardNumber);
  if (digits === null) throw new Error('That is not a valid card number.');
  return db.withTenantTx(PLATFORM_TENANT_ID, async (tx) => {
    const found = await tx.query<CardRow>(
      `SELECT ${CARD_COLUMNS} FROM cards
        WHERE cards.tenant_id = $1 AND cards.card_number = $2 AND cards.kind = 'person'
          AND EXISTS (SELECT 1 FROM card_roles cr WHERE cr.tenant_id = cards.tenant_id AND cr.card_id = cards.id AND cr.role_key = 'company_owner')
        FOR UPDATE`,
      [PLATFORM_TENANT_ID, digits]);
    const card = found.rows[0];
    if (!card) throw new Error('No operator card with that number.');
    const settings = await getSettings(tx, PLATFORM_TENANT_ID);
    const recovered = await cards.recoverOwner(tx, card, null, 'cli-break-glass', settings, ctx);
    return {
      card_id: card.id,
      card_number: formatCardNumber(card.card_number),
      sc: recovered.sc,
      enrollment_token: recovered.enrollmentToken as string,
      enrollment_token_expires_at: (recovered.enrollmentTokenExpiresAt as Date).toISOString(),
    };
  });
}
