const CACHE = 'dust-journal-v0.3.3-forward-sync';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './forward-sync.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function injectForwardSync(response) {
  if (!response || !response.ok) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  if (!text.includes('forward-sync.js')) {
    text = text.replace('</body>', '<script src="./forward-sync.js"></script>\n</body>');
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never intercept/cache Tailscale or any other cross-origin engine/API request.
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  const isIndex = event.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');

  if (isIndex) {
    event.respondWith(
      fetch(event.request)
        .then(injectForwardSync)
        .then(async response => {
          if (response && response.ok) {
            const copy = response.clone();
            const cache = await caches.open(CACHE);
            await cache.put('./index.html', copy);
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('./index.html');
          return cached ? injectForwardSync(cached) : Response.error();
        })
    );
    return;
  }

  // Static same-origin assets: network first, cache as offline fallback.
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
