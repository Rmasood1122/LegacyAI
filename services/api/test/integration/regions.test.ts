// Regional hosting (feature 21, decision D43): each region is its own copy of LegacyAI with its own database, and a
// copy serves only companies kept in its region. Proven here against the real database and the real HTTP stack:
// a copy writes its own region on every company it creates; it refuses to start on a database that holds a company
// of another region; and a company of another region gets nothing - no request, no sign-in - while the operator's
// own company, which every copy has, keeps working. Synthetic companies only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signEvent } from '../../src/modules/billing/index.ts';
import { testEnv } from '../helpers/env.ts';
import {
  Client, createTenant, enrollPasskey, issueMember, platformOperator, startApp, superuser, tryLogin, VirtualPasskey, type TestApp,
} from '../helpers/harness.ts';

let t: TestApp;
let admin: pg.Client;
beforeAll(async () => {
  t = await startApp();
  admin = await superuser();
});
afterAll(async () => {
  await admin.query("UPDATE tenants SET region = 'us' WHERE NOT is_platform"); // every later test file starts a "us" copy
  await admin.end();
  await t.close();
});

const regionOf = async (tenantId: string): Promise<string> =>
  ((await admin.query<{ region: string }>('SELECT region FROM tenants WHERE id = $1', [tenantId])).rows[0] as { region: string }).region;
const reasons = async (tenantId: string): Promise<string[]> =>
  (await admin.query<{ reason_code: string }>('SELECT reason_code FROM audit_log WHERE tenant_id = $1 ORDER BY seq', [tenantId])).rows.map((r) => r.reason_code);
const moveTo = (tenantId: string, region: string): Promise<unknown> => admin.query('UPDATE tenants SET region = $2 WHERE id = $1', [tenantId, region]);
const lastReason = async (tenantId: string): Promise<string | null> =>
  ((await admin.query<{ reason_code: string }>('SELECT reason_code FROM audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1', [tenantId])).rows[0]?.reason_code) ?? null;

