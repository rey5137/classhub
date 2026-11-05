import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCloudflareContext } from '../../src/lib/server/adapters/cloudflare/context';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { GET as health } from '../../src/routes/health/+server';
import { signAccessJwt } from '../fixtures/access-jwt';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

let harness: Harness;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database, {
    resolve: async (event) => {
      if (event.url.pathname === '/health') return health();
      if (event.url.pathname === '/boom') throw new Error('database went away');
      const nonce = 'n0nce';
      return new Response(`<p>${event.url.pathname}</p>`, {
        headers: {
          'content-type': 'text/html',
          'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self'`,
        },
      });
    },
  });
});

const STATIC_CSP =
  "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; script-src 'self'; " +
  "style-src 'self'; style-src-attr 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; " +
  "base-uri 'none'";

const EXPECTED = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'private, no-store',
};

function expectHeaders(name: string, response: Response) {
  for (const [header, value] of Object.entries(EXPECTED)) {
    expect(response.headers.get(header), `${name}: ${header}`).toBe(value);
  }
  const csp = response.headers.get('content-security-policy') ?? '';
  // A response SvelteKit did not render gets the full static policy; a page keeps SvelteKit's.
  if (csp.includes("'nonce-")) expect(csp, name).toMatch(/^default-src 'self'/);
  else expect(csp, name).toBe(STATIC_CSP);
  expect(response.headers.get('x-request-id'), name).toMatch(/^[0-9a-f-]{36}$/);
}

describe('response headers on the Workers runtime', () => {
  it('AC-AUTH-08 every kind of response carries the §6.7 headers', async () => {
    const member = await harness.as(PEOPLE.active.email);
    const responses: Record<string, Response> = {
      'GET /health': await harness.send('/health'),
      'GET /denied': await harness.send('/denied'),
      'denied page': await harness.send('/members'),
      'denied data request': await harness.send('/members', { isDataRequest: true }),
      'denied API': await harness.send('/api/v1/me', { routeId: null }),
      'cross-origin POST': await harness.send('/api/v1/posts', {
        method: 'POST',
        headers: { origin: 'https://evil.example.test', ...member },
      }),
      'payload too large': await harness.send('/api/v1/posts', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...member },
        body: ' '.repeat(70_000),
      }),
      'member page': await harness.send('/members', { headers: member }),
      'route error': await harness.send('/boom', { headers: member }),
    };
    for (const [name, response] of Object.entries(responses)) expectHeaders(name, response);
    expect(responses['member page']!.status).toBe(200);
    expect(responses['route error']!.status).toBe(503);
  });

  it('AC-AUTH-08 a rendered page keeps its script nonce and gains it on style-src', async () => {
    const response = await harness.send('/members', {
      headers: await harness.as(PEOPLE.active.email),
    });
    const csp = response.headers.get('content-security-policy');
    expect(csp).toBe(
      "default-src 'self'; script-src 'self' 'nonce-n0nce'; style-src 'self' 'nonce-n0nce'",
    );
  });

  it('AC-API-03 /health stays public through the pipeline and returns only ok and version', async () => {
    const response = await harness.send('/health');
    expect(response.status).toBe(200);
    expect(Object.keys((await response.json()) as object).sort()).toEqual(['ok', 'version']);
  });

  it('INV-1 the D1 lookup admits only active rows', async () => {
    for (const person of [PEOPLE.suspended, PEOPLE.revoked, PEOPLE.expired, PEOPLE.unknown]) {
      const response = await harness.send('/members', { headers: await harness.as(person.email) });
      expect(response.status, person.email).toBe(303);
    }
    const admin = await harness.send('/members', { headers: await harness.as(PEOPLE.admin.email) });
    expect(admin.status).toBe(200);
  });

  it('R-AUTH-05 the Cloudflare context verifies nobody without ACCESS_TEAM_DOMAIN and ACCESS_AUD', async () => {
    const context = createCloudflareContext({ DB: env.DB, MEDIA: env.MEDIA });
    const request = new Request(`${ORIGIN}/members`, {
      headers: { 'cf-access-jwt-assertion': await signAccessJwt(harness.teamKey) },
    });
    await expect(context.identity.requireIdentity(request, { clientAddress: '' })).rejects.toThrow(
      'Access is not configured',
    );
  });
});
