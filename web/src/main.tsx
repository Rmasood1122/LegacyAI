// Composition root: the only place that knows about the browser's fetch and wires the pieces together.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ApiClient } from './api/client.ts';
import { ApiProvider } from './api/context.tsx';
import { App } from './App.tsx';
import { OfflineProvider } from './offline/context.tsx';
import { IndexedDbPackStorage } from './offline/storage.ts';
import { OfflineStore } from './offline/store.ts';
import { SessionLostSignal, SessionProvider } from './session/session.tsx';
import './styles/base.css';

const sessionLost = new SessionLostSignal();
const api = new ApiClient({ fetch: (input, init) => window.fetch(input, init), onSessionLost: () => sessionLost.emit() });
// Data is never kept after the tab closes, and a failed request is not silently repeated. The answer
// of a change (it can hold one-time card secrets) is dropped as soon as no screen shows it (gcTime 0).
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 }, mutations: { retry: false, gcTime: 0 } } });

// The offline copy (feature 9): locked with a key the browser keeps and will not give out, opened only within its 7 days.
const offline = new OfflineStore({
  storage: new IndexedDbPackStorage(),
  subtle: window.crypto.subtle,
  randomBytes: (length) => window.crypto.getRandomValues(new Uint8Array(length)),
  now: () => Date.now(),
});
// The service worker keeps the application's own files (never any data from /v1) so it opens without a connection.
// It exists in the built application only (the development server has no /sw.js; registering there simply fails).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <OfflineProvider store={offline}>
          <SessionProvider sessionLost={sessionLost}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </SessionProvider>
        </OfflineProvider>
      </ApiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
