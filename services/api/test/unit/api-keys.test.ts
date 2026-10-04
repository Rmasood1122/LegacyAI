// API keys (feature 28, part A): the pure parts - the shape of a key, what a key may be asked to carry, what the
// policy decision point lets a key do (a key is its own kind of subject), when a key may be used at all, which
// changes of its maker's card end it, how a request says who is asking, and which operations the contract opens.
// What a key can do against the real server and database is tested in test/integration/api-keys.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_LIMITS, API_KEY_PERMISSIONS, apiKeySubject, buildResourceFilterSpec, cidrsAllow, COUNTED_REASONS, decide, formatApiKey, grantsForKey,
  heldForKeys, heldGrants, keyRequestProblem, keyRevocationReason, keyStatus, keyUsable, makerCanAct, parseApiKey, validCidrs,
  type Grant, type Matrix, type NewKeyRequest, type PermissionDef, type PolicyContext,
} from '../../src/modules/identity-access/index.ts';
import { credentialOf, loadContract, stripOneTimeSecrets } from '../../src/modules/platform/index.ts';
import { sha256 } from '../../src/shared/crypto.ts';
import {
  actingCardId, actingPersonId, idempotencyActor, type ApiKeySubject, type CardSubject, type ResourceRef, type RoleKey, type SubjectRole,
} from '../../src/shared/policy-types.ts';

const T1 = '11111111-1111-4111-8111-111111111111';
const KEY = '99999999-9999-4999-8999-999999999999';
const CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOMEONE_ELSE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NOW = new Date('2026-06-01T12:00:00Z');
const DAY = 86_400_000;
const SECRET = 'A'.repeat(43);
const here = path.resolve(import.meta.dirname, '..', '..');
const contract = loadContract(path.join(here, 'openapi.yaml'));

describe('the shape of a key', () => {
  it('a key says which company and which key it is; anything else is not a key', () => {
    const key = formatApiKey(T1, KEY, SECRET);
    expect(parseApiKey(key)).toEqual({ tenantId: T1, keyId: KEY, secret: SECRET });
    for (const bad of ['', 'Bearer x', key.slice(0, -1), `${key}A`, key.replace('lak1', 'lak2'), key.replace(T1, 'not-a-company-id-not-a-company-id-xxxx'),
      `lak1.${T1}.${KEY}.${'*'.repeat(43)}`, `lak1.${T1}.${KEY}`, 'x'.repeat(500), null, undefined, 42, { key }]) {
      expect(parseApiKey(bad), String(bad).slice(0, 40)).toBeNull();
    }
  });

  it('a key is active until it expires, is revoked, or is suspended; revoked wins', () => {
    const live = { revoked_at: null, suspended_at: null, expires_at: new Date(NOW.getTime() + DAY) };
    expect(keyStatus(live, NOW)).toBe('active');
    expect(keyStatus({ ...live, expires_at: NOW }, NOW)).toBe('expired');                // the expiry instant is already too late
    expect(keyStatus({ ...live, suspended_at: NOW }, NOW)).toBe('suspended');
    expect(keyStatus({ ...live, suspended_at: NOW, revoked_at: NOW }, NOW)).toBe('revoked');
  });

  it('the example in the contract has the shape of a key (and is plainly not one)', () => {
    const yaml = readFileSync(path.join(here, 'openapi.yaml'), 'utf8');
    const example = /example: "(lak1\.[^"]+)"/.exec(yaml)?.[1];
    expect(parseApiKey(example)).not.toBeNull();
    expect(example).toContain('NOT-A-REAL-KEY');
  });
});

describe('when a stored key may be used (before the policy is asked)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    secret_hash: sha256(SECRET), revoked_at: null, suspended_at: null, expires_at: new Date(NOW.getTime() + DAY), allowed_cidrs: null as string[] | null, ...over,
  });
  const at = { now: NOW, ip: '192.0.2.9' };

  it.each([
    ['the right secret, live, from anywhere', row(), SECRET, 'ok'],
    ['the right secret from a network on its list', row({ allowed_cidrs: ['192.0.2.0/24'] }), SECRET, 'ok'],
    ['a wrong secret', row(), 'B'.repeat(43), 'wrong-secret'],
    ['a wrong secret against a revoked key (the state is not given away)', row({ revoked_at: NOW }), 'B'.repeat(43), 'wrong-secret'],
    ['revoked', row({ revoked_at: NOW }), SECRET, 'revoked'],
    ['suspended', row({ suspended_at: NOW }), SECRET, 'suspended'],
    ['expired', row({ expires_at: NOW }), SECRET, 'expired'],
    ['from a network that is not on its list', row({ allowed_cidrs: ['198.51.100.0/24'] }), SECRET, 'network'],
  ])('%s -> %s', (_name, stored, secret, verdict) => {
    expect(keyUsable(stored, { secret }, at)).toBe(verdict);
  });

  it('a key id that does not exist is "unknown" whatever the secret', () => {
    expect(keyUsable(undefined, { secret: SECRET }, at)).toBe('unknown');
  });

  it('wrong secrets are reported, not punished, after a bounded number of attempts; the limits are fixed numbers', () => {
    expect(API_KEY_LIMITS).toMatchObject({ wrongSecretsBeforeNotice: 10, failureWindowMinutes: 15, defaultAsksPerHour: 30, maxAsksPerHour: 600, requestsPerMinute: 120 });
    expect(Object.keys(API_KEY_LIMITS).some((k) => /suspen/i.test(k))).toBe(false);
  });
});

