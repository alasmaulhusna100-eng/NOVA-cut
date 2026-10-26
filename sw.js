/* NovaCut service worker: অফলাইন শেল + গ্যালারি থেকে ভিডিও শেয়ার */
const VERSION = 'novacut-v1';
const SHARED = 'novacut-shared';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARED).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // গ্যালারি/ফাইল ম্যানেজার থেকে "শেয়ার" করা ভিডিও গ্রহণ
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await req.formData();
        const files = fd.getAll('videos').filter((f) => f && f.size);
        const cache = await caches.open(SHARED);
        await Promise.all(files.map((f, i) => cache.put(
          new URL('shared/' + i, self.registration.scope).href,
          new Response(f, { headers: { 'Content-Type': f.type || 'video/mp4', 'X-Name': encodeURIComponent(f.name || ('video-' + i)) } })
        )));
        return Response.redirect(new URL('./?shared=' + files.length, self.registration.scope).href, 303);
      } catch (err) {
        return Response.redirect(new URL('./', self.registration.scope).href, 303);
      }
    })());
    return;
  }

  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
