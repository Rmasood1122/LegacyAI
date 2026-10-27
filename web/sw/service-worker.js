// The service worker (feature 9, decision D42): keeps the application's OWN files - the page, its scripts, styles and
// icons, listed by the build - so the application opens without a connection. It never keeps or answers anything under
// /v1: every piece of data still comes live from the API, with its policy check. The offline copy of knowledge is kept
// by the application itself, locked (src/offline/), not here.
// Built into dist/sw.js by vite.config.ts, which fills in the two values below.
const VERSION = '__LEGACYAI_VERSION__';
const FILES = __LEGACYAI_FILES__;
const CACHE = `legacyai-app-${VERSION}`;
const PAGE = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('legacyai-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cachedPage = () => caches.open(CACHE).then((cache) => cache.match(PAGE));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) return; // data: always the network, never kept
  if (request.mode === 'navigate') {
    // The live page when the server answers; the kept page when it cannot be reached or fails.
    event.respondWith(
      fetch(request)
        .then((response) => (response.status >= 500 ? cachedPage().then((page) => page ?? response) : response))
        .catch(() => cachedPage().then((page) => page ?? Response.error())),
    );
    return;
  }
  if (FILES.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((kept) => kept ?? fetch(request)));
  }
});