describe('the copy of an answer kept for a retried request', () => {
  it('does not hold the key: the contract names the field, and a replay says it was already shown', () => {
    const fields = contract.operations.get('createApiKey')?.oneTimeSecrets ?? [];
    expect(fields).toEqual(['api_key']);
    const answer = { id: KEY, name: 'k', api_key: formatApiKey(T1, KEY, SECRET), secret_already_shown: false };
    const stored = stripOneTimeSecrets(answer, fields);
    expect(stored).toEqual({ id: KEY, name: 'k', secret_already_shown: true });
    expect(JSON.stringify(stored)).not.toContain(SECRET);
  });

  it('every operation that returns a one-time secret declares it (secret code, enrollment token, API key)', () => {
    const declared = Object.fromEntries([...contract.operations.values()].filter((op) => op.oneTimeSecrets.length > 0).map((op) => [op.operationId, [...op.oneTimeSecrets]]));
    const card = ['sc', 'enrollment_token', 'enrollment_token_expires_at'];
    expect(declared).toEqual({
      issueCard: card, replaceCard: card, renewCard: card, unlockCard: card, issueEnrollmentToken: card.slice(1), createTenant: card,
      renewCompanyCard: card, recoverOwnerCard: card, createApiKey: ['api_key'],
    });
  });

  it('a field that is nobody\'s declared secret is kept', () => {
    expect(stripOneTimeSecrets({ sc: '123', api_key: 'x' }, ['api_key'])).toEqual({ sc: '123', secret_already_shown: true });
  });
});

