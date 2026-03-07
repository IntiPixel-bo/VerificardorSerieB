
const CACHE_NAME = 'validaserie-v2';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/ranges.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://unpkg.com/tesseract.js@4.1.1/dist/tesseract.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  // Network falling back to cache for tesseract model downloads, cache-first for app shell
  if (CORE_ASSETS.includes(new URL(request.url).pathname)) {
    event.respondWith(
      caches.match(request).then(resp => resp || fetch(request))
    );
    return;
  }
  event.respondWith(
    fetch(request).then(resp => {
      // Try to cache dynamic GETs
      if (request.method === 'GET' && resp && (resp.status === 200 || resp.type === 'opaque')) {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, respClone));
      }
      return resp;
    }).catch(() => caches.match(request))
  );
});
