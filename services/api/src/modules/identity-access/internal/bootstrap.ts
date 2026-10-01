// One-time creation of the first LegacyAI operator card in the platform tenant.
// After this, operators sign in like everyone else (card + SC + strong factor).
import type { RequestContext } from '../../../shared/policy-types.ts';
import { getSettings, PLATFORM_TENANT_ID, writeAudit, type Database } from '../../platform/index.ts';
import { formatCardNumber } from './card-number.ts';
import type { CardService } from './cards.ts';

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
