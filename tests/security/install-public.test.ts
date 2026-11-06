import { readFileSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { GET as manifestGet } from '../../src/routes/manifest.webmanifest/+server';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// R-NAV-07 / R-AUTH-03: the manifest and /icons/ sit in an Access Bypass application.

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;
const members: unknown[] = [];

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database, {
    resolve: (event: RequestEvent) => {
      members.push(event.locals.member);
      if (event.url.pathname === '/manifest.webmanifest') {
        return manifestGet(event as Parameters<typeof manifestGet>[0]) as Response;
      }
      return new Response('png', { headers: { 'content-type': 'image/png' } });
    },
  });
});

afterAll(() => database.close());

describe('install files outside Access', () => {
  it('AC-NAV-06 the manifest without any identity holds exactly the R-NAV-07 fields', async () => {
    const response = await harness.send('/manifest.webmanifest');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as Record<string, unknown> & { icons: unknown };
    expect(Object.keys(body).sort()).toEqual(
      [
        'background_color',
        'display',
        'icons',
        'id',
        'lang',
        'name',
        'scope',
        'short_name',
        'start_url',
        'theme_color',
      ].sort(),
    );
    expect(body).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      name: 'Our Class',
      short_name: 'Our Class',
      lang: 'vi',
      theme_color: '#f0f9fd',
      background_color: '#f0f9fd',
    });
    expect(body.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]);
  });

  it('AC-NAV-06 the icons the manifest names exist as PNGs of the stated size', () => {
    for (const [file, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['icon-maskable-512.png', 512],
      ['apple-touch-icon.png', 180],
    ] as const) {
      const png = readFileSync(`static/icons/${file}`);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    }
  });

  it('AC-NAV-06 a JWT on the manifest or an icon resolves no member', async () => {
    members.length = 0;
    const headers = await harness.as(PEOPLE.active.email);
    expect((await harness.send('/manifest.webmanifest', { headers })).status).toBe(200);
    expect((await harness.send('/icons/icon-192.png', { headers })).status).toBe(200);
    expect(members).toEqual([null, null]);
  });

  it('AC-NAV-06 nothing else under the Bypass paths answers without identity', async () => {
    harness.resolved.splice(0);
    const cases: [string, string][] = [
      ['GET', '/icons'],
      ['GET', '/icons/'],
      ['GET', '/icons/a/b.png'],
      ['GET', '/manifest.webmanifest/'],
      ['GET', '/icons/icon-192.png/'],
      ['GET', '/icons/a/'],
      ['GET', '/icons/nonexistent.png'],
      ['GET', '/icons/..%2fadmin'],
      ['GET', '/manifest.webmanifest/x'],
      ['GET', '/install'],
      ['POST', '/manifest.webmanifest'],
      ['PUT', '/icons/icon-192.png'],
      ['DELETE', '/icons/icon-192.png'],
    ];
    for (const [method, path] of cases) {
      const response = await harness.send(path, {
        method,
        headers: method === 'GET' ? {} : { origin: ORIGIN },
      });
      // A page asks for Access: the uniform denial redirect; anything else is refused.
      expect([method, path, response.status]).toEqual([method, path, method === 'GET' ? 303 : 403]);
    }
    expect(harness.resolved.splice(0)).toEqual([]);
  });
});
