const CACHE = 'dust-journal-v0.3.4-shadow-persist';

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

const PREBOOT = `<script>
(() => {
  try {
    const JOURNAL_KEY = 'dust.mobile.v1';
    const SYNC_KEY = 'dust.forwardSync.v1';
    const SHADOW_ID = 'dust_shadow_50k';

    const cfg = JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    if (!cfg.url && !cfg.shadowConfigured) return;

    let db;
    try {
      db = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
    } catch {}

    if (!db || !Array.isArray(db.accounts)) {
      const id = 'acc_' + Date.now();
      db = {
        currentAccountId: id,
        accounts: [{
          id,
          name: 'Demo Sandbox 50K',
          provider: 'Breakout',
          stage: 'Evaluation',
          startingBalance: 50000,
          maxDrawdownPct: 6,
          profitTargetPct: 10
        }],
        trades: []
      };
    }

    if (!Array.isArray(db.trades)) db.trades = [];

    if (!db.accounts.some(a => a && a.id === SHADOW_ID)) {
      db.accounts.push({
        id: SHADOW_ID,
        name: 'DUST 50K Shadow',
        provider: 'DUST Forward',
        stage: 'Evaluation',
        startingBalance: 50000,
        maxDrawdownPct: 6,
        profitTargetPct: 10
      });
    }

    localStorage.setItem(JOURNAL_KEY, JSON.stringify(db));
  } catch (err) {
    console.warn('DUST shadow preboot restore failed', err);
  }
})();
</script>`;

async function injectJournalRuntime(response) {
  if (!response || !response.ok) return response;

  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  let text = await response.text();

  // Critical: restore the Shadow account BEFORE index.html's own load() executes.
  if (!text.includes('DUST shadow preboot restore failed')) {
    text = text.replace('</head>', `${PREBOOT}\n</head>`);
  }

  // Load remote sync after the journal UI/core has initialized.
  if (!text.includes('forward-sync.js')) {
    text = text.replace('</body>', '<script src="./forward-sync.js"></script>\n</body>');
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Cross-origin Tailscale/engine requests must always bypass the app-shell cache.
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  const isIndex =
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  if (isIndex) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then(injectJournalRuntime)
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
          return cached ? injectJournalRuntime(cached) : Response.error();
        })
    );
    return;
  }

  // Same-origin static assets: network first, cache only as fallback.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
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
