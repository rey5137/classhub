import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database);
});

afterAll(() => database.close());

const requests = [
  { name: 'POST', method: 'POST', path: '/api/v1/posts', json: true },
  { name: 'PUT', method: 'PUT', path: '/api/v1/media/reservations/r1/full', json: false },
  { name: 'PATCH', method: 'PATCH', path: '/api/v1/me', json: true },
  { name: 'DELETE', method: 'DELETE', path: '/api/v1/posts/p1', json: false },
  { name: 'form POST to a page', method: 'POST', path: '/profile', json: false },
  { name: 'WebSocket upgrade', method: 'GET', path: '/api/v1/chat/ws', json: false },
];

function init(request: (typeof requests)[number], origin: string | undefined) {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers.origin = origin;
  if (request.name === 'WebSocket upgrade') headers.upgrade = 'websocket';
  if (request.json) headers['content-type'] = 'application/json';
  const body =
    request.method === 'GET' || request.method === 'DELETE' ? null : request.json ? '{}' : 'a=1';
  return { method: request.method, headers, body, routeId: null };
}

describe('cross-origin requests', () => {
  for (const origin of ['https://evil.example.test', 'null', undefined]) {
    it(`AC-AUTH-07 refuses mutating requests and the upgrade with Origin ${origin ?? '(none)'}`, async () => {
      for (const request of requests) {
        const options = init(request, origin);
        // Even an active member's valid assertion does not help.
        options.headers = { ...options.headers, ...(await harness.as(PEOPLE.active.email)) };
        const response = await harness.send(request.path, options);
        expect(response.status, request.name).toBe(403);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code, request.name).toBe('forbidden');
      }
      expect(harness.resolved).toEqual([]);
    });
  }

  it('AC-AUTH-07 a cross-origin form POST gets the R-API-02 body and the §6.7 headers', async () => {
    const config = (await import('../../svelte.config.js')).default;
    // SvelteKit's own check (plain-text 403, no headers) is off; the hook is the only one.
    expect(config.kit?.csrf?.trustedOrigins).toEqual(['*']);
    for (const path of ['/api/v1/posts', '/profile']) {
      const response = await harness.send(path, {
        method: 'POST',
        routeId: null,
        headers: {
          origin: 'https://evil.example.test',
          'content-type': 'application/x-www-form-urlencoded',
          ...(await harness.as(PEOPLE.active.email)),
        },
        body: 'title=hello',
      });
      expect(response.status, path).toBe(403);
      const body = errorBodySchema.parse(await response.json());
      expect(body.error.code).toBe('forbidden');
      expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
      for (const header of [
        'content-security-policy',
        'strict-transport-security',
        'referrer-policy',
        'x-content-type-options',
        'permissions-policy',
        'x-robots-tag',
      ]) {
        expect(response.headers.get(header), `${path} ${header}`).toBeTruthy();
      }
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(harness.resolved).toEqual([]);
  });

  it('AC-AUTH-07 lets the same requests through from the site origin', async () => {
    for (const request of requests) {
      const options = init(request, ORIGIN);
      options.headers = { ...options.headers, ...(await harness.as(PEOPLE.active.email)) };
      const response = await harness.send(request.path, options);
      expect(response.status, request.name).toBe(200);
    }
    expect(harness.resolved).toHaveLength(requests.length);
  });
});
