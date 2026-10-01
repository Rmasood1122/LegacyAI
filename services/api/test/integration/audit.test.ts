// The audit log is append-only and hash-chained. These tests prove what is claimed -
// TAMPER-EVIDENT - and are honest about what is not (a superuser CAN change rows; we detect it).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeRowHash, recordAnchor, verifyAgainstExternalAnchors, verifyChain, writeAudit, type AuditRow } from '../../src/modules/platform/index.ts';
import { DB_URLS } from '../helpers/env.ts';
import { addMember, appRoleClient, createTenant, startApp, superuser, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
beforeAll(async () => {
  t = await startApp();
  su = await superuser();
});
afterAll(async () => {
  await su.end();
  await t.close();
});

const verify = (tenantId: string) => t.app.db.withTenantTx(tenantId, (tx) => verifyChain(tx, tenantId));

async function write(tenantId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await t.app.db.withTenantTx(tenantId, (tx) => writeAudit(tx, {
      tenantId, actorKind: 'system', action: 'test:event', decision: 'event', reasonCode: 'TEST', details: { count: i },
    }));
  }
}

/** What a database superuser can do: switch the protections off, change things, switch them back on. */
async function asSuperuserWithoutTriggers(fn: () => Promise<void>): Promise<void> {
  await su.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only');
  try {
    await fn();
  } finally {
    await su.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only');
  }
}

const COLS = `tenant_id, seq::text AS seq, occurred_at, (extract(epoch FROM occurred_at) * 1000000)::bigint::text AS occurred_us,
  actor_card_id, actor_kind, action, resource_type, resource_id, decision, reason_code, request_id, ip, details, prev_hash, row_hash`;

describe('append-only enforcement', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'audit-ao');
  });

  it('the app role cannot UPDATE, DELETE or TRUNCATE (blocked by grants)', async () => {
    const app = await appRoleClient();
    try {
      for (const sql of [
        `UPDATE audit_log SET reason_code = 'EDITED'`,
        'DELETE FROM audit_log',
        'TRUNCATE audit_log',
      ]) {
        await app.query('BEGIN');
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
        await expect(app.query(sql), sql).rejects.toMatchObject({ code: '42501' });
        await app.query('ROLLBACK');
      }
    } finally {
      await app.end();
    }
  });

  it('even the table owner cannot UPDATE, DELETE or TRUNCATE (blocked by trigger)', async () => {
    const owner = new pg.Client({ connectionString: DB_URLS.admin });
    await owner.connect();
    try {
      for (const sql of [
        `UPDATE audit_log SET reason_code = 'EDITED' WHERE tenant_id = '${tenant.tenantId}'`,
        `DELETE FROM audit_log WHERE tenant_id = '${tenant.tenantId}'`,
        'TRUNCATE audit_log',
      ]) {
        await owner.query('BEGIN');
        await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
        await expect(owner.query(sql), sql).rejects.toThrow(/append-only/);
        await owner.query('ROLLBACK');
      }
    } finally {
      await owner.end();
    }
  });

  it('a superuser is stopped by the trigger too, unless they deliberately disable it', async () => {
    await expect(su.query(`UPDATE audit_log SET reason_code = 'EDITED' WHERE tenant_id = $1`, [tenant.tenantId])).rejects.toThrow(/append-only/);
    await expect(su.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenant.tenantId])).rejects.toThrow(/append-only/);
  });

  it('the app cannot choose its own sequence number or hashes', async () => {
    const app = await appRoleClient();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
      const { rows } = await app.query(
        `INSERT INTO audit_log (tenant_id, seq, occurred_at, actor_kind, action, decision, reason_code, prev_hash, row_hash)
         VALUES ($1, 999999, '2001-01-01', 'system', 'x:y', 'event', 'FORGED', '\\xdeadbeef', '\\xdeadbeef')
         RETURNING seq::int AS seq, occurred_at, length(row_hash) AS hash_len, row_hash`, [tenant.tenantId]);
      expect(rows[0].seq).not.toBe(999999);
      expect(rows[0].hash_len).toBe(32);
      expect(rows[0].occurred_at.getFullYear()).toBeGreaterThan(2020);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});

