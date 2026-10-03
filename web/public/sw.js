// Signalbox's service worker: phone notifications only.
//
// It shows what Signalbox pushes (an agent waiting on you, new For-you cards)
// and opens the right page when you tap one. There is deliberately no fetch
// handler: nothing is cached and no request goes through here.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Wayroost';
  // Only a path on this site: not "//elsewhere" or "/\elsewhere".
  const url = typeof data.url === 'string' && /^\/(?![\/\\])/.test(data.url) ? data.url : '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = new URL(event.notification.data?.url || '/', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) await client.navigate(url.href).catch(() => {});
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
