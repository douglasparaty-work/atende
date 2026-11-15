// Service worker: lets the phone install the app and open its shell without signal.
// Network first, so a new version is never hidden behind a stale cache; live data (/api, /widget) is never cached.
const V = 'atende-v1';
self.addEventListener('install', (e) => e.waitUntil(caches.open(V).then((c) => c.addAll(['/', '/style.css', '/app.js', '/icons/icon-192.png'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/widget/')) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))));
});
