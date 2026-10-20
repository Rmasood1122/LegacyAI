// Webhooks on the screen (feature 28, part B). Synthetic data only; the secret below is a made-up string, not a secret.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WebhookDelivery, WebhookEndpoint, WebhookEndpointWithSecret, WebhookOptions } from '../api/generated.ts';
import { FakeApi, makeSession, permissionsFor, problem, renderScreen, sessionValue } from '../test/harness.tsx';
import { emptyEndpointForm, parseEndpointForm } from './webhooks/hooks.ts';
import { WebhooksScreen } from './webhooks/WebhooksScreen.tsx';

const ID = (n: number): string => `01a10174-0000-7000-8000-${String(n).padStart(12, '0')}`;
const T = '2026-10-06T09:00:00.000Z';
const as = (...ops: Parameters<typeof permissionsFor>) => sessionValue(makeSession(permissionsFor(...ops)));
const OWNER = ['listWebhookEndpoints', 'getWebhookOptions', 'createWebhookEndpoint', 'updateWebhookEndpoint', 'removeWebhookEndpoint', 'rotateWebhookSecret',
  'sendWebhookTest', 'listWebhookDeliveries'] as const;
const OPTIONS = (delivery = true): WebhookOptions => ({
  topics: [
    { topic: 'knowledge.item_released', description: 'A knowledge item became verified' },
    { topic: 'knowledge.item_changed', description: 'A verified knowledge item changed' },
    { topic: 'knowledge.item_withdrawn', description: 'A verified knowledge item stopped being usable' },
  ],
  delivery_enabled: delivery,
  limits: { max_endpoints: 10, max_attempts: 8, timeout_seconds: 5, pause_after_failures: 15 },
});
const SECRET = 'whsec_synthetic-secret-text-shown-once';

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  id: ID(80), name: 'Search index', url: 'https://hooks.example.com/legacyai', topics: ['knowledge.item_released'], max_sensitivity: 1, status: 'active',
  paused_reason: null, consecutive_failures: 0, secret_hint: 'Qx9=', last_success_at: null, last_failure_at: null, created_by_card_id: ID(1),
  created_at: T, updated_at: T, removed_at: null, ...over,
});
const delivery = (over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id: ID(90), event_id: ID(91), topic: 'knowledge.item_released', status: 'delivered', attempts: 1, next_attempt_at: null, last_attempt_at: T,
  last_status_code: 204, last_error: null, delivered_at: T, created_at: T, ...over,
});
const list = <X,>(items: X[]) => ({ items, next_cursor: null });

describe('the form, as a function', () => {
  const form = (over: Partial<ReturnType<typeof emptyEndpointForm>> = {}) =>
    ({ ...emptyEndpointForm(), name: 'Search', url: 'https://hooks.example.com/x', topics: new Set(['knowledge.item_released'] as const), ...over });

  it('turns a filled form into the request', () => {
    expect(parseEndpointForm(form({ level: '2', url: '  https://hooks.example.com/x  ' }))).toEqual({
      ok: true, body: { name: 'Search', url: 'https://hooks.example.com/x', topics: ['knowledge.item_released'], max_sensitivity: 2 },
    });
  });

  it('says what is wrong: no name, an address that is not https or names no host, no event', () => {
    expect(parseEndpointForm(emptyEndpointForm())).toMatchObject({ ok: false, problems: { name: expect.any(String), url: expect.any(String), topics: expect.any(String) } });
    for (const url of ['http://hooks.example.com/x', 'https://', 'https://intranet/x', 'hooks.example.com']) {
      expect(parseEndpointForm(form({ url })), url).toMatchObject({ ok: false, problems: { url: expect.any(String) } });
    }
  });
});

