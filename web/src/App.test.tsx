// The frame: who sees which menu entries and screens, and what a signed-out visitor gets.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client.ts';
import { ApiProvider } from './api/context.tsx';
import { operations, type OperationId } from './api/generated.ts';
import { App } from './App.tsx';
import { SCREENS } from './screens.tsx';
import { SessionLostSignal, SessionProvider, StaticSessionProvider, type SessionContextValue } from './session/session.tsx';
import { OfflineProvider } from './offline/context.tsx';
import { FakeApi, makeSession, memoryOfflineStore, permissionsFor, sessionValue } from './test/harness.tsx';

const empty = { items: [], next_cursor: null };
const quietApi = () => new FakeApi({ listReviewTasks: () => empty, listExpertQuestions: () => empty, listKnowledgeItems: () => empty, listSources: () => empty, listMyConsents: () => empty });

function show(session: SessionContextValue, at = '/', api = quietApi()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApiProvider api={api}>
        <OfflineProvider store={memoryOfflineStore().store}>
          <StaticSessionProvider value={session}>
            <MemoryRouter initialEntries={[at]}><App /></MemoryRouter>
          </StaticSessionProvider>
        </OfflineProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
  return api;
}
const menu = (): string[] => screen.getAllByRole('link').filter((a) => a.closest('nav') !== null).map((a) => a.textContent ?? '');

