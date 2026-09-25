// Network first, cache as the fallback. Online, every page is as current as a
// plain reload; at a dealer with no reception, the last loaded state still
// opens. Only same-origin GETs are handled: the hotlinked mobile.de photos
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
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
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
