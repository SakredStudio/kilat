// Kilat Service Worker — Cache-first offline asset shell
// Cache-first shell: installed phones only pick up a new release when this name changes.
// BUMP THIS ON EVERY DEPLOY (v3 = language switch; v4 = v2/v3 feature release 2026-10-25).
const CACHE_NAME = 'kilat-shell-v5';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './privacy.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './i18n/id.json',
  './i18n/en.json',
  './lib/i18n.js',
  './lib/billing.js',
  './lib/format.js',
  './lib/phone.js',
  './lib/store.js',
  './lib/ledger.js',
  './lib/wa.js',
  './lib/share-card.js',
  './lib/books.js',
  './lib/broadcast.js',
  './lib/canvas-share.js',
  './lib/receipt-card.js',
  './lib/photos.js',
  './lib/stats.js',
  './lib/qris.js',
  './lib/cloud.js',
  './fonts/fonts.css',
  './fonts/DMSans-400-latin.woff2',
  './fonts/DMSans-400-latin-ext.woff2',
  './fonts/DMSans-500-latin.woff2',
  './fonts/DMSans-500-latin-ext.woff2',
  './fonts/DMSans-600-latin.woff2',
  './fonts/DMSans-600-latin-ext.woff2',
  './fonts/DMSans-700-latin.woff2',
  './fonts/DMSans-700-latin-ext.woff2',
  './fonts/DMSerifDisplay-400-latin.woff2',
  './fonts/DMSerifDisplay-400-latin-ext.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