describe('what a key may be asked to carry', () => {
  const held = new Map<string, number>([['knowledge:read', 3], ['knowledge:ask', 3], ['topic:read', 1], ['card:issue', 3], ['api_key:manage', 3], ['capture:upload', 3]]);
  const ask = (over: Partial<NewKeyRequest> = {}): NewKeyRequest => ({ name: 'k', scope: ['knowledge:read'], max_sensitivity: 1, expires_in_days: 30, ...over });

  it('the short list is exactly five permissions - read and ask; a key adds or changes nothing', () => {
    expect([...API_KEY_PERMISSIONS].sort()).toEqual(['gap:read', 'knowledge:ask', 'knowledge:read', 'source:read', 'topic:read']);
  });

  it('of what a card holds, only what is on the short list can go into a key', () => {
    expect([...heldForKeys(held).keys()].sort()).toEqual(['knowledge:ask', 'knowledge:read', 'topic:read']);
  });

  it('accepts a key within its maker\'s rights', () => {
    expect(keyRequestProblem(ask(), heldForKeys(held))).toBeNull();
    expect(keyRequestProblem(ask({ scope: ['knowledge:read', 'topic:read'], max_sensitivity: 1, allowed_cidrs: ['10.0.0.0/8', '2001:db8::/32'], asks_per_hour: 600 }), heldForKeys(held))).toBeNull();
  });

  it.each([
    ['nothing at all', { scope: [] }, 'empty-scope'],
    ['a permission keys never carry (issuing cards), although the maker holds it', { scope: ['card:issue'] }, 'permission-not-allowed-for-keys'],
    ['making keys', { scope: ['api_key:manage'] }, 'permission-not-allowed-for-keys'],
    ['adding documents, although the maker holds it', { scope: ['capture:upload'] }, 'permission-not-allowed-for-keys'],
    ['a permission on the short list that the maker does not hold', { scope: ['gap:read'] }, 'permission-not-held'],
    ['a level above the maker\'s for one of its permissions', { scope: ['knowledge:read', 'topic:read'], max_sensitivity: 2 }, 'level-above-own'],
    ['a level that is not a level', { max_sensitivity: 4 }, 'level-above-own'],
    ['no expiry', { expires_in_days: 0 }, 'bad-expiry'],
    ['an expiry of more than a year', { expires_in_days: API_KEY_LIMITS.maxDays + 1 }, 'bad-expiry'],
    ['networks that cannot be read', { allowed_cidrs: ['10.0.0.0/33'] }, 'bad-networks'],
    ['an empty list of networks (it would lock the key out everywhere)', { allowed_cidrs: [] }, 'bad-networks'],
    ['no questions at all', { asks_per_hour: 0 }, 'bad-ask-limit'],
    ['more questions per hour than a key may have', { asks_per_hour: API_KEY_LIMITS.maxAsksPerHour + 1 }, 'bad-ask-limit'],
    ['a number of questions that is not a whole number', { asks_per_hour: 1.5 }, 'bad-ask-limit'],
  ])('refuses %s', (_name, over, problem) => {
    expect(keyRequestProblem(ask(over as Partial<NewKeyRequest>), heldForKeys(held))).toBe(problem);
  });

  it('reads networks the same way when storing and when checking', () => {
    expect(validCidrs(['192.0.2.0/24', '2001:db8::/32', '203.0.113.7'])).toBe(true);
    for (const bad of [[], ['10.0.0.0/'], ['10.0.0.0/8/1'], ['not-a-network'], ['10.0.0.0/-1'], [42], 'text', null]) expect(validCidrs(bad), JSON.stringify(bad)).toBe(false);
    expect(cidrsAllow(['192.0.2.0/24'], '192.0.2.9')).toBe(true);
    expect(cidrsAllow(['192.0.2.0/24'], '::ffff:192.0.2.9')).toBe(true);     // the same address as seen through an IPv6 socket
    expect(cidrsAllow(['192.0.2.0/24'], '192.0.3.9')).toBe(false);
    expect(cidrsAllow([], '192.0.2.9')).toBe(false);
    expect(cidrsAllow(['192.0.2.0/24'], 'not-an-address')).toBe(false);
  });
});

// ---------------------------------------------------------------- the policy decision point with a key

const perms: PermissionDef[] = [
  { permission_key: 'knowledge:read', is_write: false, platform_only: false },
  { permission_key: 'knowledge:ask', is_write: false, platform_only: false },
  { permission_key: 'knowledge:verify', is_write: true, platform_only: false },
  { permission_key: 'capture:upload', is_write: true, platform_only: false },
  { permission_key: 'card:issue', is_write: true, platform_only: false },
  { permission_key: 'api_key:manage', is_write: true, platform_only: false },
  { permission_key: 'export:create', is_write: true, platform_only: false },
  { permission_key: 'billing:read', is_write: false, platform_only: false },
  { permission_key: 'tenant:create', is_write: true, platform_only: true },
];
const g = (role_key: RoleKey, permission_key: string, scope: Grant['scope'], max_sensitivity: number, grant_source: Grant['grant_source'] = 'base'): Grant =>
  ({ role_key, permission_key, scope, max_sensitivity, grant_source });
const matrix: Matrix = {
  permissions: new Map(perms.map((p) => [p.permission_key, p])),
  grants: [
    ...perms.map((p) => g('company_owner', p.permission_key, 'tenant', 3)), g('expert', 'knowledge:read', 'own', 1), g('expert', 'knowledge:ask', 'tenant', 1),
    g('expert', 'knowledge:verify', 'tenant', 1, 'pilot_reviewer'),
  ],
};
const role = (role_key: RoleKey): SubjectRole => ({ role_key, department_id: null, rank: role_key === 'company_owner' ? 100 : 30 });
/** A card: here, the card that made the key, as it is at the moment of the request. */
function card(roles: SubjectRole[], over: Partial<CardSubject> = {}): CardSubject {
  return {
    kind: 'card', tenant_id: T1, card_id: CARD, card_number: '0000000000000000', person_id: PERSON, department_id: null, card_state: 'active',
    activated_at: new Date(NOW.getTime() - 10 * DAY), expires_at: new Date(NOW.getTime() + 30 * DAY), grace_until: new Date(NOW.getTime() + 44 * DAY),
    renewal_due: new Date(NOW.getTime() + 16 * DAY), locked: false, roles, is_platform_tenant: false, session_id: 's', session_idle_expires_at: NOW,
    session_absolute_expires_at: NOW, ...over,
  };
}
/** A key made by CARD (person PERSON), through the one constructor. */
const key = (scope: string[], max_sensitivity: number): ApiKeySubject =>
  apiKeySubject(T1, { id: KEY, scope, max_sensitivity }, { card_id: CARD, person_id: PERSON });
