// The frame: who sees which menu entries and screens, and what a signed-out visitor gets.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api/client.ts';
import { ApiProvider } from './api/context.tsx';
import { operations, type OperationId } from './api/generated.ts';
import { App } from './App.tsx';
import { SCREENS } from './screens.tsx';
import { SessionLostSignal, SessionProvider, StaticSessionProvider, type SessionContextValue } from './session/session.tsx';
import { FakeApi, makeSession, permissionsFor, sessionValue } from './test/harness.tsx';

const empty = { items: [], next_cursor: null };
const quietApi = () => new FakeApi({ listReviewTasks: () => empty, listExpertQuestions: () => empty, listKnowledgeItems: () => empty, listSources: () => empty, listMyConsents: () => empty });

function show(session: SessionContextValue, at = '/', api = quietApi()) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApiProvider api={api}>
        <StaticSessionProvider value={session}>
          <MemoryRouter initialEntries={[at]}><App /></MemoryRouter>
        </StaticSessionProvider>
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
    show(sessionValue(makeSession(permissionsFor('listConsents', 'listMyConsents'))), '/consents');
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
  const mount = (api: FakeApi, lost = new SessionLostSignal()) => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiProvider api={api}>
          <SessionProvider sessionLost={lost}><MemoryRouter><App /></MemoryRouter></SessionProvider>
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
});
