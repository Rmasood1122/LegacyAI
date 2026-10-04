// API keys on the screen (feature 28). Synthetic data only; the key texts below are made-up strings, not keys.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ApiKey, ApiKeyCreated, ApiKeyOptions, NewApiKeyRequest } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { ApiKeysScreen } from './apikeys/ApiKeysScreen.tsx';
import { emptyForm, highestLevel, parseKeyForm, PERMISSION_TEXT } from './apikeys/hooks.ts';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-01T09:00:00.000Z';
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const OWNER = ['listApiKeys', 'getApiKeyOptions', 'createApiKey', 'revokeApiKey'] as const;
const LIMITS: ApiKeyOptions['limits'] = { max_expires_in_days: 366, requests_per_minute: 120, default_asks_per_hour: 30, max_asks_per_hour: 600 };
const OPTIONS: ApiKeyOptions = { grantable: [{ permission: 'knowledge:read', max_sensitivity: 3 }, { permission: 'topic:read', max_sensitivity: 1 }], limits: LIMITS };
const SHOWN_ONCE = 'synthetic-key-text-shown-once';

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: ID(70), name: 'Intranet search', created_by_card_id: ID(1), secret_hint: 'Zx9Q', scope: ['knowledge:read'], max_sensitivity: 1, asks_per_hour: 30,
  allowed_cidrs: null, status: 'active', created_at: T, expires_at: '2026-12-30T09:00:00.000Z', last_used_at: null, revoked_at: null, revoked_reason: null, ...over,
});
const list = (items: ApiKey[]) => ({ items, next_cursor: null });

describe('the form, as a function', () => {
  const EMPTY = emptyForm(LIMITS);
  const form = (over: Partial<typeof EMPTY> = {}) => ({ ...EMPTY, name: 'Search', scope: new Set(['knowledge:read'] as const), ...over });

  it('a key can be given reading and asking only: adding documents is not among the choices', () => {
    expect(Object.keys(PERMISSION_TEXT).sort()).toEqual(['gap:read', 'knowledge:ask', 'knowledge:read', 'source:read', 'topic:read']);
  });

  it('a key may reach no level above the lowest of its maker\'s levels for what it names', () => {
    expect(highestLevel(new Set(['knowledge:read']), OPTIONS.grantable)).toBe(3);
    expect(highestLevel(new Set(['knowledge:read', 'topic:read']), OPTIONS.grantable)).toBe(1);
    expect(highestLevel(new Set(), OPTIONS.grantable)).toBe(0);
  });

  it('turns a filled form into the request, with the questions per hour', () => {
    expect(parseKeyForm(form({ level: '2', days: ' 30 ', asks: '5', networks: '203.0.113.0/24, 198.51.100.7' }), OPTIONS)).toEqual({
      ok: true,
      body: { name: 'Search', scope: ['knowledge:read'], max_sensitivity: 2, expires_in_days: 30, asks_per_hour: 5, allowed_cidrs: ['203.0.113.0/24', '198.51.100.7'] },
    });
    expect(parseKeyForm(form(), OPTIONS)).toEqual({
      ok: true, body: { name: 'Search', scope: ['knowledge:read'], max_sensitivity: 0, expires_in_days: 90, asks_per_hour: 30 },
    });
  });

  it('says what is wrong: no name, nothing chosen, a level above the maker\'s, a validity or a question limit outside the API\'s bounds', () => {
    expect(parseKeyForm(EMPTY, OPTIONS)).toMatchObject({ ok: false, problems: { name: expect.any(String), scope: expect.any(String) } });
    expect(parseKeyForm(form({ scope: new Set(['knowledge:read', 'topic:read'] as const), level: '2' }), OPTIONS)).toMatchObject({ ok: false, problems: { level: expect.any(String) } });
    for (const days of ['', '0', '367', '1.5', 'ten']) expect(parseKeyForm(form({ days }), OPTIONS), days).toMatchObject({ ok: false, problems: { days: expect.any(String) } });
    for (const asks of ['', '0', '601', '2.5', 'many']) expect(parseKeyForm(form({ asks }), OPTIONS), asks).toMatchObject({ ok: false, problems: { asks: expect.any(String) } });
    // a permission the maker does not hold is dropped, never sent
    expect(parseKeyForm(form({ scope: new Set(['gap:read'] as const) }), OPTIONS)).toMatchObject({ ok: false, problems: { scope: expect.any(String) } });
  });
});