const LIVE = { state: 'active' as const, expires_at: new Date(NOW.getTime() + 60 * DAY), grace_until: new Date(NOW.getTime() + 74 * DAY) };
const OWNER = [role('company_owner')];
/** The policy context of a request with a key: `maker` is the key's maker as loaded from the database ('none' = a card's own request). */
const ctx = (maker: CardSubject | null | 'none' = card(OWNER), over: Partial<PolicyContext> = {}): PolicyContext => ({
  now: NOW, ip: '10.0.0.5', tenant: { status: 'active' }, settings: { enabled_roles: ['company_owner', 'expert'], pilot_reviewer_grant: false },
  matrix, companyCard: LIVE, restrictions: [], usage: new Map(), planAllows: true, ...(maker === 'none' ? {} : { keyMaker: maker }), ...over,
});
const item = (sensitivity: number, over: Partial<ResourceRef> = {}): ResourceRef =>
  ({ type: 'knowledge_item', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tenant_id: T1, sensitivity, verification_status: 'verified', ...over });

describe('a key is its own kind of subject', () => {
  it('it carries no roles, no session and no person of its own - only whom it acts for', () => {
    const k = key(['knowledge:read'], 1);
    expect(Object.keys(k).sort()).toEqual(['acts_for', 'key_id', 'kind', 'max_sensitivity', 'scope', 'tenant_id']);
    expect(k).toMatchObject({ kind: 'api_key', key_id: KEY, acts_for: { card_id: CARD, person_id: PERSON } });
    expect(JSON.stringify(k)).not.toMatch(/roles|session|card_number/);
  });

  it('rows and rules that need "a card" or "a person" get the maker; idempotency records are the key\'s own', () => {
    const k = key(['knowledge:read'], 1);
    expect([actingCardId(k), actingPersonId(k), idempotencyActor(k)]).toEqual([CARD, PERSON, { kind: 'api_key', id: KEY }]);
    const c = card(OWNER);
    expect([actingCardId(c), actingPersonId(c), idempotencyActor(c)]).toEqual([CARD, PERSON, { kind: 'card', id: CARD }]);
  });

  it('grantsForKey: the maker\'s grants for the action, cut down to the key', () => {
    const makerGrants = [{ scope: 'tenant', max_sensitivity: 3 }, { scope: 'own', max_sensitivity: 1 }];
    expect(grantsForKey(makerGrants, { scope: ['knowledge:read'], max_sensitivity: 2 }, 'knowledge:read'))
      .toEqual([{ scope: 'tenant', max_sensitivity: 2 }, { scope: 'own', max_sensitivity: 1 }]);       // never lifted, only lowered
    expect(grantsForKey(makerGrants, { scope: ['knowledge:read'], max_sensitivity: 2 }, 'knowledge:ask')).toBe('outside-scope');   // not in the key
    expect(grantsForKey(makerGrants, { scope: ['card:issue'], max_sensitivity: 2 }, 'card:issue')).toBe('outside-scope');          // not on the short list
    expect(grantsForKey([], { scope: ['knowledge:read'], max_sensitivity: 2 }, 'knowledge:read')).toEqual([]);                     // the maker holds nothing
    for (const bad of [{ scope: 'knowledge:read', max_sensitivity: 1 }, { scope: ['knowledge:read'], max_sensitivity: 9 }, { scope: [1], max_sensitivity: 1 }, null]) {
      expect(grantsForKey(makerGrants, bad as never, 'knowledge:read'), JSON.stringify(bad)).toBe('malformed');
    }
  });

  it('heldGrants reads the matrix one way: switched-off roles, the pilot grant and platform-only permissions', () => {
    const settings = { enabled_roles: ['company_owner', 'expert'] as RoleKey[], pilot_reviewer_grant: false };
    const keys = (roles: SubjectRole[], platform: boolean, s = settings): string[] => [...new Set(heldGrants(roles, platform, { matrix, settings: s }).map((x) => x.permission_key))].sort();
    expect(keys([role('expert')], false)).toEqual(['knowledge:ask', 'knowledge:read']);
    expect(keys([role('expert')], false, { ...settings, pilot_reviewer_grant: true })).toEqual(['knowledge:ask', 'knowledge:read', 'knowledge:verify']);
    expect(keys([role('expert')], false, { ...settings, enabled_roles: ['company_owner'] })).toEqual([]);
    expect(keys(OWNER, false)).not.toContain('tenant:create');
    expect(keys(OWNER, true)).toContain('tenant:create');
  });
});

