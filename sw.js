// cache-bust-20261126-launch-flow-fix-v60
// WaitMate India — Service Worker
const CACHE_NAME = 'waitmate-v20261126-launch-flow-fix-v60';

// Shell files that must ALWAYS be fetched fresh from the network so stale,
// broken builds can never be served from cache after a deploy.
const SHELL_URLS = ['/', '/index.html', '/app.js'];

function isShell(urlPath) {
  return urlPath === '/' || urlPath === '/index.html' || urlPath === '/app.js';
}

self.addEventListener('install', (event) => {
  // Activate the new worker immediately so old broken versions never linger.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Force-purge EVERY old cache on activate so no stale asset survives.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Take control of all open clients immediately.
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let pathname = '';
  try { pathname = new URL(req.url).pathname; } catch (e) {}

  // Live data (API) and non-GET requests must NEVER be served from cache.
  if (req.method !== 'GET' || pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Network-first for the HTML shell and app.js: browsers never load stale
  // broken versions of index.html or app.js. Fall back to cache only when
  // the network is unavailable.
  if (isShell(pathname)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for static assets (logos, CSS, images) with network refresh.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});

// Handle push messages from the app
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'WaitMate India 🇮🇳';
  const options = {
    body: data.body || 'Your table update is ready.',
    icon: data.icon || '/logo.png?v=2',
    badge: data.badge || '/logo.png?v=2',
    tag: data.tag || 'waitmate-queue',
    renotify: true,
    vibrate: [200, 100, 200, 100, 400],
    data: { url: data.url || '/' },
    actions: data.actions || []
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification click — focus or open the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';

  if (event.action === 'arrived') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          client.postMessage({ type: 'DINER_ARRIVED' });
          return;
        }
      })
    );
    return;
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Handle messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
