/* KEEL Service Worker — offline cache + update management + background sync */
const CACHE_VERSION = 'keel-v1.9.0';   // Bumped from v1.7.0 to force update for new UI & device logic
const CACHE_NAME = CACHE_VERSION;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

/* The routes that must always resolve to index.html (Vercel cleanUrls) */
const NAV_ROUTES = ['/', '/index.html', '/home', '/live', '/train', '/you', '/menu'];

/* Offline fallback page (served for navigation when nothing is cached) */
const OFFLINE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KEEL — Offline</title>
<style>
body{margin:0;background:#090A0C;color:#F4F5F7;font-family:-apple-system,sans-serif;
display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}
.wrap{max-width:320px}
h1{font-size:14px;letter-spacing:.24em;color:#C9F24E;margin:0 0 14px;font-weight:700}
p{font-size:13px;color:#8A9099;line-height:1.6;margin:0 0 20px}
a{display:inline-block;padding:12px 22px;border-radius:100px;background:#C9F24E;color:#0A0C05;
font-weight:700;font-size:13px;text-decoration:none}
</style></head><body><div class="wrap">
<h1>KEEL</h1>
<p>You're offline and this page isn't cached yet. Reconnect and reload to continue.</p>
<a href="javascript:location.reload()">Retry</a>
</div></body></html>`;

/* ----------------------------------------------------------------
   Strip the `redirected` flag so Safari accepts the cached response
   for navigation requests. Opaque responses can't be rebuilt, so we
   leave them alone (they never carry the redirect flag anyway).
   ---------------------------------------------------------------- */
async function sanitizeResponse(res) {
  if (!res) return res;
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  if (!res.redirected) return res;
  try {
    const body = await res.blob();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers
    });
  } catch (_) {
    return res; // if blob() fails for any reason, keep the original
  }
}

/* ----------------------------------------------------------------
   INSTALL
   ---------------------------------------------------------------- */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE_URLS.map(async url => {
      const isCrossOrigin = /^https?:\/\//i.test(url);
      try {
        const res = await fetch(url, isCrossOrigin ? { mode: 'no-cors' } : {});
        if (!res || (!res.ok && res.type !== 'opaque')) return;
        const clean = await sanitizeResponse(res);
        await cache.put(url, clean);
      } catch (_) { /* ignore individual failures */ }
    }));
    await self.skipWaiting();
  })());
});

/* ----------------------------------------------------------------
   ACTIVATE
   ---------------------------------------------------------------- */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== 'keel-pending-uploads-v1').map(k => caches.delete(k))
    );

    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }

    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c =>
      c.postMessage({ type: 'SW_ACTIVATED', version: CACHE_NAME })
    );
  })());
});

/* ----------------------------------------------------------------
   FETCH
   ---------------------------------------------------------------- */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  // Network-first for sw.js and manifest.json so updates apply immediately
  if (url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/manifest.json')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Never intercept cross-origin non-Leaflet requests (analytics, maps tiles, etc.)
  const isLeaflet = /unpkg\.com\/leaflet/.test(req.url);
  if (url.origin !== self.location.origin && !isLeaflet) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);

    /* ---------- Navigation requests ----------
       Serve the SPA shell from cache for all app routes so deep links
       work offline (e.g., /live, /you). */
    if (req.mode === 'navigate') {
      const isNavRoute = NAV_ROUTES.includes(url.pathname) || url.pathname === '/';
      
      if (isNavRoute) {
        const shell = await cache.match('./index.html');
        if (shell) {
          // Background revalidate the shell
          fetch('./index.html').then(async res => {
            if (!res || (!res.ok && res.type !== 'opaque')) return;
            const clean = await sanitizeResponse(res);
            await cache.put('./index.html', clean);
          }).catch(() => {});
          return await sanitizeResponse(shell);
        }
      }

      // If it's a specific cached route, serve it
      if (cached) {
        fetch(req).then(async res => {
          if (!res || (!res.ok && res.type !== 'opaque')) return;
          const clean = await sanitizeResponse(res);
          await cache.put(req, clean);
        }).catch(() => {});
        return await sanitizeResponse(cached);
      }

      // Network fallback for navigation
      try {
        const preload = await event.preloadResponse;
        const res = preload || await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          const clean = await sanitizeResponse(res);
          // Only cache the main shell, not random routes
          if (isNavRoute) cache.put('./index.html', clean.clone()).catch(() => {});
          return clean;
        }
      } catch (_) {}

      // Fallback to offline page if nothing works
      return new Response(OFFLINE_HTML, {
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' })
      });
    }

    /* ---------- Static assets (cache-first with bg revalidate) ---------- */
    if (cached) {
      fetch(req)
        .then(async res => {
          if (!res || (!res.ok && res.type !== 'opaque')) return;
          const clean = await sanitizeResponse(res);
          await cache.put(req, clean);
        })
        .catch(() => {});
      return cached;
    }

    /* ---------- Cache miss — fetch from network ---------- */
    try {
      const res = await fetch(req);
      if (!res || (!res.ok && res.type !== 'opaque')) return res;
      const clean = await sanitizeResponse(res);
      await cache.put(req, clean.clone());
      return clean;
    } catch (err) {
      return new Response('Offline — No cached data available.', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: new Headers({ 'Content-Type': 'text/plain' })
      });
    }
  })());
});

/* ----------------------------------------------------------------
   MESSAGE — app → SW commands
   ---------------------------------------------------------------- */
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
        .then(() => {
          if (event.source && event.source.postMessage) {
            event.source.postMessage({ type: 'CACHE_CLEARED' });
          }
        })
    );
    return;
  }

  /* Queue a public session record for upload when back online.
     The new index.html passes rich payloads with geoTrack, avgPace, etc. */
  if (data.type === 'QUEUE_PUBLIC_UPLOAD' && data.payload) {
    event.waitUntil(
      queueUpload(data.payload)
        .then(() => registerSync())
        .catch(() => {})
    );
    return;
  }
});

/* ----------------------------------------------------------------
   BACKGROUND SYNC — retry public session uploads
   ---------------------------------------------------------------- */
async function registerSync() {
  if (!('sync' in self.registration)) return;
  try { await self.registration.sync.register('keel-upload-sessions'); } catch (_) {}
}

async function queueUpload(payload) {
  const cache = await caches.open('keel-pending-uploads-v1');
  const key = `session-${payload.id || Date.now()}`;
  const res = new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  });
  await cache.put(key, res);
}

async function drainUploads() {
  const cache = await caches.open('keel-pending-uploads-v1');
  const keys = await cache.keys();
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const key of keys) {
    const res = await cache.match(key);
    if (!res) continue;
    try {
      const payload = await res.json();

      /* Simulate successful cloud upload for the prototype. 
         We notify the app that the payload (which now contains the 
         trail track, avg speed, etc.) has been synced. */
      clients.forEach(c => c.postMessage({
        type: 'PUBLIC_UPLOAD_COMPLETE',
        id: payload.id,
        uploadedAt: Date.now()
      }));

      await cache.delete(key);
    } catch (_) {
      // leave it in the cache, it will be retried next sync
    }
  }
}

self.addEventListener('sync', event => {
  if (event.tag === 'keel-upload-sessions') {
    event.waitUntil(drainUploads());
  }
});

/* ----------------------------------------------------------------
   NOTIFICATIONS — future-proof hook
   ---------------------------------------------------------------- */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './#home';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        c.postMessage({ type: 'NOTIFICATION_CLICK', url: target });
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});