describe('what the policy decision point lets a key do', () => {
  it('a key does what was written into it, up to its level - and its maker could do the same', () => {
    expect(decide(key(['knowledge:read'], 1), 'knowledge:read', item(1), ctx()).effect).toBe('allow');
    expect(decide(card(OWNER), 'knowledge:read', item(1), ctx('none')).effect).toBe('allow');
  });

  it('nothing above the key\'s level, although its maker reads level 3', () => {
    expect(decide(key(['knowledge:read'], 1), 'knowledge:read', item(2), ctx())).toMatchObject({ effect: 'deny', reason_code: 'DENY_SENSITIVITY' });
    expect(decide(card(OWNER), 'knowledge:read', item(2), ctx('none')).effect).toBe('allow');
  });

  it('nothing that was not written into the key', () => {
    expect(decide(key(['knowledge:read'], 3), 'knowledge:ask', item(0), ctx())).toMatchObject({ effect: 'deny', reason_code: 'DENY_API_KEY_SCOPE' });
  });

  it.each(['card:issue', 'api_key:manage', 'knowledge:verify', 'export:create', 'billing:read', 'capture:upload'])(
    'never %s - not even when it was somehow written into the key and its maker holds it', (action) => {
      expect(decide(key([action], 3), action, { type: 'x', tenant_id: T1, collection: true }, ctx()))
        .toMatchObject({ effect: 'deny', reason_code: 'DENY_API_KEY_SCOPE' });
    });

  it('never more than its maker: a permission the maker has lost is gone for the key too', () => {
    const expertNow = ctx(card([role('expert')]));   // the maker was an Owner when the key was made, and is an Expert now
    expect(decide(key(['knowledge:ask', 'gap:read'], 3), 'billing:read', { type: 'x', tenant_id: T1, collection: true }, expertNow).effect).toBe('deny');
    // ... and what the maker holds only for its own things, the key holds only for the maker's own things
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(1, { owner_person_id: SOMEONE_ELSE }), expertNow))
      .toMatchObject({ effect: 'deny', reason_code: 'DENY_SCOPE' });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(1, { owner_person_id: PERSON }), expertNow).effect).toBe('allow');
    // the key's level never lifts the maker's
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(2, { owner_person_id: PERSON }), expertNow))
      .toMatchObject({ effect: 'deny', reason_code: 'DENY_SENSITIVITY' });
    // a maker with no role left: nothing
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card([])))).toMatchObject({ effect: 'deny', reason_code: 'DENY_DEFAULT' });
  });

  it.each([
    ['locked', { locked: true }, 'DENY_CARD_LOCKED'],
    ['suspended', { card_state: 'suspended' as const }, 'DENY_CARD_STATE'],
    ['revoked', { card_state: 'revoked' as const }, 'DENY_CARD_STATE'],
    ['never activated', { activated_at: null }, 'DENY_CARD_STATE'],
  ])('the maker\'s card state gates the key: a key of a maker whose card is %s does nothing', (_name, over, reason) => {
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card(OWNER, over)))).toMatchObject({ effect: 'deny', reason_code: reason });
  });

  it('a key whose maker was not loaded, or is another card than the key names, is refused - never run without a maker', () => {
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx('none'))).toMatchObject({ effect: 'deny', reason_code: 'DENY_UNAUTHENTICATED' });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(null))).toMatchObject({ effect: 'deny', reason_code: 'DENY_UNAUTHENTICATED' });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card(OWNER, { card_id: SOMEONE_ELSE }))))
      .toMatchObject({ effect: 'deny', reason_code: 'DENY_UNAUTHENTICATED' });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card(OWNER, { tenant_id: SOMEONE_ELSE }))))
      .toMatchObject({ effect: 'deny', reason_code: 'DENY_UNAUTHENTICATED' });
  });

  it('a key still reads while its company is in the read-only grace window, and nothing once the term has lapsed', () => {
    const grace = { state: 'active' as const, expires_at: new Date(NOW.getTime() - DAY), grace_until: new Date(NOW.getTime() + 13 * DAY) };
    const lapsed = { state: 'active' as const, expires_at: new Date(NOW.getTime() - 30 * DAY), grace_until: new Date(NOW.getTime() - DAY) };
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card(OWNER), { companyCard: grace })).effect).toBe('allow');
    // an Owner's own card may still export after the term lapsed; a key is nobody's Owner and gets nothing
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card(OWNER), { companyCard: lapsed })).effect).toBe('deny');
  });

  it('the restrictions on the maker\'s CARD (hours, networks, read-only, usage cap) do not apply to its key', () => {
    const restrictions = [
      { type: 'network_allowlist', enabled: true, config: { cidrs: ['192.0.2.0/24'] } },          // the request comes from 10.0.0.5
      { type: 'usage_cap', enabled: true, config: { limit_key: 'requests', window_seconds: 3600, max_count: 0 } },
    ];
    // the card itself is refused ...
    expect(decide(card(OWNER), 'knowledge:read', item(0), ctx('none', { restrictions }))).toMatchObject({ effect: 'deny', reason_code: 'DENY_CARD_NETWORK' });
    // ... its key is not, and is not asked to count against the card's usage cap
    const d = decide(key(['knowledge:read'], 3), 'knowledge:read', item(0), ctx(card(OWNER), { restrictions }));
    expect(d.effect).toBe('allow');
    expect(d.obligations.some((o) => o.type === 'count_usage')).toBe(false);
    expect(buildResourceFilterSpec(key(['knowledge:read'], 3), 'knowledge:read', ctx(card(OWNER), { restrictions })).nothing).toBe(false);
  });

  it('second-person rule: a key counts as its maker - it may not act on what its maker wrote', () => {
    const writtenBy = (person: string, cardId: string): ResourceRef => item(0, { not_by: { person_ids: [person], card_ids: [cardId] } });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', writtenBy(PERSON, SOMEONE_ELSE), ctx())).toMatchObject({ effect: 'deny', reason_code: 'DENY_SELF_REVIEW' });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', writtenBy(SOMEONE_ELSE, CARD), ctx())).toMatchObject({ effect: 'deny', reason_code: 'DENY_SELF_REVIEW' });
    expect(decide(key(['knowledge:read'], 3), 'knowledge:read', writtenBy(SOMEONE_ELSE, SOMEONE_ELSE), ctx()).effect).toBe('allow');
    // and no operation that verifies or approves is open to a key at all
    expect(decide(key(['knowledge:verify'], 3), 'knowledge:verify', item(0, { owner_person_id: SOMEONE_ELSE, author_person_id: SOMEONE_ELSE }), ctx()))
      .toMatchObject({ effect: 'deny', reason_code: 'DENY_API_KEY_SCOPE' });
  });

  it('a key that cannot be read is refused', () => {
    for (const bad of [{ scope: 'knowledge:read', max_sensitivity: 1 }, { scope: ['knowledge:read'], max_sensitivity: 9 }, { scope: ['knowledge:read'], max_sensitivity: '1' }]) {
      const broken = { ...key(['knowledge:read'], 1), ...bad } as unknown as ApiKeySubject;
      expect(decide(broken, 'knowledge:read', item(0), ctx()), JSON.stringify(bad)).toMatchObject({ effect: 'deny', reason_code: 'DENY_PDP_ERROR' });
    }
    // a subject of no known kind is nobody
    expect(decide({ ...key(['knowledge:read'], 1), kind: 'robot' } as unknown as ApiKeySubject, 'knowledge:read', item(0), ctx()))
      .toMatchObject({ effect: 'deny', reason_code: 'DENY_UNAUTHENTICATED' });
  });

  it('the filter handed to the AI service is narrowed the same way: no grant above the key\'s level, nothing outside its scope', () => {
    const spec = buildResourceFilterSpec(key(['knowledge:read'], 1), 'knowledge:read', ctx());
    expect(spec.nothing).not.toBe(true);
    expect(spec.any_of.every((grant) => grant.max_sensitivity <= 1)).toBe(true);
    expect(buildResourceFilterSpec(card(OWNER), 'knowledge:read', ctx('none')).any_of.some((grant) => grant.max_sensitivity === 3)).toBe(true);
    // outside the key's scope the filter matches nothing at all (it fails closed, it does not throw)
    expect(buildResourceFilterSpec(key(['knowledge:read'], 1), 'knowledge:ask', ctx())).toMatchObject({ nothing: true, any_of: [] });
    // "own things" of a key are its maker's own things
    expect(buildResourceFilterSpec(key(['knowledge:read'], 3), 'knowledge:read', ctx(card([role('expert')]))).any_of)
      .toEqual([{ scope: 'own', owner_card_id: CARD, owner_person_id: PERSON, max_sensitivity: 1 }]);
  });

  it('asking for what is not in the key counts against the KEY under the anomaly rule', () => {
    expect(COUNTED_REASONS.has('DENY_API_KEY_SCOPE')).toBe(true);
  });
});

