// End-to-end happy path: operator -> tenant -> owner enrols a passkey -> logs in -> issues a
// card -> that cardholder enrols an authenticator app and logs in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, Client, createTenant, enrollTotp, fromSecrets, login, startApp, type TestApp } from '../helpers/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => t.close());

describe('happy path', () => {
  it('health is public and does not need a database', async () => {
    const res = await new Client(t).get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: '0.1.0' });
  });

  it('readiness reports the database and migrations', async () => {
    const res = await new Client(t).get('/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: true, migrations: true, config: true });
  });

  it('creates a tenant, logs the owner in with a passkey, and issues a card that logs in with TOTP', async () => {
    const tenant = await createTenant(t, 'smoke');

    const session = await tenant.owner.get('/v1/auth/session');
    expect(session.status).toBe(200);
    expect(session.body.roles).toEqual(['company_owner']);
    expect(session.body.read_only).toBe(false);
    expect(session.body.card_number_masked).toMatch(/^LGY-\*{4}-\*{4}-\*{4}-\d{4}$/);

    // The card number format: LGY- prefix, 16 digits.
    expect(tenant.ownerCard.number).toMatch(/^LGY-\d{4}-\d{4}-\d{4}-\d{4}$/);
    expect(tenant.ownerCard.sc).toMatch(/^\d{3}$/);

    // Company card: active immediately, linked to no person.
    const company = await tenant.owner.get(`/v1/cards/${tenant.companyCard.id}`);
    expect(company.body.kind).toBe('company');
    expect(company.body.state).toBe('active');
    expect(company.body.person_id).toBeNull();

    // Issue an Expert card; the cardholder enrols an authenticator app.
    const person = await tenant.owner.post('/v1/people', { display_name: 'Test Expert' });
    const issued = await tenant.owner.post('/v1/cards', { person_id: person.body.id, roles: [{ role_key: 'expert' }] });
    expect(issued.status).toBe(201);
    expect(issued.body.card.state).toBe('issued');
    const card = fromSecrets(issued.body);
    const secret = await enrollTotp(t, card);
    const expert = await login(t, card, { totp: secret });
    const me = await expert.get('/v1/auth/session');
    expect(me.body.roles).toEqual(['expert']);
    expect(me.body.card_state).toBe('active');

    // An Expert sees only their own card.
    const list = await expert.get('/v1/cards');
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: any) => c.id)).toEqual([card.id]);

    // The Owner sees the company card, their own card and the expert's card.
    const all = await tenant.owner.get('/v1/cards');
    expect(all.body.items).toHaveLength(3);
  });

  it('a second member with a passkey can log in', async () => {
    const tenant = await createTenant(t, 'smoke2');
    const admin = await addMember(t, tenant.owner, [{ role_key: 'admin' }]);
    const me = await admin.client.get('/v1/auth/session');
    expect(me.body.roles).toEqual(['admin']);
  });
});