describe('the webhooks screen', () => {
  it('registers an endpoint and shows its signing secret once, until told it was copied', async () => {
    const user = userEvent.setup();
    const made: WebhookEndpoint[] = [];
    const api = new FakeApi({
      getWebhookOptions: () => OPTIONS(),
      listWebhookEndpoints: () => list([...made]),
      createWebhookEndpoint: (args) => {
        const e = endpoint({ name: (args.body as { name: string }).name });
        made.push(e);
        return { ...e, signing_secret: SECRET, secret_already_shown: false } satisfies WebhookEndpointWithSecret;
      },
    });
    renderScreen(<WebhooksScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('No endpoint has been registered yet.')).toBeTruthy();
    expect(screen.queryByText('This server sends no webhooks yet')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Register the endpoint' }));
    expect(api.callsTo('createWebhookEndpoint')).toEqual([]);
    expect(screen.getByText('Choose at least one event.')).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Search index');
    await user.type(screen.getByRole('textbox', { name: 'Address' }), 'hooks.example.com/legacyai');
    await user.click(screen.getByRole('checkbox', { name: 'A knowledge item became verified' }));
    await user.click(screen.getByRole('button', { name: 'Register the endpoint' }));
    expect((await screen.findByTestId('shown-once')).textContent).toBe(SECRET);
    expect(api.callsTo('createWebhookEndpoint')).toEqual([{ body: { name: 'Search index', url: 'https://hooks.example.com/legacyai', topics: ['knowledge.item_released'], max_sensitivity: 0 } }]);
    expect(await screen.findByRole('cell', { name: 'Search index' })).toBeTruthy();
    expect(screen.getByTestId('shown-once').textContent).toBe(SECRET);
    await user.click(screen.getByRole('button', { name: 'I have copied the secret' }));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('says plainly when the server sends nothing', async () => {
    const api = new FakeApi({ getWebhookOptions: () => OPTIONS(false), listWebhookEndpoints: () => list([]) });
    renderScreen(<WebhooksScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('This server sends no webhooks yet')).toBeTruthy();
  });

  it('shows a paused endpoint in words, switches it on, queues a test message, lists its messages, and removes it after asking twice', async () => {
    const user = userEvent.setup();
    let state: WebhookEndpoint = endpoint({ status: 'paused', paused_reason: 'failing', consecutive_failures: 15 });
    let fail = true;
    const api = new FakeApi({
      getWebhookOptions: () => OPTIONS(),
      listWebhookEndpoints: () => list(state.status === 'removed' ? [] : [state]),
      updateWebhookEndpoint: () => {
        state = endpoint();
        return state;
      },
      sendWebhookTest: () => delivery({ topic: 'webhook.test', status: 'pending', attempts: 0, next_attempt_at: T, last_attempt_at: null, last_status_code: null, delivered_at: null }),
      listWebhookDeliveries: () => list([delivery(), delivery({ id: ID(92), status: 'pending', attempts: 2, last_error: 'http_status', last_status_code: 503, delivered_at: null, next_attempt_at: T })]),
      removeWebhookEndpoint: () => {
        if (fail) throw problem(409, 'Try again');
        state = endpoint({ status: 'removed', removed_at: T, secret_hint: null });
        return state;
      },
    });
    renderScreen(<WebhooksScreen />, { api, session: as(...OWNER) });
    expect(await screen.findByText('Paused: deliveries kept failing')).toBeTruthy();
    expect(screen.getByText(/15 failed in a row/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send a test message to Search index' })).toBeNull();   // not while paused

    await user.click(screen.getByRole('button', { name: 'Switch on Search index' }));
    expect(api.callsTo('updateWebhookEndpoint')).toEqual([{ path: { webhook_id: ID(80) }, body: { enabled: true } }]);
    expect(await screen.findByText('Sending')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Send a test message to Search index' }));
    expect(await screen.findByText(/The test message is queued/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Messages of Search index' }));
    expect(await screen.findByText('Delivered')).toBeTruthy();
    expect(screen.getByText(/the receiver answered with an error, status 503/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove Search index…' }));
    expect(api.callsTo('removeWebhookEndpoint')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Yes, remove it for good' }));
    expect(await screen.findByText('Try again')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Remove Search index…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove it for good' }));
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Search index' })).toBeNull());
  });

  it('a new secret is asked for twice and shown once', async () => {
    const user = userEvent.setup();
    const api = new FakeApi({
      getWebhookOptions: () => OPTIONS(),
      listWebhookEndpoints: () => list([endpoint()]),
      rotateWebhookSecret: () => ({ ...endpoint({ secret_hint: 'once' }), signing_secret: SECRET, secret_already_shown: false }),
    });
    renderScreen(<WebhooksScreen />, { api, session: as(...OWNER) });
    await user.click(await screen.findByRole('button', { name: 'New secret for Search index…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, the old secret stops at once' }));
    expect((await screen.findByTestId('shown-once')).textContent).toBe(SECRET);
  });

  it('a card that may only list endpoints gets no form and no buttons that change anything', async () => {
    const api = new FakeApi({ listWebhookEndpoints: () => list([endpoint()]), getWebhookOptions: () => OPTIONS() });
    renderScreen(<WebhooksScreen />, { api, session: as('listWebhookEndpoints', 'getWebhookOptions') });
    expect(await screen.findByRole('cell', { name: 'Search index' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Register the endpoint' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Switch|Remove|New secret|Send a test)/ })).toBeNull();
  });
});
