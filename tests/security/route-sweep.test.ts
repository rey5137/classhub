import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';
import { fileRoutes, key, specRoutes, unique } from '../fixtures/route-manifest';

const PUBLIC = ['GET /health', 'GET /denied', 'GET /locked'];

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database);
});

afterAll(() => database.close());

describe('route sweep', () => {
  it('reads a manifest with every page and every §11.2 route', () => {
    expect(fileRoutes().length).toBeGreaterThanOrEqual(13);
    expect(specRoutes().length).toBeGreaterThanOrEqual(43);
    expect(unique.map(key)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/chat/ws',
        'PATCH /api/v1/me',
        'GET /admin/setup',
        'POST /admin',
        'DELETE /api/v1/admin/invites',
        'PATCH /api/v1/admin/members/sample-id',
        ...PUBLIC,
      ]),
    );
  });

  it('AC-API-01 sweeps the §4 routes as built files, not only as spec rows', () => {
    expect(fileRoutes().map(key)).toEqual(
      expect.arrayContaining([
        'GET /api/v1/me',
        'PATCH /api/v1/me',
        'GET /api/v1/me/export',
        'POST /api/v1/me/deletion-request',
        'GET /api/v1/members',
        'GET /api/v1/members/[id]',
      ]),
    );
  });

  it('AC-API-01 every route except GET /health and /denied refuses a request with no identity', async () => {
    const reached: string[] = [];
    for (const route of unique) {
      if (PUBLIC.includes(key(route))) continue;
      const mutating = route.method !== 'GET';
      const response = await harness.send(route.path, {
        method: route.method,
        routeId: null,
        headers: {
          ...(mutating ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
          ...(route.upgrade ? { upgrade: 'websocket', origin: ORIGIN } : {}),
          // AC-AUTH-02: the forged email header is present on every request.
          'cf-access-authenticated-user-email': 'active.member@example.test',
        },
        body: mutating && route.method !== 'DELETE' ? '{}' : null,
      });
      const pageNavigation = !route.path.startsWith('/api/') && route.method === 'GET';
      if (pageNavigation) {
        expect([key(route), response.status, response.headers.get('location')]).toEqual([
          key(route),
          303,
          '/denied',
        ]);
      } else {
        expect([key(route), response.status]).toEqual([key(route), 403]);
        // R-API-02: the error shape on every failure, its id echoed in the header.
        const body = errorBodySchema.parse(await response.json());
        expect([key(route), body.error.code]).toEqual([key(route), 'forbidden']);
        expect(body.error.requestId).toBe(response.headers.get('x-request-id'));
      }
      reached.push(...harness.resolved.splice(0));
    }
    expect(reached).toEqual([]);
  });

  it('AC-API-01 only GET and HEAD of exactly /health, /denied and /locked are public', async () => {
    const cases: [string, string, number][] = [
      ['GET', '/denied/x', 303],
      ['GET', '/locked/x', 303],
      ['POST', '/locked', 403],
      ['GET', '/health/x', 303],
      ['POST', '/denied', 403],
      ['DELETE', '/denied', 403],
      ['POST', '/health', 403],
      ['PUT', '/health', 403],
    ];
    for (const [method, path, status] of cases) {
      const response = await harness.send(path, {
        method,
        headers: method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/json' },
        body: method === 'POST' || method === 'PUT' ? '{}' : null,
      });
      expect([method, path, response.status]).toEqual([method, path, status]);
    }
    expect(harness.resolved.splice(0)).toEqual([]);
    expect((await harness.send('/health', { method: 'HEAD' })).status).toBe(200);
    expect(harness.resolved.splice(0)).toEqual(['HEAD /health']);
  });

  it('AC-API-03 GET /health, /denied and /locked answer without identity', async () => {
    expect((await harness.send('/health')).status).toBe(200);
    expect((await harness.send('/denied')).status).toBe(403);
    expect((await harness.send('/locked')).status).toBe(200);
    expect(harness.resolved.splice(0)).toEqual(['GET /health', 'GET /denied', 'GET /locked']);
  });
});
