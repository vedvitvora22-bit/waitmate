// cache-bust-20261124-host-queue-join-time-channel-v15
// WaitMate India — Service Worker
const CACHE_NAME = 'waitmate-v20261124-host-queue-join-time-channel-v15';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let pathname = '';
  try { pathname = new URL(req.url).pathname; } catch (e) {}

  // Live data (API) and non-GET requests must NEVER be served from cache.
  // The Host Stand polls /api/host/queue every few seconds and diners poll
  // /api/queue/ticket; a cache-first strategy would keep showing the previous
  // queue snapshot so newly-joined guests (written to Firestore by another
  // device) would not appear. Always hit the network, and only fall back to a
  // cached copy when the device is offline.
  if (req.method !== 'GET' || pathname.startsWith('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

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
    icon: data.icon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⏳</text></svg>',
    badge: data.badge || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⏳</text></svg>',
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
