// Hands the offline store (made by the composition root, main.tsx) to the screens.
import { createContext, useContext, type ReactNode } from 'react';
import type { OfflineStore } from './store.ts';

const OfflineContext = createContext<OfflineStore | null>(null);

export function OfflineProvider({ store, children }: { store: OfflineStore; children: ReactNode }) {
  return <OfflineContext.Provider value={store}>{children}</OfflineContext.Provider>;
}

export function useOfflineStore(): OfflineStore {
  const store = useContext(OfflineContext);
  if (store === null) throw new Error('useOfflineStore must be used inside <OfflineProvider>');
  return store;
}
