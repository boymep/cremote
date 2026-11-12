/* Service worker cremote: офлайн-оболочка, Web Push, бейдж иконки.
   __BUILD_ID__ подставляет vite-плагин при сборке. */
const BUILD_ID = '__BUILD_ID__';
const CACHE = `cremote-${BUILD_ID}`;
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];
const NAV_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  // skipWaiting только по сообщению от страницы, чтобы не перезагружать посреди ввода
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('cremote-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skipWaiting') self.skipWaiting();
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname.startsWith('/ws/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await withTimeout(fetch(req), NAV_TIMEOUT_MS);
          if (res.ok) cache.put('/', res.clone());
          return res;
        } catch {
          return (await cache.match('/')) || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })(),
    );
  }
});

self.addEventListener('push', (event) => {
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    p = { body: event.data ? event.data.text() : '' };
  }
  const title = p.title || 'cremote';
  const tag = typeof p.tag === 'string' && p.tag ? p.tag : undefined;
  const tasks = [
    self.registration.showNotification(title, {
      body: p.body || '',
      tag,
      renotify: !!tag,
      data: { url: p.url || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  ];
  if (typeof p.badge === 'number') {
    const nav = self.navigator;
    if (p.badge > 0 && nav && nav.setAppBadge) tasks.push(nav.setAppBadge(p.badge).catch(() => {}));
    else if (p.badge === 0 && nav && nav.clearAppBadge) tasks.push(nav.clearAppBadge().catch(() => {}));
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if (new URL(c.url).origin !== self.location.origin) continue;
        try {
          await c.focus();
        } catch {}
        c.postMessage({ type: 'navigate', url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
