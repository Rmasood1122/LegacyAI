// API keys: what happens around a key, with the database replaced by a recorder (no database runs on the
// developer's computer). Each test checks WHICH statements are issued and who is told - not what PostgreSQL does
// with them; that is test/integration/api-keys.test.ts (GitHub Actions).
import { describe, expect, it } from 'vitest';
import {
  API_KEY_LIMITS, ApiKeyService, CardService, formatApiKey, keyRevocationReason, type AnomalySettings,
} from '../../src/modules/identity-access/index.ts';
import type { NotificationEvent, Notifier, RateLimiter, Tx } from '../../src/modules/platform/index.ts';
import { sha256 } from '../../src/shared/crypto.ts';
import { apiKeySubject } from '../../src/modules/identity-access/index.ts';
import type { RequestContext } from '../../src/shared/policy-types.ts';

const T1 = '11111111-1111-4111-8111-111111111111';
const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_A = '99999999-9999-4999-8999-999999999991';
const KEY_B = '99999999-9999-4999-8999-999999999992';
const NOW = new Date('2026-06-01T12:00:00Z');
const SECRET = 'A'.repeat(43);

interface Call { sql: string; params: unknown[] }
type Answer = { rows?: unknown[]; rowCount?: number };

/** A stand-in for a transaction: records every statement and answers the ones a test scripts. */
function recorder(answers: Array<[RegExp, Answer | ((call: Call) => Answer)]> = []): { tx: Tx; calls: Call[]; audits: () => Array<Record<string, unknown>> } {
  const calls: Call[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      const call = { sql, params };
      calls.push(call);
      const hit = answers.find(([re]) => re.test(sql));
      const answer = hit === undefined ? {} : typeof hit[1] === 'function' ? hit[1](call) : hit[1];
      return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? (answer.rows ?? []).length };
    },
  } as unknown as Tx;
  const audits = (): Array<Record<string, unknown>> => calls.filter((c) => c.sql.includes('audit_write')).map((c) => ({
    actorCardId: c.params[1], actorKind: c.params[2], action: c.params[3], resourceId: c.params[5], decision: c.params[6], reasonCode: c.params[7],
    details: JSON.parse(String(c.params[10])),
  }));
  return { tx, calls, audits };
}

function notices(): { notifier: Notifier; sent: NotificationEvent[] } {
  const sent: NotificationEvent[] = [];
  return { notifier: { notify: async (e) => { sent.push(e); } }, sent };
}

const ctx = (): RequestContext => ({ requestId: 'req-1', ip: '192.0.2.9', userAgent: 'machine', now: NOW, fetchSite: null, afterCommit: [] });
const flush = async (c: RequestContext): Promise<void> => {
  for (const job of c.afterCommit?.splice(0) ?? []) await job();
};
const limiter = (refuse: (key: string) => boolean = () => false): RateLimiter & { hits: Array<[string, number, number]> } => {
  const hits: Array<[string, number, number]> = [];
  return { hits, hit: async (key, limit, windowSeconds) => { hits.push([key, limit, windowSeconds]); return refuse(key) ? { allowed: false, retryAfterSeconds: 77 } : { allowed: true, retryAfterSeconds: 0 }; } };
};

