// An API key does not survive a change of its maker's sign-in or rights (decision D30).
//
// Whenever a card's sessions are ended because its secret code was rotated, its sign-in factors were reset, its
// roles changed, or the card was replaced, revoked, suspended or locked, every key that card made is REVOKED in the
// same transaction - for good (the database refuses to undo it). The one function that ends a card's sessions
// (revokeSessionsForCard in sessions.ts) calls this, so no path can end the sessions and forget the keys.
//
// This file knows nothing about sessions.ts or api-keys.ts: both may import it.
import { writeAudit, type Tx } from '../../platform/index.ts';

export type KeyRevocationReason =
  | 'maker_code_rotated' | 'maker_credentials_reset' | 'maker_privilege_change' | 'maker_card_replaced'
  | 'maker_card_revoked' | 'maker_card_suspended' | 'maker_card_locked';

/**
 * Which endings of a card's sessions also end its keys. Pure. Not among them: signing out (the holder's own choice,
 * nothing about the card changed) and expiry (the card's state already decides on every request: read-only during
 * the grace window, nothing after it - and a renewal rotates the secret code, which is in the list).
 */
const BY_SESSION_REASON: Readonly<Record<string, KeyRevocationReason>> = {
  sc_rotated: 'maker_code_rotated',
  credentials_reset: 'maker_credentials_reset',
  privilege_change: 'maker_privilege_change',
  card_replaced: 'maker_card_replaced',
  card_revoked: 'maker_card_revoked',
  card_suspended: 'maker_card_suspended',
  card_locked: 'maker_card_locked',
};

export function keyRevocationReason(sessionReason: string): KeyRevocationReason | null {
  return Object.hasOwn(BY_SESSION_REASON, sessionReason) ? (BY_SESSION_REASON[sessionReason] as KeyRevocationReason) : null;
}

/**
 * Revokes every key the card made that is not revoked yet, and writes one audit row per key (the system is the
 * actor; the row names the key and the card). Returns the ids of the keys revoked by this call.
 */
export async function revokeKeysOfCard(tx: Tx, tenantId: string, cardId: string, reason: KeyRevocationReason, now: Date): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE api_keys SET revoked_at = $3, revoked_reason = $4
      WHERE tenant_id = $1 AND created_by_card_id = $2 AND revoked_at IS NULL RETURNING id`,
    [tenantId, cardId, now, reason]);
  for (const { id } of rows) {
    await writeAudit(tx, {
      tenantId, actorKind: 'system', action: 'api_key:manage', resourceType: 'api_key', resourceId: id, decision: 'event',
      reasonCode: 'API_KEY_REVOKED_MAKER_CHANGED', details: { api_key_id: id, target_card_id: cardId, reason },
    });
  }
  return rows.map((r) => r.id);
}
