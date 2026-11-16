/* Keel v1.0 - sw.js
 * Purpose:
 * 1. Save ALL user info / sessions to the DEVICE (IndexedDB in the SW + Cache Storage)
 *    so Keel works offline and no trip data is lost.
 * 2. Only update the app FUNCTION + DISPLAY each time:
 *    - App shell (HTML/CSS/JS) -> Stale-While-Revalidate: show cached instantly,
 *      fetch fresh in background, update cache for NEXT load.
 *    - User data / API -> Network-first with IndexedDB fallback, then sync back.
 *
 * Install: put this file at the ROOT of your site as /sw.js
 * and register it from your app:
 *   if ('serviceWorker' in navigator) {
 *     navigator.serviceWorker.register('/sw.js', { scope: '/' });
 *   }
 * The app must send user data to the SW with postMessage:
 *   navigator.serviceWorker.controller.postMessage({ type: 'KEEL_SAVE_USER', payload: {...} })
 *   navigator.serviceWorker.controller.postMessage({ type: 'KEEL_SAVE_SESSION', payload: {...} })
 */

const VERSION = 'keel-v3';
const STATIC_CACHE = `keel-static-${VERSION}`;
const DATA_CACHE = `keel-data-${VERSION}`;
const DB_NAME = 'keel-device-db';
const DB_VERSION = 1;

// --- 1. Files that make up the app shell / function + display ---
// Add your real file names here. The SW will cache these on install.
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/supabaseClient.js',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico'
  // Do NOT precache OSM tiles — they are cached on demand in DATA_CACHE below.
];

// URLs that are USER DATA - never serve stale shell for these, always try network first
const DATA_URL_PATTERNS = [
  '/api/',
  '/records',
  'trackmap_sessions',
  'trackmap_settings'
];

function isDataRequest(url) {
  return DATA_URL_PATTERNS.some(p => url.includes(p));
}

function isNavigation(request) {
  return request.mode === 'navigate';
}

// ---------- IndexedDB helpers (inside Service Worker) ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('user')) {
        db.createObjectStore('user', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by-date', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        // Queued saves to retry when back online
        db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGetAll(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbGet(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbDelete(storeName, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  }));
}

// Save a snapshot of ALL user info to device
async function saveAllUserInfoToDevice(payload) {
  // payload: { user, settings, sessions: [], lastSync }
  if (!payload || typeof payload !== 'object') return;
  if (payload.user) await idbPut('user', { id: 'profile', ...payload.user, savedAt: Date.now() });
  if (payload.settings) await idbPut('settings', { id: 'app-settings', ...payload.settings, savedAt: Date.now() });
  if (Array.isArray(payload.sessions)) {
    for (const s of payload.sessions) {
      await idbPut('sessions', { ...s, savedAt: Date.now() });
    }
  }
  await idbPut('meta', { id: 'lastSync', at: Date.now(), source: payload.source || 'app' });
  // Notify all open Keel pages that device copy was updated
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clientsList) {
    c.postMessage({ type: 'KEEL_DEVICE_SAVED', at: Date.now() });
  }
}

// ---------- Install: cache app shell, take over quickly ----------
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {
        // If one file 404s, still cache what exists - don't fail install
        return Promise.allSettled(APP_SHELL.map(u => cache.add(u).catch(() => null)));
      }))
      .then(() => self.skipWaiting())
  );
});

// ---------- Activate: delete OLD caches, keep only current version ----------
// This is the "only update app function + display each time" part:
// old shell is removed, new shell becomes the only shell.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => {
        if (k !== STATIC_CACHE && k !== DATA_CACHE) return caches.delete(k);
      }));
      await self.clients.claim();
      // Tell pages a new version is active
      const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
      for (const c of clientsList) {
        c.postMessage({ type: 'KEEL_SW_ACTIVATED', version: VERSION });
      }
    })()
  );
});

// ---------- Messages from the app: save user info to device ----------
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') return self.skipWaiting();

  if (data.type === 'KEEL_SAVE_USER') {
    event.waitUntil(saveAllUserInfoToDevice({ user: data.payload, source: 'save-user' }));
  }
  if (data.type === 'KEEL_SAVE_SETTINGS') {
    event.waitUntil(saveAllUserInfoToDevice({ settings: data.payload, source: 'save-settings' }));
  }
  if (data.type === 'KEEL_SAVE_SESSION') {
    event.waitUntil((async () => {
      await idbPut('sessions', { ...data.payload, savedAt: Date.now() });
      // Also queue for server sync when online
      await idbPut('outbox', { kind: 'session', payload: data.payload, createdAt: Date.now() });
      if ('sync' in self.registration) {
        try { await self.registration.sync.register('keel-sync-sessions'); } catch (e) {}
      }
    })());
  }
  if (data.type === 'KEEL_SAVE_ALL') {
    event.waitUntil(saveAllUserInfoToDevice(data.payload || {}));
  }
  if (data.type === 'KEEL_GET_DEVICE_DATA') {
    event.waitUntil((async () => {
      const [user, sessions, settings] = await Promise.all([
        idbGetAll('user'), idbGetAll('sessions'), idbGetAll('settings')
      ]);
      event.source?.postMessage({ type: 'KEEL_DEVICE_DATA', user, sessions, settings });
    })());
  }
  if (data.type === 'KEEL_CLEAR_DEVICE_DATA') {
    event.waitUntil((async () => {
      const db = await openDB();
      for (const store of ['user', 'sessions', 'settings', 'outbox', 'meta']) {
        await new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          tx.objectStore(store).clear();
          tx.oncomplete = res; tx.onerror = () => rej(tx.error);
        });
      }
    })());
  }
});