describe('regional hosting: a copy serves its own region only', () => {
  it('a "us" copy keeps the companies it creates in "us"', async () => {
    const company = await createTenant(t, 'region-us');
    expect(await regionOf(company.tenantId)).toBe('us');
    expect((await company.owner.get('/v1/tenants/current')).body.region).toBe('us');
  });

  it('an "eu" copy refuses to start on a database that holds "us" companies', async () => {
    const others = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM tenants WHERE NOT is_platform AND region = 'us'")).rows[0]?.n ?? 0;
    expect(others).toBeGreaterThan(0);
    await expect(startApp({}, { HOSTING_REGION: 'eu' })).rejects.toThrow(`this database holds ${others} company(ies) kept in another region than this copy's (eu)`);
  });

  it('a company of another region gets nothing here: no request, no sign-in; the operator\'s company still works', async () => {
    const company = await createTenant(t, 'region-moved');
    expect((await company.owner.get('/v1/tenants/current')).status).toBe(200);
    // as if a backup of the eu copy had been restored here, or the row had been changed by hand
    await admin.query("UPDATE tenants SET region = 'eu' WHERE id = $1", [company.tenantId]);
    try {
      const refused = await company.owner.get('/v1/tenants/current');
      expect(refused.status).toBe(403);
      expect(await lastReason(company.tenantId)).toBe('DENY_TENANT_OTHER_REGION');
      const signIn = await tryLogin(t, company.ownerCard.number, company.ownerCard.sc, { passkey: company.ownerPasskey });
      expect(signIn.res.status).not.toBe(200);
      // the operator's own company is in every copy and is never refused for its region
      const operator = await platformOperator(t);
      expect((await operator.get('/v1/tenants?limit=5')).status).toBe(200);
      // and a "us" copy started now refuses this database
      await expect(startApp()).rejects.toThrow("this database holds 1 company(ies) kept in another region than this copy's (us)");
    } finally {
      await admin.query("UPDATE tenants SET region = 'us' WHERE id = $1", [company.tenantId]);
    }
    expect((await company.owner.get('/v1/tenants/current')).status).toBe(200);
  });

  it('an "eu" copy keeps the companies it creates in "eu"', async () => {
    // Only possible on a database holding no "us" company: mark them all "eu" for this test, then back.
    const moved = (await admin.query<{ id: string }>("UPDATE tenants SET region = 'eu' WHERE NOT is_platform AND region = 'us' RETURNING id")).rows;
    expect(moved.length).toBeGreaterThan(0);
    let eu: TestApp | null = null;
    try {
      eu = await startApp({}, { HOSTING_REGION: 'eu' });
      const company = await createTenant(eu, 'region-eu');
      expect(await regionOf(company.tenantId)).toBe('eu');
      expect((await company.owner.get('/v1/tenants/current')).body.region).toBe('eu');
      // the running "us" copy refuses the eu company's Owner
      const inUs = await tryLogin(t, company.ownerCard.number, company.ownerCard.sc, { passkey: company.ownerPasskey });
      expect(inUs.res.status).not.toBe(200);
    } finally {
      await eu?.close();
      await admin.query("UPDATE tenants SET region = 'us' WHERE NOT is_platform");
    }
  });

  it('sign-in records why it was refused: the company is kept in another region', async () => {
    const company = await createTenant(t, 'region-login');
    await moveTo(company.tenantId, 'eu');
    try {
      const signIn = await tryLogin(t, company.ownerCard.number, company.ownerCard.sc, { passkey: company.ownerPasskey });
      expect(signIn.res.status).toBe(401);
      expect(await lastReason(company.tenantId)).toBe('LOGIN_OTHER_REGION');
    } finally {
      await moveTo(company.tenantId, 'us');
    }
  });

  it('a new card of another region\'s company cannot set up a sign-in method here, with any valid one-time code', async () => {
    const company = await createTenant(t, 'region-enrol');
    const fresh = await issueMember(company.owner, [{ role_key: 'expert' }]);
    await moveTo(company.tenantId, 'eu');
    try {
      await expect(enrollPasskey(t, fresh.card)).rejects.toThrow('enrollment begin failed: 401');
      expect(await reasons(company.tenantId)).toContain('ENROLL_OTHER_REGION');
    } finally {
      await moveTo(company.tenantId, 'us');
    }
    // the same card and code work once the company is this copy's again: nothing was used up
    await expect(enrollPasskey(t, fresh.card)).resolves.toBeInstanceOf(VirtualPasskey);
  });

  it('a set-up begun here is not finished once the company is kept in another region', async () => {
    const company = await createTenant(t, 'region-enrol2');
    const fresh = await issueMember(company.owner, [{ role_key: 'expert' }]);
    const c = new Client(t);
    const begin = await c.request('POST', '/v1/auth/enrollment/begin', {
      card_number: fresh.card.number, sc: fresh.card.sc, enrollment_token: fresh.card.enrollmentToken, factor_type: 'passkey', label: 'test device',
    });
    expect(begin.status).toBe(200);
    await moveTo(company.tenantId, 'eu');
    try {
      const done = await c.request('POST', '/v1/auth/enrollment/complete', {
        enrollment_txn: begin.body.enrollment_txn, attestation: new VirtualPasskey().attest(begin.body.webauthn_options),
      });
      expect(done.status).toBe(401);
      expect((await admin.query('SELECT count(*)::int AS n FROM credentials WHERE card_id = $1', [fresh.card.id])).rows[0].n).toBe(0);
    } finally {
      await moveTo(company.tenantId, 'us');
    }
  });

  it('a payment message about a company this copy does not serve is answered "ignored" and nothing is recorded', async () => {
    const key = Buffer.from(testEnv().PAYMENT_EVENT_KEY as string, 'base64');
    const message = (tenantId: string): Record<string, unknown> => {
      const fields = {
        version: 'v1', event_id: `evt_${randomUUID()}`, tenant_id: tenantId, invoice_id: randomUUID(), outcome: 'paid', amount_minor: 100, currency: 'USD',
        sent_at: t.clock.now().toISOString(),
      };
      return { ...fields, signature: signEvent(key, fields) };
    };
    const send = (e: unknown) => new Client(t).request('POST', '/v1/billing/provider-events', e, { origin: null });
    const recorded = async (tenantId: string): Promise<number> =>
      (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM payment_events WHERE tenant_id = $1', [tenantId])).rows[0]?.n ?? 0;
    const company = await createTenant(t, 'region-pay');
    // served here: the message is recorded (an invoice it does not know needs a person's attention)
    const here = await send(message(company.tenantId));
    expect(here.status).toBe(200);
    expect(here.body.status).not.toBe('ignored');
    expect(await recorded(company.tenantId)).toBe(1);
    await moveTo(company.tenantId, 'eu');
    try {
      const elsewhere = await send(message(company.tenantId));
      expect(elsewhere.status).toBe(200);
      expect(elsewhere.body).toEqual({ status: 'ignored' });
      expect(await recorded(company.tenantId)).toBe(1);
    } finally {
      await moveTo(company.tenantId, 'us');
    }
    // a company that is not in this database at all is still written to the operator's log, as before (billing tests)
  });
});
