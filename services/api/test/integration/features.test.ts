// Card restrictions (feature 5), tenant settings and usage (feature 29), export (feature 30),
// the internal policy endpoint, pepper rotation end to end, and the operator bootstrap.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapOperator } from '../../src/modules/identity-access/index.ts';
import { PEPPER_V1, PEPPER_V2, testEnv } from '../helpers/env.ts';
import { addMember, Client, createTenant, login, startApp, superuser, tryLogin, type TestApp, type TestTenant } from '../helpers/harness.ts';

let t: TestApp;
let su: pg.Client;
let tenant: TestTenant;
beforeAll(async () => {
  t = await startApp();
  su = await superuser();
  tenant = await createTenant(t, 'features');
});
afterAll(async () => {
  await su.end();
  await t.close();
});

describe('card-level restrictions (feature 5)', () => {
  it('read-only card: can read, cannot write; the denial is in the usage history and the audit log', async () => {
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    expect((await admin.client.post('/v1/departments', { name: 'Before Restriction' })).status).toBe(201);
    const put = await tenant.owner.put(`/v1/cards/${admin.card.id}/restrictions`, { restrictions: [{ type: 'read_only', enabled: true, config: {} }] });
    expect(put.status).toBe(200);
    expect((await admin.client.get('/v1/cards')).status).toBe(200);
    expect((await admin.client.post('/v1/departments', { name: 'After Restriction' })).status).toBe(403);
    const ev = await su.query(`SELECT metadata FROM card_events WHERE card_id = $1 AND event_type = 'restriction_denied'`, [admin.card.id]);
    expect(ev.rows.map((r) => r.metadata)).toEqual([{ reason: 'DENY_CARD_READ_ONLY', action: 'department:create' }]);
    const audit = await su.query(`SELECT reason_code FROM audit_log WHERE actor_card_id = $1 AND decision = 'deny'`, [admin.card.id]);
    expect(audit.rows.map((r) => r.reason_code)).toEqual(['DENY_CARD_READ_ONLY']);
    // a restricted card cannot lift its own restriction
    expect((await admin.client.put(`/v1/cards/${admin.card.id}/restrictions`, { restrictions: [] })).status).toBe(403);
    // lifting it restores write access
    expect((await tenant.owner.put(`/v1/cards/${admin.card.id}/restrictions`, { restrictions: [] })).status).toBe(200);
    expect((await admin.client.post('/v1/departments', { name: 'After Lifting' })).status).toBe(201);
  });

  it('usage cap: the 4th request in the window is refused, counters are visible to admins, and the window resets', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, { restrictions: [{ type: 'usage_cap', enabled: true, config: { limit_key: 'requests', window_seconds: 3600, max_count: 3 } }] });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await m.client.get('/v1/roles')).status);
    expect(statuses).toEqual([200, 200, 200, 403, 403]);
    const shown = await tenant.owner.get(`/v1/cards/${m.card.id}/restrictions`);
    expect(shown.body.counters.map((c: any) => c.count)).toEqual([3]);
    expect((await m.client.request('POST', '/v1/auth/logout')).status).toBe(204); // restrictions never block signing out
    t.clock.advance(3_600_000);
    const again = await login(t, m.card, { passkey: m.passkey });
    expect((await again.get('/v1/roles')).status).toBe(200);
    t.clock.reset();
  });

  it('one site only: requests from outside the allowed network are refused', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, { restrictions: [{ type: 'network_allowlist', enabled: true, config: { cidrs: ['127.0.0.0/8'] } }] });
    expect((await m.client.get('/v1/roles')).status).toBe(200);
    m.client.ip = '203.0.113.50';
    expect((await m.client.get('/v1/roles')).status).toBe(403);
    m.client.ip = '127.0.0.1';
    expect((await m.client.get('/v1/roles')).status).toBe(200);
  });

  it('business hours only: refused outside the window', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }]);
    const hourUtc = t.clock.now().getUTCHours();
    const pad = (n: number): string => String(((n % 24) + 24) % 24).padStart(2, '0');
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    // a window that does NOT include the current hour
    await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, { restrictions: [{ type: 'time_window', enabled: true, config: { timezone: 'UTC', days: allDays, start: `${pad(hourUtc + 2)}:00`, end: `${pad(hourUtc + 3)}:00` } }] });
    expect((await m.client.get('/v1/roles')).status).toBe(403);
    // a window that includes it
    await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, { restrictions: [{ type: 'time_window', enabled: true, config: { timezone: 'UTC', days: allDays, start: `${pad(hourUtc)}:00`, end: `${pad(hourUtc + 1)}:00` } }] });
    expect((await m.client.get('/v1/roles')).status).toBe(200);
  });

  it('invalid restrictions are rejected (unknown time zone, malformed network range)', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    const tz = await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, { restrictions: [{ type: 'time_window', enabled: true, config: { timezone: 'Mars/Olympus', days: [1], start: '09:00', end: '17:00' } }] });
    expect(tz.status).toBe(422);
    const net = await tenant.owner.put(`/v1/cards/${m.card.id}/restrictions`, { restrictions: [{ type: 'network_allowlist', enabled: true, config: { cidrs: ['300.1.1.1/8'] } }] });
    expect(net.status).toBe(422);
    expect((await tenant.owner.get(`/v1/cards/${m.card.id}/restrictions`)).body.items).toEqual([]);
  });
});

