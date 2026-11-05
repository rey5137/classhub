import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// AC-API-01: the route manifest is every route file under src/routes plus every
// row of the §11.2 table, so a route is swept before and after it is built.

const PUBLIC = ['GET /health', 'GET /denied'];

interface Route {
  method: string;
  path: string;
  upgrade?: boolean;
}

function sample(path: string): string {
  return path.replace(/\[[^\]]+\]|:[a-z]+/gi, 'sample-id');
}

function fileRoutes(dir = 'src/routes'): Route[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): Route[] => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return fileRoutes(full);
    const route =
      '/' +
      relative('src/routes', dir)
        .split(sep)
        .filter((part) => !/^\(.*\)$/.test(part))
        .join('/');
    const path = route === '/' ? '/' : route.replace(/\/$/, '');
    if (entry.name === '+page.svelte') return [{ method: 'GET', path }];
    if (/^\+server\.(ts|js)$/.test(entry.name)) {
      const source = readFileSync(full, 'utf8');
      return [
        ...source.matchAll(
          /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
        ),
      ].map((match) => ({ method: match[1]!, path }));
    }
    return [];
  });
}

function specRoutes(): Route[] {
  const spec = readFileSync('docs/spec/platform/11-api.md', 'utf8');
  const table = spec.slice(spec.indexOf('## 11.2 Routes'), spec.indexOf('## 11.3'));
  const routes: Route[] = [];
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 4 || !cells[2]?.startsWith('`/')) continue;
    const paths = [...cells[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    for (const method of [...cells[1]!.matchAll(/`([A-Z]+)`( \(upgrade\))?/g)]) {
      for (const path of paths) routes.push({ method: method[1]!, path, upgrade: !!method[2] });
    }
  }
  return routes;
}

const manifest = [...fileRoutes(), ...specRoutes()].map((route) => ({
  ...route,
  path: sample(route.path),
}));
const key = (route: Route) => `${route.method} ${route.path}`;
const unique = [...new Map(manifest.map((route) => [key(route), route])).values()];

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
      expect.arrayContaining(['GET /api/v1/chat/ws', 'PATCH /api/v1/me', ...PUBLIC]),
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

  it('AC-API-01 only GET and HEAD of exactly /health and /denied are public', async () => {
    const cases: [string, string, number][] = [
      ['GET', '/denied/x', 303],
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

  it('AC-API-03 GET /health and /denied answer without identity', async () => {
    expect((await harness.send('/health')).status).toBe(200);
    expect((await harness.send('/denied')).status).toBe(403);
    expect(harness.resolved.splice(0)).toEqual(['GET /health', 'GET /denied']);
  });
});
