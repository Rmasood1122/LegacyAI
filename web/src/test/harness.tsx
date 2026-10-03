// Test helpers: render a screen with a stand-in API (no network) and a fixed session.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiError, type Api } from '../api/client.ts';
import { ApiProvider } from '../api/context.tsx';
import { operations, type OperationId, type OperationTypes, type Session } from '../api/generated.ts';
import { StaticSessionProvider, type SessionContextValue } from '../session/session.tsx';

type Handler<K extends OperationId> = (args: { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; contentType?: string }) =>
  OperationTypes[K]['response'] | Promise<OperationTypes[K]['response']>;
export type Handlers = { [K in OperationId]?: Handler<K> };

/** A stand-in API: answers the operations it was given, records every call, fails loudly on any other. */
export class FakeApi implements Api {
  readonly calls: Array<{ operation: OperationId; args: { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; contentType?: string } }> = [];
  readonly #handlers: Handlers;
  constructor(handlers: Handlers) {
    this.#handlers = handlers;
  }
  call: Api['call'] = async (operation, ...args) => {
    const given = (args[0] ?? {}) as { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
    this.calls.push({ operation, args: given });
    const handler = this.#handlers[operation] as Handler<typeof operation> | undefined;
    if (handler === undefined) throw new Error(`the screen called "${operation}", which this test did not expect`);
    return handler(given);
  };
  callsTo(operation: OperationId) {
    return this.calls.filter((c) => c.operation === operation).map((c) => c.args);
  }
}

export const problem = (status: number, title: string, kind: ApiError['kind'] = 'conflict'): ApiError =>
  new ApiError(kind, status, title, { type: 'urn:legacyai:problem:test', request_id: 'req-test-1' });

export function makeSession(permissions: string[], overrides: Partial<Session> = {}): Session {
  return {
    card_id: '01a10174-0000-7000-8000-000000000001', tenant_id: '01a10174-0000-7000-8000-0000000000aa', card_number_masked: 'LGY-••••-••••-4242',
    roles: ['expert'], permissions, card_state: 'active', read_only: false, export_only: false,
    expires_at: '2099-01-01T00:00:00.000Z', grace_until: '2099-02-01T00:00:00.000Z', renewal_due: '2098-12-01T00:00:00.000Z',
    session_idle_expires_at: '2099-01-01T00:00:00.000Z', session_absolute_expires_at: '2099-01-01T00:00:00.000Z', csrf_token: 'csrf-test-token',
    ...overrides,
  };
}

/** The permissions of the operations named: what a card needs to use exactly these. */
export const permissionsFor = (...ops: OperationId[]): string[] => [...new Set(ops.map((o) => operations[o].permission).filter((p): p is NonNullable<typeof p> => p !== null))];

export function sessionValue(session: Session | null, spies: Partial<Pick<SessionContextValue, 'signedIn' | 'signOut'>> = {}): SessionContextValue {
  return {
    state: session === null ? { status: 'signed_out' } : { status: 'signed_in', session },
    signedIn: spies.signedIn ?? (() => undefined),
    signOut: spies.signOut ?? (async () => undefined),
    can: (operation) => {
      const needed = operations[operation].permission;
      return session !== null && (needed === null || session.permissions.includes(needed));
    },
  };
}

export interface RenderOptions {
  api?: FakeApi;
  session?: SessionContextValue;
  /** The address the screen is shown at, and the route pattern it is mounted on. */
  at?: string;
  route?: string;
}

export function renderScreen(ui: ReactElement, options: RenderOptions = {}): RenderResult & { api: FakeApi } {
  const api = options.api ?? new FakeApi({});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <ApiProvider api={api}>
        <StaticSessionProvider value={options.session ?? sessionValue(makeSession([]))}>
          <MemoryRouter initialEntries={[options.at ?? '/']}>
            <Routes>
              <Route path={options.route ?? '*'} element={ui} />
              <Route path="*" element={<p>other screen</p>} />
            </Routes>
          </MemoryRouter>
        </StaticSessionProvider>
      </ApiProvider>
    </QueryClientProvider>,
  );
  return Object.assign(result, { api });
}
