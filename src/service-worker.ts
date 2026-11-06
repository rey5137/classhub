/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { version } from '$service-worker';
import { cacheNameFor, dropOldCaches, isHandled, precache, respond } from '$lib/install/sw-core';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = cacheNameFor(version);

// R-NAV-08: no push, sync or periodic handlers here; push arrives with R-NTF-12.
worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then(precache));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(dropOldCaches(caches, cacheName));
});

worker.addEventListener('fetch', (event) => {
  // Not ours (non-GET, /api/, sockets, cross-origin): no respondWith, the browser handles it.
  if (!isHandled(event.request, worker.location.origin)) return;
  event.respondWith(
    respond(event.request, {
      origin: worker.location.origin,
      fetch: (request) => fetch(request),
      cached: (pathname) => caches.open(cacheName).then((cache) => cache.match(pathname)),
    }) as Promise<Response>,
  );
});
