// R-NAV-08: the service worker's logic, apart from `$service-worker` and the worker globals so a
// unit test can drive it. The worker answers from the network; only a navigation that fails with
// a network error gets the precached offline page.

export const OFFLINE_URL = '/offline.html';
export const ICON_URLS = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];
export const PRECACHE_URLS = [OFFLINE_URL, '/offline.css', ...ICON_URLS];

export const cacheNameFor = (version: string) => `classhub-${version}`;

/** GET, same origin, not an API or socket request: the only requests the worker touches. */
export function isHandled(request: Request, origin: string): boolean {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  return request.headers.get('upgrade')?.toLowerCase() !== 'websocket';
}

export interface FetchDeps {
  origin: string;
  fetch: (request: Request) => Promise<Response>;
  /** A precached response for the path, or undefined when the cache has none. */
  cached: (pathname: string) => Promise<Response | undefined>;
}

/** Resolves to the response to send, or `null` to let the browser handle the request itself. */
export async function respond(request: Request, deps: FetchDeps): Promise<Response | null> {
  if (!isHandled(request, deps.origin)) return null;
  try {
    // Any HTTP response, a redirect to the Access login included, goes through untouched.
    return await deps.fetch(request);
  } catch (error) {
    // The offline page for a navigation; its own stylesheet and the icons from the precache.
    const { pathname } = new URL(request.url);
    const target =
      request.mode === 'navigate'
        ? OFFLINE_URL
        : PRECACHE_URLS.includes(pathname)
          ? pathname
          : null;
    const response = target ? await deps.cached(target) : undefined;
    if (response) return response;
    throw error;
  }
}

export async function precache(cache: Pick<Cache, 'addAll'>): Promise<void> {
  await cache.addAll(PRECACHE_URLS);
}

/** `activate`: delete every cache but the current one. */
export async function dropOldCaches(
  store: Pick<CacheStorage, 'keys' | 'delete'>,
  current: string,
): Promise<void> {
  const names = await store.keys();
  await Promise.all(names.filter((name) => name !== current).map((name) => store.delete(name)));
}

// R-NTF-12: service worker push, notificationclick and pushsubscriptionchange handlers.

export const PUSH_ICON_URL = '/icons/icon-192.png';
export const FALLBACK_NOTIFICATION_TITLE = 'Class Hub';
export const FALLBACK_NOTIFICATION_BODY = 'Thông báo mới · New notification';

export interface SwShownNotification {
  title: string;
  body?: string;
  tag?: string;
  data?: Record<string, unknown>;
  close?: () => void;
}

export interface SwShowNotificationOptions {
  body: string;
  tag: string;
  icon: string;
  renotify: boolean;
  data: Record<string, unknown>;
}

export interface SwPushRegistration {
  getNotifications(filter?: { tag?: string }): Promise<SwShownNotification[]>;
  showNotification(title: string, options: SwShowNotificationOptions): Promise<void>;
  pushManager?: {
    subscribe(options: {
      userVisibleOnly: boolean;
      applicationServerKey?: BufferSource | null;
    }): Promise<PushSubscription>;
  };
}

interface ParsedSwPushPayload {
  kind: string;
  title: string;
  body: string;
  url: string;
  tag: string;
  /** R-UI-10: localized merge title with `{n}`; absent on payloads from older servers. */
  merge?: string;
}

function mergedChatTitle(template: string | undefined, count: number): string {
  return template ? template.replace('{n}', String(count)) : `Class chat · ${count} new messages`;
}

