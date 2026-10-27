// When a company's own key is switched off, destroyed or unreachable, the AI service cannot open the company's
// documents and knowledge and answers 503 company_key_unavailable (decision D41). People are told exactly that - the
// company's key cannot be used right now - not that "AI is not available", so the owner knows to look at the key
// (step 7; docs/runbooks/company-key.md). Against the stand-in AI service (test/helpers/ai-stub.ts); the real
// service's answer is tested in services/ai (test_sealed_chunks.py, "a company that switches its key off ...").
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiStub, StubError } from '../helpers/ai-stub.ts';
import { createTenant, startApp, type TestApp, type TestTenant } from '../helpers/harness.ts';

let stub: AiStub;
let t: TestApp;
let tenant: TestTenant;

beforeAll(async () => {
  stub = await new AiStub().start();
  t = await startApp({}, { AI_SERVICE_URL: stub.url });
  tenant = await createTenant(t, 'key-off');
  expect((await tenant.owner.post('/v1/topics', { name: 'Synthetic topic' })).status).toBe(201);
});

afterAll(async () => {
  await t?.close();
  await stub?.stop();
});

beforeEach(() => stub.reset());

describe('the company key cannot be used', () => {
  it('every screen that needs the company\'s content says the company key cannot be used, not that AI is unavailable', async () => {
    for (const action of ['topic.texts', 'topic.create']) stub.answers.set(action, () => new StubError(503, 'company_key_unavailable'));
    const answers = [
      await tenant.owner.get('/v1/topics'),
      await tenant.owner.post('/v1/topics', { name: 'Another synthetic topic' }),
    ];
    for (const res of answers) {
      expect(res.status, res.raw).toBe(503);
      expect(res.body.type).toContain('company-key-unavailable');
      expect(res.body.title).toBe("The company's own encryption key cannot be used right now");
      expect(res.raw).not.toContain('company_key_unavailable');        // the AI service's own wording is not passed on
    }
  });

  it('any other 503 of the AI service is still "AI is not available right now"', async () => {
    stub.answers.set('topic.texts', () => new StubError(503, 'ai_unavailable'));
    const res = await tenant.owner.get('/v1/topics');
    expect(res.status).toBe(503);
    expect(res.body.type).toContain('ai-unavailable');
    expect(res.body.title).toBe('AI is not available right now');
  });
});
