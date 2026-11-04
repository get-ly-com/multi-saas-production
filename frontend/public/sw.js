/* Get-ly service worker, written by hand.
   - Next's build files (/_next/static/*) and the app shell are served from the cache first.
   - Pages go to the network first and fall back to the last copy, then to the offline page.
   - API calls, Next data requests and anything on another site are never touched or cached. */
const VERSION = 'v2';
const SHELL_CACHE = `getly-shell-${VERSION}`;
const STATIC_CACHE = `getly-static-${VERSION}`;
const PAGE_CACHE = `getly-pages-${VERSION}`;
const KEEP = [SHELL_CACHE, STATIC_CACHE, PAGE_CACHE];
const MAX_PAGES = 40;

const SHELL = [
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('getly-') && !KEEP.includes(name)).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Only plain, complete, same-site answers are worth keeping
const cacheable = (response) => response && response.ok && response.type === 'basic' && response.status === 200;

const neverCache = (url) =>
  url.pathname.startsWith('/api/') ||
  url.pathname.startsWith('/_next/data/') ||
  url.pathname.startsWith('/_next/image') ||
  url.pathname.startsWith('/_next/webpack-hmr') ||
  url.pathname === '/sw.js';

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response)) cache.put(request, response.clone());
  return response;
}

async function trimPages(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_PAGES; i++) await cache.delete(keys[i]);
}

async function networkFirstPage(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) {
      // Query strings are dropped so each page is kept once
      const url = new URL(request.url);
      await cache.put(url.origin + url.pathname, response.clone());
      trimPages(cache);
    }
    return response;
  } catch (err) {
    const url = new URL(request.url);
    const copy = await cache.match(url.origin + url.pathname);
    if (copy) return copy;
    const offline = await caches.match('/offline.html');
    return offline || new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // other sites, including the API, go straight to the network
  if (neverCache(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
