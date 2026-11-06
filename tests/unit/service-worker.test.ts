import { describe, expect, it, vi } from 'vitest';
import {
  cacheNameFor,
  dropOldCaches,
  OFFLINE_URL,
  PRECACHE_URLS,
  precache,
  respond,
  type FetchDeps,
} from '../../src/lib/install/sw-core';

const ORIGIN = 'https://classhub.example.test';
const OFFLINE = new Response('offline page');
const CSS = new Response('body{}');

function deps(fetchImpl: FetchDeps['fetch']): FetchDeps {
  return {
    origin: ORIGIN,
    fetch: fetchImpl,
    cached: async (pathname) =>
      pathname === OFFLINE_URL ? OFFLINE : pathname === '/offline.css' ? CSS : undefined,
  };
}
const navigate = (path = '/') => {
  const request = new Request(`${ORIGIN}${path}`);
  Object.defineProperty(request, 'mode', { value: 'navigate' });
  return request;
};
const down = () => Promise.reject(new TypeError('Failed to fetch'));

describe('service worker fetch handler', () => {
  it('AC-NAV-07 a navigation that fails with a network error gets the offline page', async () => {
    expect(await respond(navigate('/memories'), deps(down))).toBe(OFFLINE);
  });

  it('AC-NAV-07 a failing subresource is not answered with the offline page', async () => {
    await expect(respond(new Request(`${ORIGIN}/_app/x.js`), deps(down))).rejects.toThrow(
      'Failed to fetch',
    );
  });

  it('AC-NAV-07 a precached subresource is answered from the cache when the network fails', async () => {
    expect(await respond(new Request(`${ORIGIN}/offline.css`), deps(down))).toBe(CSS);
    // In the precache list but absent from the cache: the error stands.
    await expect(
      respond(new Request(`${ORIGIN}/icons/icon-192.png`), deps(down)),
    ).rejects.toThrow();
  });

  it('AC-NAV-07 any HTTP response, a redirect and a 500 included, passes through untouched', async () => {
    for (const response of [
      new Response(null, {
        status: 302,
        headers: { location: 'https://team.cloudflareaccess.com/' },
      }),
      new Response('boom', { status: 500 }),
      new Response('ok'),
    ]) {
      expect(
        await respond(
          navigate(),
          deps(async () => response),
        ),
      ).toBe(response);
    }
  });

  it('AC-NAV-07 non-GET, /api/, /cdn-cgi/, cross-origin and socket requests are left to the browser', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'));
    const requests = [
      new Request(`${ORIGIN}/api/v1/me`, { method: 'POST', body: '{}' }),
      new Request(`${ORIGIN}/profile`, { method: 'POST', body: '' }),
      new Request(`${ORIGIN}/api/v1/me`),
      new Request(`${ORIGIN}/api`),
      new Request(`${ORIGIN}/cdn-cgi/access/logout`),
      new Request('https://other.example.test/'),
      new Request(`${ORIGIN}/api/v1/chat/ws`, { headers: { upgrade: 'websocket' } }),
    ];
    for (const request of requests) expect(await respond(request, deps(fetchImpl))).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('AC-NAV-07 precaches only the offline page, its stylesheet and the icons, in a versioned cache', async () => {
    const cache = { addAll: vi.fn(async () => {}) };
    await precache(cache);
    expect(cache.addAll).toHaveBeenCalledWith(PRECACHE_URLS);
    expect(PRECACHE_URLS).toEqual([
      OFFLINE_URL,
      '/offline.css',
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
      '/icons/apple-touch-icon.png',
    ]);
    expect(cacheNameFor('abc')).toBe('classhub-abc');
  });

  it('AC-NAV-07 activate deletes every older cache and keeps the current one', async () => {
    const deleted: string[] = [];
    await dropOldCaches(
      {
        keys: async () => ['classhub-old', 'classhub-new', 'other'],
        delete: async (name) => {
          deleted.push(name);
          return true;
        },
      },
      'classhub-new',
    );
    expect(deleted.sort()).toEqual(['classhub-old', 'other']);
  });
});