describe('hash chain', () => {
  it('verifies an untouched chain and counts every row', async () => {
    const tenant = await createTenant(t, 'audit-ok');
    await write(tenant.tenantId, 25);
    const r = await verify(tenant.tenantId);
    expect(r.ok).toBe(true);
    expect(r.first_broken_seq).toBeNull();
    expect(r.rows_checked).toBe(r.head_seq);
    expect(r.rows_checked).toBeGreaterThanOrEqual(25);
  });

  it('the TypeScript verifier and the database trigger compute identical hashes', async () => {
    const tenant = await createTenant(t, 'audit-eq');
    await t.app.db.withTenantTx(tenant.tenantId, (tx) => writeAudit(tx, {
      tenantId: tenant.tenantId, actorCardId: tenant.ownerCard.id, actorKind: 'card', action: 'test:unicode', resourceType: 'thing',
      resourceId: 'id-1', decision: 'allow', reasonCode: 'ALLOW', requestId: 'req-1', ip: '2001:db8::1', details: { reason: 'naïve — ünïcödé ✓' },
    }));
    const { rows } = await su.query<AuditRow>(`SELECT ${COLS} FROM audit_log WHERE tenant_id = $1 ORDER BY audit_log.seq`, [tenant.tenantId]);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(computeRowHash(row).equals(row.row_hash), `seq ${row.seq}`).toBe(true);
  });

  it('200 concurrent writes produce one gap-free, unforked chain', async () => {
    const tenant = await createTenant(t, 'audit-conc');
    const before = (await verify(tenant.tenantId)).head_seq;
    await Promise.all(Array.from({ length: 200 }, (_, i) =>
      t.app.db.withTenantTx(tenant.tenantId, (tx) => writeAudit(tx, {
        tenantId: tenant.tenantId, actorKind: 'system', action: 'test:concurrent', decision: 'event', reasonCode: 'TEST', details: { count: i },
      }))));
    const r = await verify(tenant.tenantId);
    expect(r.ok).toBe(true);
    expect(r.head_seq).toBe(before + 200);
    const seqs = await su.query('SELECT count(*)::int AS n, count(DISTINCT seq)::int AS d, max(seq)::int AS m FROM audit_log WHERE tenant_id = $1', [tenant.tenantId]);
    expect(seqs.rows[0]).toEqual({ n: before + 200, d: before + 200, m: before + 200 });
  });

  it('TAMPER DETECTION: a superuser edits one row -> the verifier names exactly that row', async () => {
    const tenant = await createTenant(t, 'audit-tamper');
    await write(tenant.tenantId, 20);
    expect((await verify(tenant.tenantId)).ok).toBe(true);
    const target = 9;
    await asSuperuserWithoutTriggers(async () => {
      await su.query(`UPDATE audit_log SET reason_code = 'QUIETLY_CHANGED' WHERE tenant_id = $1 AND seq = $2`, [tenant.tenantId, target]);
    });
    const r = await verify(tenant.tenantId);
    expect(r.ok).toBe(false);
    expect(r.first_broken_seq).toBe(target);
    expect(r.broken_reason).toBe('row_hash_mismatch');
  });

  it.each([
    ['actor', `actor_kind = 'card'`],
    ['decision', `decision = 'allow'`],
    ['timestamp', `occurred_at = occurred_at - interval '1 day'`],
    ['details', `details = '{"count":999}'`],
    ['ip', `ip = '198.51.100.7'`],
    ['resource', `resource_id = 'someone-else'`],
  ])('TAMPER DETECTION: changing the %s of a row is detected', async (_what, setClause) => {
    const tenant = await createTenant(t, 'audit-field');
    await write(tenant.tenantId, 6);
    const head = (await verify(tenant.tenantId)).head_seq;
    await asSuperuserWithoutTriggers(async () => {
      await su.query(`UPDATE audit_log SET ${setClause} WHERE tenant_id = $1 AND seq = $2`, [tenant.tenantId, head - 2]);
    });
    const r = await verify(tenant.tenantId);
    expect(r).toMatchObject({ ok: false, first_broken_seq: head - 2, broken_reason: 'row_hash_mismatch' });
  });

  it('TAMPER DETECTION: editing a row AND fixing its own hash breaks the link from the next row', async () => {
    const tenant = await createTenant(t, 'audit-relink');
    await write(tenant.tenantId, 10);
    const target = 5;
    await asSuperuserWithoutTriggers(async () => {
      await su.query(`UPDATE audit_log SET reason_code = 'CHANGED' WHERE tenant_id = $1 AND seq = $2`, [tenant.tenantId, target]);
      const { rows } = await su.query<AuditRow>(`SELECT ${COLS} FROM audit_log WHERE tenant_id = $1 AND seq = $2`, [tenant.tenantId, target]);
      await su.query('UPDATE audit_log SET row_hash = $3 WHERE tenant_id = $1 AND seq = $2', [tenant.tenantId, target, computeRowHash(rows[0] as AuditRow)]);
    });
    const r = await verify(tenant.tenantId);
    expect(r).toMatchObject({ ok: false, first_broken_seq: target + 1, broken_reason: 'prev_hash_mismatch' });
  });

  it('TAMPER DETECTION: deleting a row in the middle is detected as a gap', async () => {
    const tenant = await createTenant(t, 'audit-gap');
    await write(tenant.tenantId, 10);
    await asSuperuserWithoutTriggers(async () => {
      await su.query('DELETE FROM audit_log WHERE tenant_id = $1 AND seq = 4', [tenant.tenantId]);
    });
    const r = await verify(tenant.tenantId);
    expect(r).toMatchObject({ ok: false, first_broken_seq: 4, broken_reason: 'sequence_gap' });
  });

  it('TAMPER DETECTION: deleting the newest rows is detected against the chain head', async () => {
    const tenant = await createTenant(t, 'audit-tail');
    await write(tenant.tenantId, 10);
    const head = (await verify(tenant.tenantId)).head_seq;
    await asSuperuserWithoutTriggers(async () => {
      await su.query('DELETE FROM audit_log WHERE tenant_id = $1 AND seq > $2', [tenant.tenantId, head - 3]);
    });
    const r = await verify(tenant.tenantId);
    expect(r).toMatchObject({ ok: false, first_broken_seq: head - 2, broken_reason: 'head_seq_mismatch' });
  });

  it('chains are independent per tenant: tampering with one does not affect another', async () => {
    const one = await createTenant(t, 'audit-ind1');
    const two = await createTenant(t, 'audit-ind2');
    await write(one.tenantId, 5);
    await write(two.tenantId, 5);
    await asSuperuserWithoutTriggers(async () => {
      await su.query(`UPDATE audit_log SET reason_code = 'X' WHERE tenant_id = $1 AND seq = 2`, [one.tenantId]);
    });
    expect((await verify(one.tenantId)).ok).toBe(false);
    expect((await verify(two.tenantId)).ok).toBe(true);
  });

  it('HONEST LIMIT + ANCHOR: a superuser who rewrites the WHOLE chain consistently passes the chain check, and is caught only by the external anchor', async () => {
    const tenant = await createTenant(t, 'audit-anchor');
    await write(tenant.tenantId, 12);
    // The chain head is copied outside the database (here: kept in memory, as the bucket would keep it).
    const anchored = await t.app.db.withTenantTx(tenant.tenantId, (tx) => recordAnchor(tx, tenant.tenantId, 'gs://example-anchor-bucket/test.json'));
    expect(anchored).not.toBeNull();
    const external = [{ tenant_id: tenant.tenantId, seq: anchored!.seq, row_hash: anchored!.row_hash }];
    await write(tenant.tenantId, 3);

    // Full rewrite: change an old row, then recompute every hash after it, the head and the in-database anchor record.
    await asSuperuserWithoutTriggers(async () => {
      await su.query(`UPDATE audit_log SET reason_code = 'HISTORY_REWRITTEN' WHERE tenant_id = $1 AND seq = 3`, [tenant.tenantId]);
      const { rows } = await su.query<AuditRow>(`SELECT ${COLS} FROM audit_log WHERE tenant_id = $1 ORDER BY audit_log.seq`, [tenant.tenantId]);
      let prev: Buffer = Buffer.alloc(32);
      for (const row of rows) {
        row.prev_hash = prev;
        const h = computeRowHash(row);
        await su.query('UPDATE audit_log SET prev_hash = $3, row_hash = $4 WHERE tenant_id = $1 AND seq = $2', [tenant.tenantId, row.seq, prev, h]);
        prev = h;
      }
      await su.query('UPDATE audit_chain_heads SET last_hash = $2 WHERE tenant_id = $1', [tenant.tenantId, prev]);
      await su.query(
        `UPDATE audit_anchors SET row_hash = (SELECT row_hash FROM audit_log l WHERE l.tenant_id = audit_anchors.tenant_id AND l.seq = audit_anchors.seq)
          WHERE tenant_id = $1`, [tenant.tenantId]);
    });

    // The chain on its own cannot see this - which is exactly why it is "tamper-evident", not "tamper-proof".
    expect((await verify(tenant.tenantId)).ok).toBe(true);
    // The copy held outside the database does.
    const check = await t.app.db.withTenantTx(tenant.tenantId, (tx) => verifyAgainstExternalAnchors(tx, tenant.tenantId, external));
    expect(check).toEqual({ ok: false, mismatched_seq: anchored!.seq });
  });

  it('an in-database anchor that no longer matches is reported by the normal verifier', async () => {
    const tenant = await createTenant(t, 'audit-anchor2');
    await write(tenant.tenantId, 5);
    const anchored = await t.app.db.withTenantTx(tenant.tenantId, (tx) => recordAnchor(tx, tenant.tenantId, 'gs://example-anchor-bucket/a.json'));
    expect((await verify(tenant.tenantId)).last_anchor).toMatchObject({ seq: anchored!.seq, matches: true });
    await asSuperuserWithoutTriggers(async () => {
      await su.query(`UPDATE audit_log SET row_hash = '\\x00' WHERE tenant_id = $1 AND seq = $2`, [tenant.tenantId, anchored!.seq]);
    });
    const r = await verify(tenant.tenantId);
    expect(r.ok).toBe(false);
    expect(r.last_anchor).toMatchObject({ matches: false });
  });
});

