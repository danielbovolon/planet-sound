/* Planet Sound service worker.
 * - The app itself is cached so it opens with no signal (recording works offline;
 *   entries wait in the outbox).
 * - Map tiles you have looked at are kept (up to ~3000) so familiar areas still
 *   draw in the field.
 * - The catalogue is fetched fresh when possible, cached as a fallback.
 * Bump VERSION whenever you deploy changed files. */
const VERSION = 'ps-2026-10-10k';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/app.js', 'assets/js/api.js', 'assets/js/ui.js', 'assets/js/store.js', 'assets/js/map.js', 'assets/js/player.js', 'assets/js/studio.js', 'assets/js/space.js', 'assets/js/sky.js', 'assets/img/milkyway-small.jpg',
  'assets/js/audio/engine.js', 'assets/js/audio/flac.js', 'assets/js/audio/analysis.js', 'assets/js/audio/take-worker.js', 'assets/js/audio/capture-worklet.js',
  'vendor/maplibre/maplibre-gl.mjs', 'vendor/maplibre/maplibre-gl-shared.mjs', 'vendor/maplibre/maplibre-gl-worker.mjs', 'vendor/maplibre/maplibre-gl.css',
  'assets/img/logo.png', 'assets/img/favicon.png', 'assets/img/icon-192.png',
  'assets/fonts/libre-franklin-latin-400-normal.woff2', 'assets/fonts/libre-franklin-latin-500-normal.woff2',
  'assets/fonts/libre-franklin-latin-600-normal.woff2', 'assets/fonts/newsreader-latin-400-normal.woff2',
  'assets/fonts/newsreader-latin-500-normal.woff2', 'assets/fonts/newsreader-latin-400-italic.woff2',
];
const TILE_HOSTS = ['tiles.openfreemap.org', 'server.arcgisonline.com'];
const TILE_CACHE = 'ps-tiles', MAX_TILES = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILE_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(TILE_CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) { c.put(req, r.clone()); if (Math.random() < 0.02) trimTiles(); } return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.pathname.endsWith('/api/sounds') && url.origin !== location.origin) {
    e.respondWith(fetch(req).then(r => { if (r.ok && !req.headers.get('Authorization')) caches.open(VERSION).then(c => c.put(req, r.clone())); return r; })
      .catch(() => caches.match(req)));
    return;
  }
  if (url.origin === location.origin) {
    // app files: cache first, refreshed in the background
    e.respondWith(caches.match(req, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') }).then(hit => {
      const net = fetch(req).then(r => { if (r.ok) caches.open(VERSION).then(c => c.put(req, r.clone())); return r; }).catch(() => hit || caches.match('index.html'));
      return hit || net;
    }));
  }
});
