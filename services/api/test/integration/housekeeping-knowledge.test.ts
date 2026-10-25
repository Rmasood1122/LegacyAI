// Housekeeping job 6: the command asks the knowledge (AI) service to do its own housekeeping for every customer
// company - including sealing content written before decision D41 step 4b - one company at a time, with a service
// token for that company and that operation only. Against the stand-in AI service (test/helpers/ai-stub.ts); what
// the real service does with the call is tested in services/ai (tests/integration/test_seal_existing.py).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHousekeeping, sweepKnowledge } from '../../src/cli/housekeeping.ts';
import { PLATFORM_TENANT_ID } from '../../src/modules/platform/index.ts';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { createTenant, startApp, type TestApp, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  a = await createTenant(t, 'upkeep-a');
  b = await createTenant(t, 'upkeep-b');
});

afterAll(async () => {
  await t?.close();
  await stub?.stop();
});

beforeEach(() => {
  stub.reset();
  process.exitCode = 0;
});

describe('housekeeping job 6: the knowledge service, for every company', () => {
  it('calls the service once per customer company (never the platform), for that company only, and adds up its counts', async () => {
    stub.answers.set('housekeeping.run', () => ({ done: { stale: 1, sealed_chunks: 200, readable_chunks: 5, seal_key_unavailable: 0 } }));
    const report = await sweepKnowledge(t.app, new Date());
    const companies = stub.ofAction('housekeeping.run').map((c) => c.claims.tenant_id as string);
    expect(companies).toContain(a.tenantId);
    expect(companies).toContain(b.tenantId);
    expect(companies).not.toContain(PLATFORM_TENANT_ID);
    expect(new Set(companies).size).toBe(companies.length);               // each company once
    for (const call of stub.ofAction('housekeeping.run')) {
      // a job acts for nobody: no card that exists, no person, no roles, no access filter
      expect(call.claims.card_id).toBe('00000000-0000-0000-0000-000000000000');
      expect(call.claims.person_id).toBeNull();
      expect(call.claims.roles).toEqual([]);
      expect(call.claims.filter).toBeNull();
    }
    expect(report.companies).toBe(companies.length);
    expect(report.sealed_chunks).toBe(200 * companies.length);
    expect(report.readable_chunks).toBe(5 * companies.length);
    expect(report.failed).toBe(0);
    expect(process.exitCode).toBe(0);
  });

  it('a company whose call fails is reported and does not stop the others; the command then ends with a failure code', async () => {
    stub.answers.set('housekeeping.run', (c) => (c.claims.tenant_id === a.tenantId ? new StubError(500, 'boom') : { done: { sealed_versions: 3 } }));
    const report = await sweepKnowledge(t.app, new Date());
    expect(report.failed).toBe(1);
    expect((report.failures as string[])[0]).toContain(a.tenantId);
    expect(stub.ofAction('housekeeping.run').map((c) => c.claims.tenant_id)).toContain(b.tenantId);
    expect(report.sealed_versions).toBe(3 * (report.companies as number));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('is part of the one housekeeping command', async () => {
    const report = await runHousekeeping(t.app, new Date());
    expect(report.knowledge).toMatchObject({ failed: 0 });
    expect(stub.ofAction('housekeeping.run').length).toBeGreaterThanOrEqual(2);
    process.exitCode = 0;
  });
});
