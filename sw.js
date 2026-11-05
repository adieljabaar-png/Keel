/* ============================================================
   KEEL Service Worker — v3.0.0
   Bumped from v2.0.8 → v3.0.0 to force-evict the old broken HTML
   (duplicate </body>, broken location handlers, fake BT scan).
   ============================================================ */

const CACHE_VERSION = 'keel-v3.0.0';
const CACHE_NAME    = CACHE_VERSION;

/* Static assets precached on install (index.html is network-first). */
const PRECACHE_URLS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

/* Extensions / paths that MUST always hit the network first.
   Serving stale HTML is what made "LOCATING" / login / BT appear stuck. */
function isNetworkFirst(pathname) {
  return (
    pathname === '/' ||
    pathname.endsWith('/index.html') ||
    pathname.endsWith('/sw.js') ||
    pathname.endsWith('/manifest.json') ||
    pathname.endsWith('/supabaseClient.js')
  );
}

const OFFLINE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KEEL — Offline</title>
<style>
  body{margin:0;background:#090A0C;color:#F4F5F7;
       font-family:-apple-system,BlinkMacSystemFont,sans-serif;
       display:flex;align-items:center;justify-content:center;
       height:100vh;text-align:center;padding:24px}
  .wrap{max-width:320px}
  h1{font-size:14px;letter-spacing:.24em;color:#C9F24E;margin:0 0 14px;font-weight:700}
  p{font-size:13px;color:#8A9099;line-height:1.6;margin:0 0 20px}
  a{display:inline-block;padding:12px 22px;border-radius:100px;
    background:#C9F24E;color:#0A0C05;font-weight:700;font-size:13px;
    text-decoration:none}
</style></head>
<body><div class="wrap">
<h1>KEEL</h1>
<p>You're offline. Reconnect to load the latest version of KEEL.</p>
<a href="javascript:location.reload()">Retry</a>
</div></body></html>`;

/* ------------------------------------------------------------
   Strip `redirected` flag so cached redirected responses can be
   safely re-used as if they were the original request's response.
   ------------------------------------------------------------ */
async function sanitizeResponse(res) {
  if (!res) return res;
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  if (!res.redirected) return res;
  try {
    const body = await res.blob();
    return new Response(body, {
      status:     res.status,
      statusText: res.statusText,
      headers:    res.headers
    });
  } catch (_) {
    return res;
  }
}

/* ============================================================
   INSTALL — precache only static shell assets.
   index.html is intentionally NOT precached; it's network-first
   so every deploy immediately reaches the user.
   ============================================================ */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of PRECACHE_URLS) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res && res.ok) {
          await cache.put(url, await sanitizeResponse(res.clone()));
        }
      } catch (_) {
        /* ignore — offline install still succeeds with partial cache */
      }
    }
    console.log('[KEEL SW] v3.0.0 installed');
    await self.skipWaiting();
  })());
});

/* ============================================================
   ACTIVATE — wipe every cache that isn't the current version.
   This is what clears the old broken HTML from users who had
   v2.0.8 installed.
   ============================================================ */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    console.log('[KEEL SW] activating, dropping old caches:', keys);
    await Promise.all(
      keys
        .filter(k => k !== CACHE_NAME && k !== 'keel-pending-uploads-v1')
        .map(k => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({
      type:    'SW_ACTIVATED',
      version: CACHE_NAME,
      msg:     'KEEL v3.0.0 active — Apple Health import, real Bluetooth, working location'
    }));
  })());
});

/* ============================================================
   FETCH
   ============================================================ */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  /* ---------- 1. Network-first for critical files ---------- */
  if (isNetworkFirst(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(async res => {
          if (res && res.ok) {
            const clean = await sanitizeResponse(res.clone());
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, clean.clone()).catch(() => {});
            return clean;
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const cached =
            (await cache.match(req)) ||
            (await cache.match('./index.html')) ||
            (await cache.match('./'));
          return cached || new Response(OFFLINE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
          });
        })
    );
    return;
  }

  /* ---------- 2. Leaflet CDN ---------- */
  const isLeaflet = /unpkg\.com\/leaflet|cdn\.jsdelivr\.net\/npm\/jszip/.test(req.url);

  /* ---------- 3. Cross-origin (non-Leaflet/JSZip) → pass through ---------- */
  if (url.origin !== self.location.origin && !isLeaflet) return;

  /* ---------- 4. Navigations (SPA routes) ---------- */
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const clean = await sanitizeResponse(res.clone());
          cache.put('./index.html', clean.clone()).catch(() => {});
          return clean;
        }
        return res;
      } catch (_) {
        return (
          (await cache.match('./index.html')) ||
          (await cache.match('./')) ||
          new Response(OFFLINE_HTML, {
            status: 200,
            headers: { 'Content-Type': 'text/html' }
          })
        );
      }
    })());
    return;
  }

  /* ---------- 5. Everything else: cache-first + background revalidate ---------- */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    if (cached) {
      // Refresh in the background
      fetch(req)
        .then(async r => {
          if (r && r.ok) {
            const c = await sanitizeResponse(r);
            cache.put(req, c.clone()).catch(() => {});
          }
        })
        .catch(() => {});
      return cached;
    }

    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const clean = await sanitizeResponse(res.clone());
        cache.put(req, clean.clone()).catch(() => {});
        return clean;
      }
      return res;
    } catch (_) {
      return new Response('Offline', { status: 503 });
    }
  })());
});

/* ============================================================
   MESSAGE HANDLER
   ============================================================ */
self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => event.source?.postMessage({ type: 'CACHE_CLEARED' }))
    );
    return;
  }

  if (data.type === 'FORCE_UPDATE') {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .then(() => self.skipWaiting())
    );
    return;
  }
});