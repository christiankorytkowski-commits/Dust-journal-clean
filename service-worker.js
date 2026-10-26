// DUST Journal service worker retirement shim v0.3.9
// Purpose: permanently retire the legacy PWA cache/injection layer.
// The working iPad Home-Screen entrypoint is dust-home.html.
// This worker performs NO fetch interception and stores NO app shell.

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Remove only DUST journal caches left by prior builds.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(key => key.startsWith('dust-journal-'))
        .map(key => caches.delete(key))
    );

    // Retire this registration immediately. If legacy index.html registers
    // service-worker.js again later, this shim simply cleans up and retires again.
    await self.registration.unregister();
  })());
});

// Intentionally no fetch handler.
// All journal and Forward Sync requests go directly to the network.
