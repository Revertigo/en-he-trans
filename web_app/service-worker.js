// Minimal service worker for offline shell caching.
const CACHE = 'drivetranslate-v1';
const ASSETS = [
    './',
    './index.html',
    './app.js',
    './style.css',
    './manifest.json',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Only cache same-origin GET requests for the app shell
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;  // don't cache translation API calls

    event.respondWith(
        caches.match(event.request).then(cached =>
            cached || fetch(event.request).then(resp => {
                // Cache successful responses
                if (resp.ok) {
                    const clone = resp.clone();
                    caches.open(CACHE).then(c => c.put(event.request, clone));
                }
                return resp;
            }).catch(() => cached)
        )
    );
});