describe('the API keys screen', () => {
  it('makes a key: offers only what this card could put into it, shows the key once, keeps it while the list is read again, and forgets it when told', async () => {
    const user = userEvent.setup();
    const made: ApiKey[] = [];
    let holdList: Promise<void> | null = null;
    let releaseList = (): void => undefined;
    const api = new FakeApi({
      getApiKeyOptions: () => OPTIONS,
      listApiKeys: async () => {
        if (holdList !== null) await holdList;       // the re-read after making a key is kept waiting by the test
        return list([...made]);
      },
      createApiKey: (args) => {
        const body = args.body as NewApiKeyRequest;
        const k = key({ name: body.name, scope: body.scope, max_sensitivity: body.max_sensitivity as ApiKey['max_sensitivity'], asks_per_hour: body.asks_per_hour ?? 30 });
        made.push(k);
        holdList = new Promise((resolve) => { releaseList = resolve; });
        return { ...k, api_key: SHOWN_ONCE, secret_already_shown: false } satisfies ApiKeyCreated;
      },
    });
    renderScreen(<ApiKeysScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('No key has been made yet.')).toBeTruthy();
    expect(await screen.findByRole('checkbox', { name: 'Read knowledge items and the knowledge map' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Read topics and job roles' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Read the gap report' })).toBeNull();       // this card does not hold it

    // nothing filled in: nothing is sent, the problems are said in words
    await user.click(screen.getByRole('button', { name: 'Make the key' }));
    expect(api.callsTo('createApiKey')).toEqual([]);
    expect(screen.getByText('Choose at least one thing the key may do.')).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Intranet search');
    await user.click(screen.getByRole('checkbox', { name: 'Read topics and job roles' }));
    // topics are held at level 1, so levels 2 and 3 are not offered
    expect(within(screen.getByRole('combobox', { name: 'Highest level the key reads' })).getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Make the key' }));

    // the key is on the screen while the list is still being read again ...
    expect((await screen.findByTestId('shown-once')).textContent).toBe(SHOWN_ONCE);
    expect(api.callsTo('createApiKey')).toEqual([{ body: { name: 'Intranet search', scope: ['topic:read'], max_sensitivity: 0, expires_in_days: 90, asks_per_hour: 30 } }]);
    await waitFor(() => expect(api.callsTo('listApiKeys').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId('shown-once').textContent).toBe(SHOWN_ONCE);
    // ... and still there after the list has arrived
    releaseList();
    expect(await screen.findByRole('cell', { name: 'Intranet search' })).toBeTruthy();
    expect(screen.getByTestId('shown-once').textContent).toBe(SHOWN_ONCE);
    expect(screen.queryByRole('button', { name: 'Make the key' })).toBeNull();          // no second key while this one is unread

    await user.click(screen.getByRole('button', { name: 'I have copied the key' }));
    expect(screen.queryByTestId('shown-once')).toBeNull();
    expect(document.body.textContent).not.toContain(SHOWN_ONCE);
    expect(await screen.findByRole('button', { name: 'Make the key' })).toBeTruthy();
  });

  it('a repeated request does not show the key again, and says so', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getApiKeyOptions: () => OPTIONS,
      listApiKeys: () => list([]),
      createApiKey: () => ({ ...key(), secret_already_shown: true }) satisfies ApiKeyCreated,
    });
    renderScreen(<ApiKeysScreen />, { api, session: as(...OWNER) });
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Again');
    await user.click(screen.getByRole('checkbox', { name: 'Read topics and job roles' }));
    await user.click(screen.getByRole('button', { name: 'Make the key' }));
    expect(await screen.findByText(/It cannot be shown a second time\./)).toBeTruthy();
    expect(screen.queryByTestId('shown-once')).toBeNull();
  });

  it('lists keys with their state in words and why a key ended; revoking asks twice; a refusal by the API is shown', async () => {
    const user = userEvent.setup();
    let fail = true;
    let revoked = false;
    const api = new FakeApi({
      getApiKeyOptions: () => OPTIONS,
      listApiKeys: () => list([
        key({ status: revoked ? 'revoked' : 'active', revoked_at: revoked ? T : null, revoked_reason: revoked ? 'by_owner' : null, allowed_cidrs: ['203.0.113.0/24'] }),
        key({ id: ID(71), name: 'Old importer', status: 'suspended', secret_hint: 'aB3_' }),
        key({ id: ID(72), name: 'Ended with its maker', status: 'revoked', revoked_at: T, revoked_reason: 'maker_code_rotated' }),
      ]),
      revokeApiKey: () => {
        if (fail) throw problem(409, 'Try again');
        revoked = true;
        return key({ status: 'revoked', revoked_at: T, revoked_reason: 'by_owner' });
      },
    });
    renderScreen(<ApiKeysScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('Working')).toBeTruthy();
    expect(screen.getByText('Suspended after too many refused requests')).toBeTruthy();
    expect(screen.getByText(/its maker’s 3-digit code was changed/)).toBeTruthy();
    expect(screen.getByText(/only from 203\.0\.113\.0\/24/)).toBeTruthy();
    expect(screen.getByText('…aB3_')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Revoke Intranet search…' }));
    expect(api.callsTo('revokeApiKey')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, revoke it for good' }));
    expect(await screen.findByText('Try again')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Revoke Intranet search…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, revoke it for good' }));
    expect(await screen.findByText(/revoked by an owner/)).toBeTruthy();
    expect(api.callsTo('revokeApiKey')).toEqual([{ path: { api_key_id: ID(70) } }, { path: { api_key_id: ID(70) } }]);
    expect(screen.queryByRole('button', { name: 'Revoke Intranet search…' })).toBeNull();   // a revoked key has no button
  });

  it('a card that may only list keys gets neither the form nor a revoke button, and what a key may carry is not even asked for', async () => {
    const api = new FakeApi({ listApiKeys: () => list([key()]) });
    renderScreen(<ApiKeysScreen />, { api, session: as('listApiKeys') });
    expect(await screen.findByRole('cell', { name: 'Intranet search' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make the key' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revoke / })).toBeNull();
    expect(api.callsTo('getApiKeyOptions')).toEqual([]);
  });
});
