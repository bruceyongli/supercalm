// Supercalm service worker — push notifications + install-to-home-screen (PWA).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data.json();
  } catch {}
  // Resolve URLs/icons against the SW scope (e.g. https://host/aios/) so everything stays under
  // the app's path prefix. The server sends RELATIVE payload urls ("session?id=X" or ".").
  const base = self.registration.scope;
  const url = new URL(d.url || '.', base).href;
  const rideUrl = d.rideUrl ? new URL(d.rideUrl, base).href : '';
  event.waitUntil(
    self.registration.showNotification(d.title || 'Supercalm', {
      body: d.body || '',
      tag: d.tag || 'aios',
      data: { url, rideUrl },
      icon: new URL('icon.svg', base).href,
      badge: new URL('icon.svg', base).href,
      silent: false,
      renotify: true,
      actions: rideUrl ? [
        { action: 'talk', title: 'Talk now' },
        { action: 'open', title: 'Open' },
      ] : [],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = (event.action === 'talk' && data.rideUrl) ? data.rideUrl : (data.url || self.registration.scope);
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(url.split('?')[0]) && 'focus' in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
