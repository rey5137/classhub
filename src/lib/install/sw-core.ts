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