// ---------- Fetch: the core "only update function/display" strategy ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    // POST/PUT/DELETE (saving a trip): try network, queue to IndexedDB outbox if offline
    if (isDataRequest(request.url)) {
      event.respondWith(
        fetch(request.clone()).catch(async () => {
          try {
            const body = await request.clone().text();
            await idbPut('outbox', { kind: 'request', url: request.url, method: request.method, body, createdAt: Date.now() });
            if ('sync' in self.registration) {
              try { await self.registration.sync.register('keel-sync-sessions'); } catch (e) {}
            }
          } catch (e) {}
          return new Response(JSON.stringify({ queued: true, offline: true }), {
            status: 202, headers: { 'Content-Type': 'application/json' }
          });
        })
      );
    }
    return;
  }

  const url = new URL(request.url);

  // 1. USER DATA / API: Network-first, fallback to device (IndexedDB/Cache)
  // Display always shows the newest saved data when online, device copy when offline.
  if (isDataRequest(request.url)) {
    event.respondWith(
      fetch(request)
        .then(async (res) => {
          // Save a fresh copy to DATA cache for offline display
          if (res.ok) {
            const clone = res.clone();
            const cache = await caches.open(DATA_CACHE);
            await cache.put(request, clone);
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(DATA_CACHE);
          const cached = await cache.match(request);
          if (cached) return cached;
          // Fallback: return device sessions as JSON for known session endpoints
          if (request.url.includes('trackmap_sessions')) {
            const sessions = await idbGetAll('sessions');
            return new Response(JSON.stringify({ records: sessions, offline: true }), {
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return new Response(JSON.stringify({ offline: true }), {
            status: 503, headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // 2. APP SHELL / FUNCTION + DISPLAY: Stale-While-Revalidate
  // Show cached app instantly, fetch fresh in background, update cache.
  // So the user ALWAYS sees the app, but the NEXT load has the newest function/display.
  if (isNavigation(request) || APP_SHELL.includes(url.pathname) || url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(request, { ignoreSearch: true });
        const networkPromise = fetch(request).then(async (res) => {
          if (res.ok) await cache.put(request, res.clone());
          return res;
        }).catch(() => null);
        // Return cached immediately if we have it, otherwise wait for network
        if (cached) {
          // Update in background - do not block display
          event.waitUntil(networkPromise);
          return cached;
        }
        const networkRes = await networkPromise;
        if (networkRes) return networkRes;
        // Offline + no cache: fallback to cached index
        const fallback = await cache.match('/index.html') || await cache.match('/');
        if (fallback) return fallback;
        return new Response('Keel is offline and no cached app shell was found.', { status: 503 });
      })()
    );
    return;
  }

  // 2b. Third-party libs (Leaflet / esm.sh / Supabase): never intercept — CORS/opaque responses break them
  if (url.origin !== self.location.origin && !url.hostname.includes('tile.openstreetmap.org')) { return; }

  // 3. MAP TILES / THIRD-PARTY: Cache-first, network fallback (tiles rarely change)
  if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('basemaps')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          if (res.ok) await cache.put(request, res.clone());
          return res;
        } catch (e) {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  // 4. Everything else: network-first, cache fallback
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

// ---------- Background Sync: push queued device saves when back online ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'keel-sync-sessions') {
    event.waitUntil((async () => {
      const outbox = await idbGetAll('outbox');
      for (const item of outbox) {
        try {
          if (item.kind === 'request') {
            await fetch(item.url, { method: item.method, body: item.body, headers: { 'Content-Type': 'application/json' } });
          }
          // Sessions are also saved via the app's own API on next load - clear queue entry
          await idbDelete('outbox', item.id);
        } catch (e) {
          // Stay queued, retry on next sync
        }
      }
    })());
  }
});

// ---------- Periodic Sync (if browser allows): refresh app shell ----------
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'keel-refresh-shell') {
    event.waitUntil(
      caches.open(STATIC_CACHE).then(cache =>
        Promise.allSettled(APP_SHELL.map(u => fetch(u).then(r => r.ok && cache.put(u, r)).catch(() => null)))
      )
    );
  }
});

// ---------- Push: trip-completed notification (sent by app/server) ----------
self.addEventListener('push', (event) => {
  let data = { title: 'Keel - Trip Completed', body: 'Your trip has been saved.' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'keel-trip-completed',
      data: { url: '/', ...data }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(event.notification.data?.url || '/');
    })
  );
});