describe('a change of the maker\'s card revokes its keys in the same transaction', () => {
  const card = { id: CARD, tenant_id: T1 };
  const cards = (notifier: Notifier): CardService => new CardService({ hasher: {} as never, notifier, hmacKey: Buffer.alloc(32) });

  it.each(['sc_rotated', 'credentials_reset', 'privilege_change', 'card_replaced', 'card_revoked', 'card_suspended', 'card_locked'] as const)(
    'sessions ended for "%s": every live key of the card is revoked, one audit row per key, the Owners are told once', async (reason) => {
      const { tx, calls, audits } = recorder([[/UPDATE api_keys SET revoked_at/, { rows: [{ id: KEY_A }, { id: KEY_B }] }]]);
      const { notifier, sent } = notices();
      await cards(notifier).revokeSessions(tx, card, reason, NOW);

      // the sessions and the keys, in this order, on the same transaction
      expect(calls.map((c) => c.sql.replace(/\s+/g, ' ').slice(0, 22))).toEqual([
        'UPDATE sessions SET re', 'UPDATE api_keys SET rev', 'SELECT audit_write($1,', 'SELECT audit_write($1,',
      ].map((s) => s.slice(0, 22)));
      const update = calls[1] as Call;
      expect(update.sql).toMatch(/WHERE tenant_id = \$1 AND created_by_card_id = \$2 AND revoked_at IS NULL/);   // only keys this card made, only live ones
      expect(update.params).toEqual([T1, CARD, NOW, keyRevocationReason(reason)]);
      expect(audits()).toEqual([KEY_A, KEY_B].map((id) => ({
        actorCardId: null, actorKind: 'system', action: 'api_key:manage', resourceId: id, decision: 'event', reasonCode: 'API_KEY_REVOKED_MAKER_CHANGED',
        details: { api_key_id: id, reason: keyRevocationReason(reason), target_card_id: CARD },
      })));
      expect(sent).toEqual([{ type: 'api_key_stopped', tenantId: T1, cardId: CARD, audience: 'owners' }]);
    });

  it('the holder removes one sign-in factor: only the sessions opened with it end - and every key of the card', async () => {
    const { tx, calls } = recorder([[/UPDATE api_keys SET revoked_at/, { rows: [{ id: KEY_A }] }]]);
    const { notifier, sent } = notices();
    await cards(notifier).revokeSessions(tx, card, 'credentials_reset', NOW, { openedWithCredentialId: KEY_B });
    const sessions = calls[0] as Call;
    expect(sessions.sql).toMatch(/\$5::uuid IS NULL OR credential_id = \$5::uuid/);
    expect(sessions.params).toEqual([T1, CARD, 'credentials_reset', NOW, KEY_B]);
    expect((calls[1] as Call).params).toEqual([T1, CARD, NOW, 'maker_credentials_reset']);    // the keys are not narrowed
    expect(sent).toEqual([{ type: 'api_key_stopped', tenantId: T1, cardId: CARD, audience: 'owners' }]);
    // without the narrowing, every session of the card ends
    const all = recorder([[/UPDATE api_keys SET revoked_at/, { rows: [] }]]);
    await cards(notices().notifier).revokeSessions(all.tx, card, 'card_locked', NOW);
    expect((all.calls[0] as Call).params).toEqual([T1, CARD, 'card_locked', NOW, null]);
  });

  it('a card that made no key: nothing is written and nobody is told', async () => {
    const { tx, audits } = recorder();
    const { notifier, sent } = notices();
    await cards(notifier).revokeSessions(tx, card, 'card_suspended', NOW);
    expect(audits()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each(['logout', 'card_expired'] as const)('sessions ended for "%s": the keys are not touched', async (reason) => {
    const { tx, calls } = recorder();
    const { notifier, sent } = notices();
    await cards(notifier).revokeSessions(tx, card, reason, NOW);
    expect(calls.map((c) => c.sql).filter((sql) => sql.includes('api_keys'))).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('making a key', () => {
  it('stores the hash, never the secret; the Owners are told after the commit', async () => {
    const row = { id: KEY_A, scope: ['topic:read'] };
    const { tx, calls } = recorder([[/SELECT count/, { rows: [{ n: 0 }] }], [/INSERT INTO api_keys/, { rows: [row] }]]);
    const { notifier, sent } = notices();
    const c = ctx();
    const made = await new ApiKeyService(limiter(), notifier).create(tx, T1, CARD, { name: 'k', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30 }, c);
    if (made === 'too-many-keys') throw new Error('unexpected');
    const insert = calls.find((call) => call.sql.includes('INSERT INTO api_keys')) as Call;
    expect(JSON.stringify(insert.params)).not.toContain(made.secret);
    expect((insert.params[3] as Buffer).equals(sha256(made.secret))).toBe(true);
    expect(insert.params[7]).toBe(API_KEY_LIMITS.defaultAsksPerHour);          // 30 questions an hour unless the request says otherwise
    expect(sent).toEqual([]);                                                   // not before the commit
    await flush(c);
    expect(sent).toEqual([{ type: 'api_key_created', tenantId: T1, cardId: CARD, audience: 'owners' }]);
  });

  it('a company at its limit of live keys gets no more', async () => {
    const { tx } = recorder([[/SELECT count/, { rows: [{ n: API_KEY_LIMITS.maxPerCompany }] }]]);
    const { notifier, sent } = notices();
    const c = ctx();
    expect(await new ApiKeyService(limiter(), notifier).create(tx, T1, CARD, { name: 'k', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 30 }, c)).toBe('too-many-keys');
    await flush(c);
    expect(sent).toEqual([]);
  });
});

describe('using a key: refused attempts are recorded, bounded; limits come before anything costly', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: KEY_A, created_by_card_id: CARD, scope: ['knowledge:ask'], max_sensitivity: 1, asks_per_hour: 5, allowed_cidrs: null,
    expires_at: new Date(NOW.getTime() + 86_400_000), revoked_at: null, suspended_at: null, secret_hash: sha256(SECRET), ...over,
  });
  const good = formatApiKey(T1, KEY_A, SECRET);
  const wrong = formatApiKey(T1, KEY_A, 'B'.repeat(43));

  it('something that is not a key, or a key id that does not exist: "does not work", and nothing is written', async () => {
    const { tx, calls } = recorder();
    const service = new ApiKeyService(limiter(), notices().notifier);
    expect(await service.resolve(tx, 'lak1.not-a-key', 'topic:read', ctx())).toBeNull();
    expect(calls).toEqual([]);
    expect(await service.resolve(tx, good, 'topic:read', ctx())).toBeNull();      // the recorder finds no such key
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('FROM api_keys');
  });

  it('a wrong secret against an existing key: counted on the key; one audit row for the first in a window, none for the next', async () => {
    let first = true;
    const { tx, audits, calls } = recorder([
      [/SELECT[\s\S]*secret_hash FROM api_keys/, { rows: [stored()] }],
      [/failed_count/, () => { const rows = [{ first_in_window: first, wrong_secret_count: first ? 1 : 2 }]; first = false; return { rows }; }],
    ]);
    const { notifier, sent } = notices();
    const service = new ApiKeyService(limiter(), notifier);
    const c = ctx();
    expect(await service.resolve(tx, wrong, 'topic:read', c)).toBeNull();
    expect(await service.resolve(tx, wrong, 'topic:read', c)).toBeNull();
    expect(calls.filter((call) => call.sql.includes('failed_count'))).toHaveLength(2);    // both attempts counted
    expect(audits()).toEqual([{
      actorCardId: null, actorKind: 'anonymous', action: 'api_key:use', resourceId: KEY_A, decision: 'deny', reasonCode: 'API_KEY_REFUSED',
      details: { api_key_id: KEY_A, reason: 'wrong-secret' },
    }]);
    expect(JSON.stringify(calls)).not.toContain('B'.repeat(43));                          // the secret that was tried is written nowhere
    await flush(c);
    expect(sent).toEqual([]);
  });

  it('wrong secrets never stop a key: at the tenth in a window the Owners are told ONCE, and nothing is suspended', async () => {
    // the key's id is not secret: suspending on wrong secrets would let anybody who has seen it break an integration
    let count = API_KEY_LIMITS.wrongSecretsBeforeNotice - 1;
    const { tx, audits, calls } = recorder([
      [/SELECT[\s\S]*secret_hash FROM api_keys/, { rows: [stored()] }],
      [/failed_count/, () => { count += 1; return { rows: [{ first_in_window: false, wrong_secret_count: count }] }; }],
    ]);
    const { notifier, sent } = notices();
    const service = new ApiKeyService(limiter(), notifier);
    const c = ctx();
    for (let i = 0; i < 41; i += 1) expect(await service.resolve(tx, wrong, 'topic:read', c)).toBeNull();   // the 10th ... the 50th
    expect(calls.some((call) => call.sql.includes('SET suspended_at'))).toBe(false);
    expect(audits()).toEqual([{
      actorCardId: null, actorKind: 'system', action: 'api_key:use', resourceId: KEY_A, decision: 'event', reasonCode: 'API_KEY_WRONG_SECRETS',
      details: { api_key_id: KEY_A, count: API_KEY_LIMITS.wrongSecretsBeforeNotice },
    }]);
    await flush(c);
    expect(sent).toEqual([{ type: 'api_key_wrong_secrets', tenantId: T1, cardId: CARD, audience: 'owners' }]);
    expect(JSON.stringify(calls)).not.toContain('B'.repeat(43));
  });

  it.each([
    ['revoked', { revoked_at: NOW }], ['suspended', { suspended_at: NOW }], ['expired', { expires_at: NOW }], ['network', { allowed_cidrs: ['198.51.100.0/24'] }],
  ])('the right secret of a key that is %s: refused, recorded with that reason, never suspended for it', async (reason, over) => {
    const { tx, audits, calls } = recorder([
      [/SELECT[\s\S]*secret_hash FROM api_keys/, { rows: [stored(over)] }],
      [/failed_count/, { rows: [{ first_in_window: true, wrong_secret_count: 0 }] }],
    ]);
    const limits = limiter();
    expect(await new ApiKeyService(limits, notices().notifier).resolve(tx, good, 'topic:read', ctx())).toBeNull();
    expect(audits().map((a) => (a.details as { reason: string }).reason)).toEqual([reason]);
    expect(calls.some((call) => call.sql.includes('SET suspended_at'))).toBe(false);
    expect(limits.hits).toEqual([]);                                                       // a key that does not work uses up nothing
  });

  it('beyond its requests per minute: 429, before the maker\'s card is even loaded', async () => {
    const { tx, calls } = recorder([[/SELECT[\s\S]*secret_hash FROM api_keys/, { rows: [stored()] }]]);
    const limits = limiter((key) => key === `api-key:${KEY_A}`);
    expect(await new ApiKeyService(limits, notices().notifier).resolve(tx, good, 'topic:read', ctx())).toEqual({ limited: 77 });
    expect(limits.hits).toEqual([[`api-key:${KEY_A}`, API_KEY_LIMITS.requestsPerMinute, 60]]);
    expect(calls).toHaveLength(1);
  });

  it('beyond its questions per hour: 429 for asking - with the key\'s own number - and only for asking', async () => {
    const { tx, calls } = recorder([[/SELECT[\s\S]*secret_hash FROM api_keys/, { rows: [stored({ asks_per_hour: 5 })] }]]);
    const limits = limiter((key) => key === `api-key-asks:${KEY_A}`);
    const service = new ApiKeyService(limits, notices().notifier);
    expect(await service.resolve(tx, good, 'knowledge:ask', ctx())).toEqual({ limited: 77 });
    expect(limits.hits).toEqual([[`api-key:${KEY_A}`, 120, 60], [`api-key-asks:${KEY_A}`, 5, 3600]]);
    expect(calls).toHaveLength(1);                                                         // nothing else was read or written
    // another action does not touch the question limit (the recorder has no card for the maker, so the key then "does not work")
    limits.hits.length = 0;
    await service.resolve(tx, good, 'topic:read', ctx());
    expect(limits.hits.map(([key]) => key)).toEqual([`api-key:${KEY_A}`]);
  });
});

describe('the anomaly rule for a key', () => {
  const settings = { enabled: true, denials_enabled: true, denials_threshold: 5, denials_window_minutes: 10 } as AnomalySettings;
  const subject = apiKeySubject(T1, { id: KEY_A, scope: ['topic:read'], max_sensitivity: 0 }, { card_id: CARD, person_id: null });

  it('at the company\'s threshold the KEY is suspended: the system is the actor, the Owners are told, and nothing is written on the maker\'s card', async () => {
    const { tx, audits, calls } = recorder([[/denial_count/, { rows: [{ denial_count: 5 }] }], [/SET suspended_at/, { rowCount: 1 }]]);
    const { notifier, sent } = notices();
    const c = ctx();
    expect(await new ApiKeyService(limiter(), notifier).denied(tx, subject, 'DENY_API_KEY_SCOPE', settings, c)).toBe(true);
    expect(audits()).toEqual([{
      actorCardId: null, actorKind: 'system', action: 'api_key:manage', resourceId: KEY_A, decision: 'event', reasonCode: 'API_KEY_SUSPENDED_ANOMALY',
      details: { api_key_id: KEY_A, rule: 'denials', count: 5 },
    }]);
    expect(calls.some((call) => /card_events|card_auth_state|card_anomaly_counters|card_usage_counters/.test(call.sql))).toBe(false);
    await flush(c);
    expect(sent).toEqual([{ type: 'api_key_stopped', tenantId: T1, cardId: CARD, audience: 'owners' }]);
  });

  it('below the threshold, for a refusal that does not count, or with the rule switched off: nothing', async () => {
    const service = new ApiKeyService(limiter(), notices().notifier);
    const below = recorder([[/denial_count/, { rows: [{ denial_count: 4 }] }]]);
    expect(await service.denied(below.tx, subject, 'DENY_API_KEY_SCOPE', settings, ctx())).toBe(false);
    const uncounted = recorder();
    expect(await service.denied(uncounted.tx, subject, 'DENY_PLAN_LIMIT', settings, ctx())).toBe(false);
    expect(uncounted.calls).toEqual([]);
    const off = recorder();
    expect(await service.denied(off.tx, subject, 'DENY_API_KEY_SCOPE', { ...settings, denials_enabled: false }, ctx())).toBe(false);
    expect(off.calls).toEqual([]);
  });
});
