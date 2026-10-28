// Regional hosting (feature 21, decision D43): each region is its own copy of LegacyAI with its own database, and a
// copy serves only companies kept in its region. Proven here against the real database and the real HTTP stack:
// a copy writes its own region on every company it creates; it refuses to start on a database that holds a company
// of another region; and a company of another region gets nothing - no request, no sign-in - while the operator's
// own company, which every copy has, keeps working. Synthetic companies only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, platformOperator, startApp, superuser, tryLogin, type TestApp } from '../helpers/harness.ts';

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
});
