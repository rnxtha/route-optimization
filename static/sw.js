const CACHE_NAME = 'routeopt-offline-v3';
const APP_SHELL = [
    '/',
    '/static/css/styles.css',
    '/static/js/app.js',
    '/static/js/chart.js',
    '/static/js/leaflet.js',
    '/static/css/leaflet.css',
    '/static/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
        ))
    );
    self.clients.claim();
});

function isCacheableMapRequest(request) {
    const url = new URL(request.url);
    return request.method === 'GET' && (
        url.hostname === 'tiles.openfreemap.org' ||
        url.hostname === 'demotiles.maplibre.org' ||
        url.hostname === 'server.arcgisonline.com' ||
        url.hostname.endsWith('mapbox.com') ||
        url.hostname.endsWith('openstreetmap.org') ||
        url.hostname.endsWith('gstatic.com')
    );
}

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET') return;

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(request).then(cached => cached || fetch(request).then(response => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                }
                return response;
            }).catch(() => caches.match('/')))
        );
        return;
    }

    if (isCacheableMapRequest(request)) {
        event.respondWith(
            caches.match(request).then(cached => {
                const network = fetch(request).then(response => {
                    if (response.ok || response.type === 'opaque') {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
                    }
                    return response;
                }).catch(() => cached);
                return cached || network;
            })
        );
    }
});

self.addEventListener('message', event => {
    if (event.data?.type !== 'CACHE_URLS') return;
    const urls = Array.isArray(event.data.urls) ? event.data.urls : [];
    event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(
        urls.map(url => fetch(url, { mode: 'no-cors' }).then(response => cache.put(url, response))
    )));
});
