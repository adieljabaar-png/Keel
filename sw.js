/* KEEL Service Worker — FIXED for location + Vercel deploy */
const CACHE_VERSION = 'keel-v2.0.0';   // BUMP MAJOR to force clear LOCATING stuck cache
const CACHE_NAME = CACHE_VERSION;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const NAV_ROUTES = ['/', '/index.html', '/home', '/live', '/train', '/you', '/menu'];

const OFFLINE_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KEEL — Offline</title><style>body{margin:0;background:#090A0C;color:#F4F5F7;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center;padding:24px}.wrap{max-width:320px}h1{font-size:14px;letter-spacing:.24em;color:#C9F24E;margin:0 0 14px;font-weight:700}p{font-size:13px;color:#8A9099;line-height:1.6;margin:0 0 20px}a{display:inline-block;padding:12px 22px;border-radius:100px;background:#C9F24E;color:#0A0C05;font-weight:700;font-size:13px;text-decoration:none}</style></head><body><div class="wrap"><h1>KEEL</h1><p>You're offline. Reconnect to get live location and health sync.</p><a href="javascript:location.reload()">Retry</a></div></body></html>`;

async function sanitizeResponse(res) {
  if (!res) return res;
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  if (!res.redirected) return res;
  try {
    const body = await res.blob();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (_) { return res; }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Don't precache index.html aggressively - network first for location fix
    for (const url of ['./manifest.json','./icon-192.png','./icon-512.png']) {
      try {
        const res = await fetch(url);
        if (res && res.ok) await cache.put(url, await sanitizeResponse(res));
      } catch(_){}
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // DELETE ALL OLD CACHES - fixes stuck LOCATING
    await Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'keel-pending-uploads-v1').map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch(_){}
    }
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'SW_ACTIVATED', version: CACHE_NAME, msg: 'Location fix applied - please allow location' }));
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;

  // ALWAYS network-first for critical files - THIS FIXES LOCATION
  if (url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/sw.js') || url.pathname.endsWith('/manifest.json') || url.pathname.endsWith('/supabaseClient.js')) {
    event.respondWith(
      fetch(req).then(async res => {
        if (res && res.ok) {
          const cache = await caches.open(CACHE_NAME);
          const clean = await sanitizeResponse(res);
          cache.put(req, clean.clone()).catch(()=>{});
          return clean;
        }
        return res;
      }).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req) || await cache.match('./index.html');
        return cached || new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
      })
    );
    return;
  }

  // Leaflet CDN - let it pass through
  const isLeaflet = /unpkg\.com\/leaflet/.test(req.url);
  if (url.origin !== self.location.origin && !isLeaflet) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (req.mode === 'navigate') {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const clean = await sanitizeResponse(res);
          cache.put('./index.html', clean.clone()).catch(()=>{});
          return clean;
        }
      } catch(_){}
      const shell = await cache.match('./index.html');
      if (shell) return shell;
      return new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }

    const cached = await cache.match(req);
    if (cached) {
      fetch(req).then(async r => { if (r && r.ok) { const c = await sanitizeResponse(r); cache.put(req, c); } }).catch(()=>{});
      return cached;
    }

    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const clean = await sanitizeResponse(res);
        cache.put(req, clean.clone()).catch(()=>{});
        return clean;
      }
      return res;
    } catch(_) {
      return new Response('Offline', { status: 503 });
    }
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(()=>{ event.source?.postMessage({ type: 'CACHE_CLEARED' }); }));
    return;
  }
  if (data.type === 'FORCE_UPDATE') {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(()=> self.skipWaiting()));
    return;
  }
});
