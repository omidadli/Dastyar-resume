/*
 * HOVIDA service worker — what makes «افزودن به صفحهٔ اصلی» a real app icon
 * instead of a bookmark.
 *
 * Rules, in order of importance:
 *   1. **Never cache an API answer.** A cached `/api/...` would show yesterday's
 *      candidate or, worse, someone else's. Only same-origin GET of static
 *      files and the shell is touched.
 *   2. **The shell is network-first.** After a deploy the HTML must not point at
 *      bundles that no longer exist (the app already has a one-reload recovery;
 *      a stale shell would fight it).
 *   3. **Assets are stale-while-revalidate.** Vite's filenames are hashed, so a
 *      cached file is never wrong — it is either this build's or a dead name.
 *   4. **Offline is a page, not an error.** A navigation without network gets
 *      the cached shell when it exists, and `/offline.html` otherwise.
 */
const VERSION = 'hovida-v2';
const SHELL = '/offline.html';
const PRECACHE = [SHELL, '/manifest.webmanifest', '/favicon.svg', '/brand/icon-192.png', '/brand/icon-512.png', '/fonts/Vazirmatn-var.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStatic(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/brand/') ||
    url.pathname.startsWith('/fonts/') ||
    /\.(?:css|js|mjs|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/i.test(url.pathname)
  );
}

/** Public candidate pages must always be fresh — they carry a deadline. */
function isPrivate(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/scim/') ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/app')
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/scim/')) return;

  if (req.mode === 'navigate') {
    // Public pages (career portal, offer, assessment, video) are network-only:
    // a cached copy could show a closed deadline or an old link.
    if (!isPrivate(url) && url.pathname !== '/') return;
    event.respondWith(
      fetch(req)
        .then((res) => res)
        .catch(async () => {
          const cache = await caches.open(VERSION);
          const shell = (await cache.match('/')) || (await cache.match(SHELL));
          return shell || new Response('آفلاین هستید.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        })
    );
    return;
  }

  if (isStatic(url)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone()).catch(() => undefined);
            return res;
          })
          .catch(() => null);
        return cached || (await network) || new Response('', { status: 504 });
      })
    );
  }
});
