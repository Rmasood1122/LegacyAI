// Records expiry for cards whose expires_at has passed (state -> expired, usage-history
// event, audit row). ENFORCEMENT NEVER DEPENDS ON THIS JOB: the API treats a card as expired
// the moment the clock passes expires_at. This only writes it down, and sends renewal notices.
//
//   npm run cards:sweep-expired
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../app.ts';
import type { CardRow } from '../modules/identity-access/internal/cards.ts';
import { listTenants, loadConfig, PLATFORM_TENANT_ID } from '../modules/platform/index.ts';

export async function sweepExpiredCards(app: App, now: Date): Promise<number> {
  const ctx = { requestId: `sweep-${now.toISOString()}`, ip: '', userAgent: '', now };
  const tenants = await app.db.withTenantTx(PLATFORM_TENANT_ID, (tx) => listTenants(tx, 10_000, null), { platformScope: true });
  let swept = 0;
  for (const tenant of tenants) {
    swept += await app.db.withTenantTx(tenant.id, async (tx) => {
      const { rows } = await tx.query<CardRow>(
        `SELECT id, tenant_id, kind, person_id, card_number, state, issued_at, activated_at, expires_at, grace_until, renewal_due,
                renewal_count, replaced_by_card_id, replaces_card_id
           FROM cards WHERE state IN ('active', 'issued') AND expires_at <= $1 FOR UPDATE`, [now]);
      for (const card of rows) await app.identity.cards.materializeExpiry(tx, card, ctx);
      return rows.length;
    });
  }
  return swept;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await createApp(loadConfig(process.env));
  try {
    const n = await sweepExpiredCards(app, new Date());
    console.log(JSON.stringify({ swept: n }));
  } finally {
    await app.close();
  }
}
