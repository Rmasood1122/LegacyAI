// Who is signed in, and what their card may do.
//
// The permission list comes from the API with the session. The screens use it ONLY to decide what
// to show (no link to a screen the card cannot use). It grants nothing: every request is checked
// again by the API, which stays the authority.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { useApi } from '../api/context.tsx';
import { operations, type OperationId, type Session } from '../api/generated.ts';

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; session: Session }
  | { status: 'error'; message: string };

export interface SessionContextValue {
  state: SessionState;
  /** Called by the sign-in screen with the session the API returned. */
  signedIn(session: Session): void;
  signOut(): Promise<void>;
  /** True if the card holds the permission the contract names for this operation. */
  can(operation: OperationId): boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/** Lets the API client (created before React starts) tell the session it has ended. */
export class SessionLostSignal {
  readonly #listeners = new Set<() => void>();
  /** Adds a listener; the returned function removes it again. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

export function SessionProvider({ sessionLost, children }: { sessionLost: SessionLostSignal; children: ReactNode }) {
  const api = useApi();
  const cache = useQueryClient();
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    api.call('getSession').then(
      (session) => {
        if (current) setState({ status: 'signed_in', session });
      },
      (err: unknown) => {
        if (!current) return;
        if (err instanceof ApiError && err.kind === 'unauthenticated') setState({ status: 'signed_out' });
        else setState({ status: 'error', message: err instanceof Error ? err.message : 'The service could not be reached.' });
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  // Whatever was loaded belongs to the card that was signed in: drop it when the session ends.
  const clear = useCallback(() => {
    cache.clear();
    setState({ status: 'signed_out' });
  }, [cache]);
  useEffect(() => sessionLost.subscribe(clear), [sessionLost, clear]);

  const value = useMemo<SessionContextValue>(() => ({
    state,
    signedIn: (session) => {
      cache.clear();
      setState({ status: 'signed_in', session });
    },
    signOut: async () => {
      try {
        await api.call('logout');
      } finally {
        clear();
      }
    },
    can: (operation) => {
      if (state.status !== 'signed_in') return false;
      const needed = operations[operation].permission;
      return needed === null || state.session.permissions.includes(needed);
    },
  }), [state, api, cache, clear]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/** For tests and stories: a fixed session without any network. */
export function StaticSessionProvider({ value, children }: { value: SessionContextValue; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