describe('tenant settings and usage (feature 29)', () => {
  it('only the Owner can change settings; ranges are enforced; the Owner role cannot be disabled', async () => {
    const ten = await createTenant(t, 'settings');
    const admin = await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    expect((await admin.client.get('/v1/tenants/current/settings')).status).toBe(200);
    expect((await admin.client.patch('/v1/tenants/current/settings', { grace_days: 30 })).status).toBe(403);
    expect((await ten.owner.patch('/v1/tenants/current/settings', { card_validity_days: 30, grace_days: 7 })).status).toBe(200);
    for (const bad of [{ card_validity_days: 0 }, { card_validity_days: 367 }, { grace_days: 61 }, { session_idle_minutes: 1 }, { session_absolute_hours: 25 }, { enabled_roles: [] }, { enabled_roles: ['root'] }, { allowed_factor_types: ['sms'] }]) {
      expect((await ten.owner.patch('/v1/tenants/current/settings', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await ten.owner.patch('/v1/tenants/current/settings', { enabled_roles: ['admin', 'expert'] })).status).toBe(422);
    const s = (await ten.owner.get('/v1/tenants/current/settings')).body;
    expect(s).toMatchObject({ card_validity_days: 30, grace_days: 7, sc_lockout_threshold: 5 });
    // a card issued now follows the new validity
    const m = await addMember(t, ten.owner, [{ role_key: 'expert' }], { login: false });
    const card = (await ten.owner.get(`/v1/cards/${m.card.id}`)).body;
    const days = (new Date(card.expires_at).getTime() - new Date(card.issued_at).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
    expect((new Date(card.grace_until).getTime() - new Date(card.expires_at).getTime()) / 86_400_000).toBe(7);
  });

  it('a tenant can restrict factor types: with TOTP disabled, TOTP enrollment is refused', async () => {
    const ten = await createTenant(t, 'factors');
    await ten.owner.patch('/v1/tenants/current/settings', { allowed_factor_types: ['passkey'] });
    const p = await ten.owner.post('/v1/people', { display_name: 'No Totp' });
    const issued = await ten.owner.post('/v1/cards', { person_id: p.body.id, roles: [{ role_key: 'expert' }] });
    const res = await new Client(t).request('POST', '/v1/auth/enrollment/begin', {
      card_number: issued.body.card.card_number, sc: issued.body.sc, enrollment_token: issued.body.enrollment_token, factor_type: 'totp',
    });
    expect(res.status).toBe(401);
  });

  it('usage shows counts beside plan limits, and warns (by number) when fewer than two cards can unlock others', async () => {
    const ten = await createTenant(t, 'usage');
    const first = (await ten.owner.get('/v1/tenants/current/usage')).body;
    expect(first).toMatchObject({ cards_by_state: { active: 2 }, people: 1, cards_able_to_unlock: 1, plan: { plan_code: 'pilot', max_person_cards: null } });
    expect(first.active_sessions).toBeGreaterThanOrEqual(1);
    expect(first.logins_last_30_days).toBe(1);
    expect(first.audit_rows).toBeGreaterThan(5);
    await addMember(t, ten.owner, [{ role_key: 'admin' }]);
    const second = (await ten.owner.get('/v1/tenants/current/usage')).body;
    expect(second).toMatchObject({ cards_by_state: { active: 3 }, people: 2, cards_able_to_unlock: 2 });
  });
});

describe('export (feature 30)', () => {
  it('Owner only; open formats with a checksummed manifest; contains exactly this tenant\'s rows', async () => {
    const one = await createTenant(t, 'export-one');
    const two = await createTenant(t, 'export-two');
    const admin = await addMember(t, one.owner, [{ role_key: 'admin' }]);
    await addMember(t, two.owner, [{ role_key: 'expert' }]);
    expect((await admin.client.post('/v1/exports')).status).toBe(403);

    const res = await one.owner.post('/v1/exports');
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('done');
    const dir = path.resolve(testEnv().EXPORT_DIR as string, one.tenantId, res.body.id);
    expect(existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.tenant_id).toBe(one.tenantId);
    const byTable = Object.fromEntries(manifest.files.map((f: any) => [f.table, f]));
    expect(Object.keys(byTable).sort()).toEqual(['audit_log', 'card_events', 'card_restrictions', 'card_roles', 'cards', 'departments', 'people']);
    expect(byTable.cards.rows).toBe(3);
    expect(byTable.people.rows).toBe(2);

    const { createHash } = await import('node:crypto');
    for (const f of manifest.files) {
      const jsonl = readFileSync(path.join(dir, `${f.table}.jsonl`), 'utf8');
      const csv = readFileSync(path.join(dir, `${f.table}.csv`), 'utf8');
      expect(createHash('sha256').update(jsonl).digest('hex')).toBe(f.jsonl_sha256);
      expect(createHash('sha256').update(csv).digest('hex')).toBe(f.csv_sha256);
      expect(jsonl.split('\n').filter(Boolean)).toHaveLength(f.rows);
      expect(csv.trim().split('\n')).toHaveLength(f.rows + 1);
    }
    const cards = readFileSync(path.join(dir, 'cards.jsonl'), 'utf8');
    expect(cards).toContain(one.ownerCard.number.replace(/\D/g, ''));
    const everything = manifest.files.map((f: any) => readFileSync(path.join(dir, `${f.table}.jsonl`), 'utf8')).join('\n');
    expect(everything).not.toContain(two.ownerCard.id);
    expect(everything).not.toContain(two.ownerCard.number.replace(/\D/g, ''));
    expect(everything).not.toContain(two.tenantId);

    // the job record is the tenant's own
    expect((await one.owner.get(`/v1/exports/${res.body.id}`)).body.manifest.export_id).toBe(res.body.id);
    expect((await two.owner.get(`/v1/exports/${res.body.id}`)).status).toBe(404);
  });
});

describe('pepper rotation, end to end', () => {
  it('a card hashed under v1 still signs in after the pepper moves to v2, and its hash is upgraded on that login', async () => {
    const m = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    expect((await su.query(`SELECT pepper_id FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [m.card.id])).rows[0].pepper_id).toBe('v1');

    const rotated = await startApp({}, { SC_PEPPER_KEYRING: JSON.stringify({ current: 'v2', keys: { v1: PEPPER_V1, v2: PEPPER_V2 } }) });
    try {
      expect((await tryLogin(rotated, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(200);
      expect((await su.query(`SELECT pepper_id FROM card_secrets WHERE card_id = $1 AND status = 'current'`, [m.card.id])).rows[0].pepper_id).toBe('v2');
      expect((await tryLogin(rotated, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(200);
    } finally {
      await rotated.close();
    }

    // If the OLD pepper is removed before a card was upgraded, that card cannot sign in (fails closed) until renewed.
    const stale = await addMember(t, tenant.owner, [{ role_key: 'expert' }], { login: false });
    const v2only = await startApp({}, { SC_PEPPER_KEYRING: JSON.stringify({ current: 'v2', keys: { v2: PEPPER_V2 } }) });
    try {
      expect((await tryLogin(v2only, stale.card.number, stale.card.sc, { passkey: stale.passkey })).res.status).toBe(401);
      expect((await tryLogin(v2only, m.card.number, m.card.sc, { passkey: m.passkey })).res.status).toBe(200); // upgraded card is fine
    } finally {
      await v2only.close();
    }
  });
});

describe('operator bootstrap', () => {
  it('creates the first operator card once, and refuses to run a second time', async () => {
    const ctx = { requestId: 'bootstrap-test', ip: '127.0.0.1', userAgent: 'test', now: new Date() };
    const outcomes = [];
    for (let i = 0; i < 2; i += 1) {
      try {
        const b = await bootstrapOperator(t.app.db, t.app.identity.cards, ctx);
        expect(b.card_number).toMatch(/^LGY-\d{4}-\d{4}-\d{4}-\d{4}$/);
        expect(b.sc).toMatch(/^\d{3}$/);
        outcomes.push('created');
      } catch (e) {
        expect((e as Error).message).toMatch(/already has an operator card/);
        outcomes.push('refused');
      }
    }
    // Whichever test file ran first may already have made an operator; either way the SECOND call must be refused.
    expect(outcomes[1]).toBe('refused');
  });
});
