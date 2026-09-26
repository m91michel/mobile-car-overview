// Network first, cache as the fallback. Online, every page is as current as a
// plain reload; at a dealer with no reception, the last loaded state still
// opens. Only same-origin GETs are handled, minus the settings sync: the hotlinked mobile.de photos
// pass straight through and are never stored.
const CACHE = 'car-compare-v1';

self.addEventListener('install', (event) => {
  // The checklist is the page most likely to be needed offline, so it is
  // stored up front even if only the comparison table was ever opened.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/checkliste.html'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // The sync must see the server or nothing: a cached answer would look like
  // an older server state. sync.js keeps working offline on its own.
  if (url.pathname.startsWith('/api/settings')) return;
  // Same for the version check: a cached answer would hide a new deploy.
  if (url.pathname.startsWith('/api/health')) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error())),
  );
});