function parseSwPushPayload(rawText: string | null | undefined): ParsedSwPushPayload | null {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    if (
      typeof parsed.kind !== 'string' ||
      typeof parsed.title !== 'string' ||
      !parsed.title.trim() ||
      typeof parsed.body !== 'string' ||
      typeof parsed.url !== 'string' ||
      typeof parsed.tag !== 'string' ||
      !parsed.tag.trim()
    ) {
      return null;
    }
    return {
      kind: parsed.kind,
      title: parsed.title,
      body: parsed.body,
      url: parsed.url,
      tag: parsed.tag,
      merge:
        typeof parsed.merge === 'string' && parsed.merge.includes('{n}') ? parsed.merge : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * R-NTF-12 / AC-NTF-11: shows one notification from the payload (merging `chat` and `reply`
 * notifications with the same tag into the last 3 lines), or a generic bilingual fallback
 * when the payload does not parse so iOS never revokes the subscription.
 */
export async function handlePush(
  rawText: string | null | undefined,
  registration: SwPushRegistration,
): Promise<void> {
  const payload = parseSwPushPayload(rawText);
  const show = (
    title: string,
    body: string,
    tag: string,
    data: Record<string, unknown>,
  ): Promise<void> =>
    registration.showNotification(title, { body, tag, icon: PUSH_ICON_URL, renotify: true, data });
  if (!payload) {
    await show(FALLBACK_NOTIFICATION_TITLE, FALLBACK_NOTIFICATION_BODY, 'fallback', {
      url: '/',
      count: 1,
      lines: [],
    });
    return;
  }

  const isChat = payload.kind === 'chat' || payload.tag === 'chat';
  const isReply = payload.kind === 'reply' || payload.tag.startsWith('reply-');

  if (isChat || isReply) {
    const existing = await registration.getNotifications({ tag: payload.tag });
    const prev = existing[0];
    const sepIndex = payload.title.indexOf(' · ');
    const senderName = sepIndex > 0 ? payload.title.slice(0, sepIndex) : payload.title;
    const threadTitle = sepIndex > 0 ? payload.title.slice(sepIndex + 3) : payload.title;
    const line = isChat ? `${payload.title}: ${payload.body}` : `${senderName}: ${payload.body}`;
    const kind = isChat ? 'chat' : 'reply';
    // A reply carries its thread title so a merged notification keeps it.
    const extra = isChat ? {} : { threadTitle };
    if (!prev) {
      await show(payload.title, payload.body, payload.tag, {
        url: payload.url,
        count: 1,
        lines: [line],
        ...extra,
        kind,
      });
      return;
    }
    const prevCount = typeof prev.data?.count === 'number' ? prev.data.count : 1;
    const fallbackLines = isChat ? [`${prev.title}: ${prev.body ?? ''}`] : [line];
    const prevLines = Array.isArray(prev.data?.lines)
      ? (prev.data.lines as string[])
      : fallbackLines;
    const nextCount = prevCount + 1;
    const nextLines = [...prevLines, line].slice(-3);
    const mergedThread =
      typeof prev.data?.threadTitle === 'string' ? prev.data.threadTitle : threadTitle;
    for (const item of existing) item.close?.();
    await show(
      isChat ? mergedChatTitle(payload.merge, nextCount) : mergedThread,
      nextLines.join('\n'),
      payload.tag,
      {
        url: payload.url,
        count: nextCount,
        lines: nextLines,
        ...(isChat ? {} : { threadTitle: mergedThread }),
        kind,
      },
    );
    return;
  }

  await show(payload.title, payload.body, payload.tag, {
    url: payload.url,
    count: 1,
    kind: payload.kind,
  });
}

/** R-NTF-12 / AC-NTF-11: normalizes a notification target URL to a same-origin path, else `/`. */
export function resolveNotificationClickPath(rawUrl: unknown, origin: string): string {
  if (typeof rawUrl !== 'string') return '/';
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('//')) return '/';
  try {
    const parsed = new URL(trimmed, origin);
    if (parsed.origin !== origin) return '/';
    // A pathname such as `//host` or `/\host` would resolve off-site as a protocol-relative URL.
    if (/^\/[\\/]/.test(parsed.pathname)) return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return '/';
  }
}

export interface SwWindowClient {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
}

export interface SwClients {
  matchAll(options?: { type?: 'window'; includeUncontrolled?: boolean }): Promise<SwWindowClient[]>;
  openWindow(url: string): Promise<unknown>;
}

/** R-NTF-12 / AC-NTF-11: closes notification, focuses + navigates an open window or opens a new one. */
export async function handleNotificationClick(
  notification: { data?: Record<string, unknown>; close?: () => void },
  clients: SwClients,
  origin: string,
): Promise<string> {
  notification.close?.();
  const path = resolveNotificationClickPath(notification.data?.url, origin);
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sameOriginWin =
    windows.find((w) => {
      try {
        return new URL(w.url).origin === origin;
      } catch {
        return false;
      }
    }) ?? windows[0];

  if (sameOriginWin) {
    if (sameOriginWin.navigate) {
      await sameOriginWin.navigate(path);
    }
    await sameOriginWin.focus();
    return path;
  }
  await clients.openWindow(path);
  return path;
}

function bufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The endpoint and key pair a subscription POST carries, or null when the browser withholds any. */
export function extractSubscriptionKeys(
  sub: PushSubscription,
): { endpoint: string; p256dh: string; auth: string } | null {
  const json = typeof sub.toJSON === 'function' ? sub.toJSON() : undefined;
  const p256dh =
    json?.keys?.p256dh ??
    (typeof sub.getKey === 'function' ? bufferToBase64Url(sub.getKey('p256dh')) : '');
  const auth =
    json?.keys?.auth ??
    (typeof sub.getKey === 'function' ? bufferToBase64Url(sub.getKey('auth')) : '');
  if (!sub.endpoint || !p256dh || !auth) return null;
  return { endpoint: sub.endpoint, p256dh, auth };
}

/** R-NTF-12: best-effort re-subscribe and POST on `pushsubscriptionchange`. */
export async function handlePushSubscriptionChange(
  event: {
    newSubscription?: PushSubscription | null;
    oldSubscription?: PushSubscription | null;
  },
  registration: SwPushRegistration,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<void> {
  try {
    const sub =
      event.newSubscription ??
      (registration.pushManager
        ? await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: event.oldSubscription?.options?.applicationServerKey ?? null,
          })
        : null);
    if (!sub) return;
    const keys = extractSubscriptionKeys(sub);
    if (!keys) return;

    await fetchFn('/api/v1/notifications/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(keys),
    });
  } catch {
    // R-NTF-12: fails silently without a live Access session; R-NTF-11 heals on next visit.
  }
}
