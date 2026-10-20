// Who receives a notice by e-mail - answered here because the identity module owns cards, roles and people. The
// mail module asks through its RecipientDirectory port (app.ts connects the two); it never reads these tables.
// Only people who have not left are answered. Addresses are read when a message is sent, never copied.
import type { Tx } from '../../platform/index.ts';

export const recipientDirectory = {
  /** The person holding the card - whatever the card's state (a revoked card's holder is told it was revoked). */
  async holderOf(tx: Tx, tenantId: string, cardId: string): Promise<string | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT p.id FROM cards c JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
        WHERE c.tenant_id = $1 AND c.id = $2 AND c.kind = 'person' AND p.status = 'active'`, [tenantId, cardId]);
    return rows[0]?.id ?? null;
  },
  /** The people holding an Owner card that can act (issued or active; not suspended, revoked, expired or replaced). */
  async owners(tx: Tx, tenantId: string): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT DISTINCT p.id FROM cards c
         JOIN card_roles cr ON cr.tenant_id = c.tenant_id AND cr.card_id = c.id AND cr.role_key = 'company_owner'
         JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
        WHERE c.tenant_id = $1 AND c.state IN ('issued', 'active') AND p.status = 'active'
        ORDER BY p.id`, [tenantId]);
    return rows.map((r) => r.id);
  },
  async addressOf(tx: Tx, tenantId: string, personId: string): Promise<string | null> {
    const { rows } = await tx.query<{ email: string | null }>(
      `SELECT email FROM people WHERE tenant_id = $1 AND id = $2 AND status = 'active'`, [tenantId, personId]);
    return rows[0]?.email ?? null;
  },
};
