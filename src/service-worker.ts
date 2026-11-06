/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { version } from '$service-worker';
import {
  cacheNameFor,
  dropOldCaches,
  handleNotificationClick,
  handlePush,
  handlePushSubscriptionChange,
  isHandled,
  precache,
  respond,
  type SwClients,
  type SwPushRegistration,
} from '$lib/install/sw-core';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = cacheNameFor(version);

// R-NAV-08, R-NTF-12: offline fallback cache and Web Push handlers; no sync or periodic handlers.
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

worker.addEventListener('push', (event) => {
  const rawText = (() => {
    try {
      return event.data?.text() ?? null;
    } catch {
      return null;
    }
  })();
  event.waitUntil(handlePush(rawText, worker.registration as unknown as SwPushRegistration));
});

worker.addEventListener('notificationclick', (event) => {
  event.waitUntil(
    handleNotificationClick(
      event.notification as unknown as { data?: Record<string, unknown>; close?: () => void },
      worker.clients as unknown as SwClients,
      worker.location.origin,
    ),
  );
});

worker.addEventListener('pushsubscriptionchange', ((event: Event) => {
  const pushEvent = event as ExtendableEvent & {
    newSubscription?: PushSubscription | null;
    oldSubscription?: PushSubscription | null;
  };
  pushEvent.waitUntil(
    handlePushSubscriptionChange(
      pushEvent,
      worker.registration as unknown as SwPushRegistration,
      (input, init) => fetch(input, init),
    ),
  );
}) as EventListener);
