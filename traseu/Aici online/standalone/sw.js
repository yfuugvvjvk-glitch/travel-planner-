// ── Service Worker — Standalone PWA ──────────────────────────────
const CACHE = 'traseu-standalone-v1';

// Resurse de cache la instalare
const PRECACHE = [
  './index.html',
  './app.js',
  './style.css',
  './locations.js',
  './routing.js',
  './ui.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.0/Sortable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      // Cache fișierele locale garantat; CDN-urile sunt opționale
      return cache.addAll(['./index.html', './app.js', './style.css',
        './locations.js', './routing.js', './ui.js', './manifest.json'])
        .then(() => {
          // Încearcă CDN-urile separat, fără să blocheze instalarea
          return Promise.allSettled(
            PRECACHE.filter(u => u.startsWith('http')).map(u =>
              fetch(u, { mode: 'no-cors' }).then(r => cache.put(u, r)).catch(() => {})
            )
          );
        });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Cererile API (nominatim, osrm, weather) — doar online, nu cache
  if (url.includes('nominatim') || url.includes('osrm') ||
      url.includes('open-meteo') || url.includes('openweathermap') ||
      url.includes('overpass')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // Tile-uri hartă — cache cu fallback
  if (url.includes('tile') || url.includes('carto') || url.includes('openstreetmap')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // Restul — cache first, fallback la rețea
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {
        // Offline fallback — returnează index.html pentru navigare
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