describe('what gets written', () => {
  let tenant: TestTenant;
  beforeAll(async () => {
    tenant = await createTenant(t, 'audit-api');
  });

  it('every request writes exactly one decision row: allow', async () => {
    const before = (await verify(tenant.tenantId)).head_seq;
    const res = await tenant.owner.get('/v1/cards');
    expect(res.status).toBe(200);
    const { rows } = await su.query(
      'SELECT actor_card_id, action, decision, reason_code, request_id, ip FROM audit_log WHERE tenant_id = $1 AND seq > $2 ORDER BY seq', [tenant.tenantId, before]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_card_id: tenant.ownerCard.id, action: 'card:list', decision: 'allow', reason_code: 'ALLOW', ip: '127.0.0.1' });
    expect(rows[0].request_id).toBe(res.headers['x-request-id']);
  });

  it('...and deny, with the internal reason kept out of the response', async () => {
    const member = await addMember(t, tenant.owner, [{ role_key: 'successor' }]);
    const before = (await verify(tenant.tenantId)).head_seq;
    const res = await member.client.post('/v1/people', { display_name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.raw).not.toContain('DENY_');
    const { rows } = await su.query(
      'SELECT actor_card_id, action, decision, reason_code FROM audit_log WHERE tenant_id = $1 AND seq > $2 ORDER BY seq', [tenant.tenantId, before]);
    expect(rows).toEqual([{ actor_card_id: member.card.id, action: 'person:create', decision: 'deny', reason_code: 'DENY_DEFAULT' }]);
    expect((await su.query(`SELECT 1 FROM people WHERE display_name = 'Nope'`)).rowCount).toBe(0);
  });

  it('an allowed request that then fails still leaves an audit row', async () => {
    const before = (await verify(tenant.tenantId)).head_seq;
    const res = await tenant.owner.post(`/v1/cards/${tenant.companyCard.id}/reinstate`); // company card is active: illegal transition
    expect(res.status).toBe(409);
    const { rows } = await su.query('SELECT action, decision, details FROM audit_log WHERE tenant_id = $1 AND seq > $2 ORDER BY seq', [tenant.tenantId, before]);
    expect(rows).toEqual([{ action: 'card:reinstate', decision: 'allow', details: '{"outcome":"failed","status":409}' }]);
  });

  it('the API exposes the log and the verifier to Owner and Admin only', async () => {
    const list = await tenant.owner.get('/v1/audit/events?limit=5');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(5);
    expect(list.body.next_cursor).toBeTruthy();
    const page2 = await tenant.owner.get(`/v1/audit/events?limit=5&cursor=${list.body.next_cursor}`);
    expect(page2.body.items[0].seq).toBe(list.body.items[4].seq - 1);
    const denied = await tenant.owner.get('/v1/audit/events?decision=deny');
    expect(denied.body.items.every((e: any) => e.decision === 'deny')).toBe(true);

    const v = await tenant.owner.request('POST', '/v1/audit/verify', {});
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(true);

    const expert = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    expect((await expert.client.get('/v1/audit/events')).status).toBe(403);
    expect((await expert.client.request('POST', '/v1/audit/verify', {})).status).toBe(403);
  });

  it('the chain is still intact after everything the API tests did to this tenant', async () => {
    expect((await verify(tenant.tenantId)).ok).toBe(true);
  });
});