describe('the frame', () => {
  it('a signed-out visitor gets the sign-in screen at any address, and the set-up screen at /set-up', () => {
    show(sessionValue(null), '/knowledge');
    expect(screen.getByRole('heading', { name: 'Sign in to LegacyAI' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('the menu lists only the screens the card may use', () => {
    show(sessionValue(makeSession(permissionsFor('askKnowledge', 'listMyConsents'))));
    expect(menu()).toEqual(['Home', 'Ask', 'My consent']);
  });

  it('the right to read consents alone (experts and successors have it for their own records) does not offer the company consent screen', () => {
    // listPeople too: these roles may read their own person, which is why that right cannot be the second condition
    show(sessionValue(makeSession(permissionsFor('listConsents', 'listMyConsents', 'listPeople'))), '/consents');
    expect(menu()).toEqual(['Home', 'My consent']);
    expect(screen.queryByRole('navigation', { name: 'Manage' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'This screen is not available' })).toBeTruthy();
  });

  it('a screen the card may not use is not reachable by typing its address', () => {
    const api = show(sessionValue(makeSession(permissionsFor('askKnowledge'))), '/review');
    expect(screen.getByRole('heading', { name: 'This screen is not available' })).toBeTruthy();
    expect(api.callsTo('listReviewTasks')).toHaveLength(0);
  });

  it('a card with every permission sees every screen in the menu', () => {
    const all = [...new Set(Object.values(operations).map((o) => o.permission).filter((p): p is NonNullable<typeof p> => p !== null))];
    show(sessionValue(makeSession(all)));
    expect(menu()).toEqual(SCREENS.filter((s) => s.label !== undefined).map((s) => s.label));
  });

  it('every screen names an operation that exists and needs a permission', () => {
    for (const s of SCREENS) {
      for (const needed of [s.requiredOperation, ...(s.alsoRequires ?? [])]) {
        if (needed === undefined) continue;
        expect(operations[needed as OperationId].permission, s.path).not.toBeNull();
      }
    }
  });

  it('shows the read-only notice during the grace period, and signs out', async () => {
    const user = userEvent.setup();
    const signOut = vi.fn(async () => undefined);
    show(sessionValue(makeSession([], { read_only: true }), { signOut }));
    expect(screen.getByText('This card is read-only')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
  });
});

describe('SessionProvider', () => {
  const mount = (api: FakeApi, lost = new SessionLostSignal(), offline = memoryOfflineStore().store) => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiProvider api={api}>
          <OfflineProvider store={offline}>
            <SessionProvider sessionLost={lost}><MemoryRouter><App /></MemoryRouter></SessionProvider>
          </OfflineProvider>
        </ApiProvider>
      </QueryClientProvider>,
    );
    return lost;
  };

  it('asks the API who is signed in; "nobody" shows sign-in', async () => {
    mount(new FakeApi({ getSession: () => { throw new ApiError('unauthenticated', 401, 'Not signed in'); } }));
    expect(await screen.findByRole('heading', { name: 'Sign in to LegacyAI' })).toBeTruthy();
  });

  it('shows the application for a live session and drops back to sign-in when the session is lost', async () => {
    const lost = mount(new FakeApi({ getSession: () => makeSession(permissionsFor('askKnowledge')) }));
    expect(await screen.findByRole('navigation')).toBeTruthy();
    lost.emit();
    expect(await screen.findByRole('heading', { name: 'Sign in to LegacyAI' })).toBeTruthy();
  });

  it('an unreachable API is reported as such, not as "signed out"', async () => {
    mount(new FakeApi({ getSession: () => { throw new ApiError('network', 0, 'The service could not be reached.'); } }));
    expect(await screen.findByText('LegacyAI could not be reached')).toBeTruthy();
  });

  // Offline reading (feature 9, D42): the copy kept on this device is shown only while the API cannot be reached, and
  // removed as soon as the API says nobody, or another card, is signed in.
  describe('the offline copy on this device', () => {
    const AS_OF = Date.parse('2026-10-27T10:00:00Z');
    const CARD = makeSession([]).card_id;
    const pack = {
      job_role: 'Boiler operator', as_of: new Date(AS_OF).toISOString(), expires_at: new Date(AS_OF + 7 * 86_400_000).toISOString(), max_sensitivity: 1 as const,
      topics: [{ topic_id: 't1', name: 'Relief valves' }], truncated: false,
      items: [{ id: 'i1', title: 'Relief valve check', body: 'Lift the lever monthly.', status: 'verified' as const, sensitivity: 0, verified_at: null, topic_ids: ['t1'] }],
    };
    const kept = async (now = AS_OF + 3_600_000, card = CARD) => {
      const offline = memoryOfflineStore({ now });
      await offline.store.save(card, pack);
      return offline;
    };
    const unreachable = () => new FakeApi({ getSession: () => { throw new ApiError('network', 0, 'The service could not be reached.'); } });

    it('without the API, the copy is shown with its "as of" date, and kept', async () => {
      const offline = await kept();
      mount(unreachable(), undefined, offline.store);
      expect(await screen.findByRole('heading', { name: 'Offline reading' })).toBeTruthy();
      expect(screen.getByText('LegacyAI could not be reached')).toBeTruthy();
      expect(screen.getByText(/^As of /)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Relief valve check' }));
      expect(screen.getByText('Lift the lever monthly.')).toBeTruthy();
      expect(screen.getByText(/^As of /)).toBeTruthy();   // on the item too
      expect(offline.storage.record).not.toBeNull();
    });

    it('without the API, an expired copy is refused and removed', async () => {
      const offline = await kept();
      offline.clock.now = AS_OF + 7 * 86_400_000;
      mount(unreachable(), undefined, offline.store);
      expect(await screen.findByText('The copy on this device has expired')).toBeTruthy();
      expect(screen.queryByText('Relief valve check')).toBeNull();
      expect(offline.storage.record).toBeNull();
    });

    it('when the API says nobody is signed in, the copy is removed', async () => {
      const offline = await kept();
      mount(new FakeApi({ getSession: () => { throw new ApiError('unauthenticated', 401, 'Not signed in'); } }), undefined, offline.store);
      expect(await screen.findByRole('heading', { name: 'Sign in to LegacyAI' })).toBeTruthy();
      await vi.waitFor(() => expect(offline.storage.record).toBeNull());
    });

    it('a copy taken by another card is removed when a card signs in; the same card keeps its copy', async () => {
      const other = await kept(undefined, '01a10174-0000-7000-8000-0000000000ff');
      mount(new FakeApi({ getSession: () => makeSession(permissionsFor('askKnowledge')) }), undefined, other.store);
      expect(await screen.findByRole('navigation')).toBeTruthy();
      await vi.waitFor(() => expect(other.storage.record).toBeNull());
      cleanup();
      const same = await kept();
      mount(new FakeApi({ getSession: () => makeSession(permissionsFor('askKnowledge')) }), undefined, same.store);
      expect(await screen.findByRole('navigation')).toBeTruthy();
      await new Promise((r) => setTimeout(r, 50));
      expect(same.storage.record).not.toBeNull();
    });
  });
});