describe('the maker\'s card must be able to act at all (else the key gets "sign-in required")', () => {
  it.each([
    ['a live card', {}, true],
    ['an expired card inside its grace window', { expires_at: new Date(NOW.getTime() - DAY), grace_until: new Date(NOW.getTime() + DAY) }, true],
    ['a locked card', { locked: true }, false],
    ['a suspended card', { card_state: 'suspended' as const }, false],
    ['a revoked card', { card_state: 'revoked' as const }, false],
    ['a card that was never activated', { activated_at: null }, false],
  ])('%s -> %s', (_name, over, can) => {
    expect(makerCanAct(card(OWNER, over), NOW)).toBe(can);
  });

  it('no card -> no', () => {
    expect(makerCanAct(null, NOW)).toBe(false);
  });
});

describe('which changes of the maker\'s card revoke its keys (in the same transaction, for good)', () => {
  it.each([
    ['its secret code is rotated (also by a renewal, and by an unlock with a new code)', 'sc_rotated', 'maker_code_rotated'],
    ['its sign-in factors are reset (also by an Owner recovery)', 'credentials_reset', 'maker_credentials_reset'],
    ['its roles change', 'privilege_change', 'maker_privilege_change'],
    ['it is replaced', 'card_replaced', 'maker_card_replaced'],
    ['it is revoked', 'card_revoked', 'maker_card_revoked'],
    ['it is suspended', 'card_suspended', 'maker_card_suspended'],
    ['it is locked (wrong secret codes, or an anomaly rule)', 'card_locked', 'maker_card_locked'],
  ])('%s', (_name, sessionReason, keyReason) => {
    expect(keyRevocationReason(sessionReason)).toBe(keyReason);
  });

  it.each(['logout', 'card_expired', 'admin', 'toString', '__proto__', ''])('not when the sessions end for "%s"', (sessionReason) => {
    expect(keyRevocationReason(sessionReason)).toBeNull();
  });

  it('every place that ends a card\'s sessions goes through the one function that also ends its keys', () => {
    const src = (file: string): string => readFileSync(path.join(here, 'src', 'modules', 'identity-access', 'internal', file), 'utf8');
    // the one function: sessions and keys together
    expect(src('sessions.ts')).toMatch(/export async function revokeSessionsForCard[\s\S]{0,1400}keyRevocationReason\(reason\)[\s\S]{0,200}revokeKeysOfCard\(/);
    // cards.ts reaches it only through CardService.revokeSessions (which tells the Owners), and for expiry
    const direct = [...src('cards.ts').matchAll(/await revokeSessionsForCard\(tx, card\.tenant_id, card\.id, ([^,]+),/g)].map((m) => m[1]);
    expect(direct.sort()).toEqual(["'card_expired'", 'reason']);
    expect([...src('cards.ts').matchAll(/await this\.revokeSessions\(tx, card, '([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([
      'card_locked', 'card_replaced', 'card_revoked', 'card_suspended', 'credentials_reset', 'credentials_reset', 'sc_rotated', 'sc_rotated',
    ]);
    // role changes go the same way; no other file ends all sessions of a card by itself
    expect(src('routes.ts')).not.toContain('revokeSessionsForCard(');
    expect([...src('routes.ts').matchAll(/cards\.revokeSessions\(tx, card, 'privilege_change'/g)]).toHaveLength(3);
    // removing one's own sign-in factor: only the sessions opened with it end, but through the same function - so the keys end
    expect(src('routes.ts')).toMatch(/cards\.revokeSessions\(tx, \{ id: subject\.card_id, tenant_id: subject\.tenant_id \}, 'credentials_reset', ctx\.now,\s*\{ openedWithCredentialId: params\.credential_id \}\)/);
    // ... and NO file but sessions.ts ends a session by itself. Read from every source file, so a new one cannot be
    // missed. The one exception deletes rows of sessions that ended or expired long ago (housekeeping).
    const enders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8').replace(/\s+/g, ' ');
          // "SET ... revoked_at =" before any WHERE (a WHERE that merely tests revoked_at ends nothing), or a DELETE
          for (const m of text.matchAll(/UPDATE sessions SET (?:(?!WHERE).){0,300}?revoked_at\s*=|DELETE FROM sessions/gi)) {
            enders.push(`${path.relative(path.join(here, 'src'), full).replaceAll('\\', '/')}: ${m[0].slice(0, 20)}`);
          }
        }
      }
    };
    walk(path.join(here, 'src'));
    expect(enders.sort()).toEqual([
      'cli/housekeeping.ts: DELETE FROM sessions',
      'modules/identity-access/internal/sessions.ts: UPDATE sessions SET ',      // revokeSessionsForCard
      'modules/identity-access/internal/sessions.ts: UPDATE sessions SET ',      // revokeSession: one session (signing out)
    ]);
    // the database lists the same reasons
    const migration = readFileSync(path.join(here, '..', '..', 'db', 'migrations', '20261005000100_api_keys.sql'), 'utf8');
    for (const reason of ['by_owner', 'maker_code_rotated', 'maker_credentials_reset', 'maker_privilege_change', 'maker_card_replaced', 'maker_card_revoked',
      'maker_card_suspended', 'maker_card_locked']) expect(migration, reason).toContain(`'${reason}'`);
  });
});

describe('how a request says who is asking', () => {
  const KEYED = { apiKey: true };
  const PLAIN = { apiKey: false };
  const token = formatApiKey(T1, KEY, SECRET);

  it('a session cookie is a session; nothing is nothing', () => {
    expect(credentialOf({}, 'v1.cookie', PLAIN)).toEqual({ kind: 'session', token: 'v1.cookie' });
    expect(credentialOf({}, undefined, KEYED)).toEqual({ kind: 'none' });
  });

  it('a key is a key only on an operation that takes keys', () => {
    expect(credentialOf({ authorization: `Bearer ${token}` }, undefined, KEYED)).toEqual({ kind: 'api_key', token });
    expect(credentialOf({ authorization: `Bearer ${token}` }, undefined, PLAIN)).toEqual({ kind: 'api_key_not_accepted' });
  });

  it('a key together with a session cookie is refused everywhere', () => {
    expect(credentialOf({ authorization: `Bearer ${token}` }, 'v1.cookie', KEYED)).toEqual({ kind: 'ambiguous' });
    expect(credentialOf({ authorization: `Bearer ${token}` }, 'v1.cookie', PLAIN)).toEqual({ kind: 'ambiguous' });
  });

  it.each(['Basic dXNlcjpwYXNz', 'Bearer some-proxy-token', 'bearer lak1.x', 'lak1.x', ''])(
    'an Authorization header that carries no key ("%s") is ignored: the session still works, and without one it is "nothing"', (authorization) => {
      expect(credentialOf({ authorization }, 'v1.cookie', PLAIN)).toEqual({ kind: 'session', token: 'v1.cookie' });
      expect(credentialOf({ authorization }, 'v1.cookie', KEYED)).toEqual({ kind: 'session', token: 'v1.cookie' });
      expect(credentialOf({ authorization }, undefined, KEYED)).toEqual({ kind: 'none' });
    });

  it('a header sent twice is not a key', () => {
    expect(credentialOf({ authorization: [`Bearer ${token}`, `Bearer ${token}`] }, undefined, KEYED)).toEqual({ kind: 'none' });
  });
});

describe('the contract says which operations take a key', () => {
  const withKey = [...contract.operations.values()].filter((op) => op.apiKey);

  it('exactly these ten - all of them reads, or asking - each with a permission from the short list, none of them public', () => {
    expect(withKey.map((op) => op.operationId).sort()).toEqual([
      'askKnowledge', 'getGapReport', 'getGraphNeighbourhood', 'getKnowledgeItem', 'getRoleTopics', 'getSource',
      'listJobRoles', 'listKnowledgeItems', 'listSources', 'listTopics',
    ]);
    for (const op of withKey) {
      expect(API_KEY_PERMISSIONS.has(op.permission as string), op.operationId).toBe(true);
      expect(op.isPublic, op.operationId).toBe(false);
      expect(op.method === 'GET' || op.operationId === 'askKnowledge', op.operationId).toBe(true);
    }
  });

  it('nothing that adds a document, and nothing that makes, lists or revokes keys, takes a key', () => {
    for (const id of ['createSource', 'uploadSourceContent', 'listApiKeys', 'getApiKeyOptions', 'createApiKey', 'revokeApiKey']) {
      expect(contract.operations.get(id)?.apiKey, id).toBe(false);
    }
  });

  it('a question may carry an Idempotency-Key (a retried question is answered once); it is not required', () => {
    const ask = contract.operations.get('askKnowledge');
    expect(ask?.validateIdempotencyKey).not.toBeNull();
    expect(ask?.idempotencyKeyRequired).toBe(false);
    expect(contract.operations.get('createApiKey')?.idempotencyKeyRequired).toBe(true);
  });
});
