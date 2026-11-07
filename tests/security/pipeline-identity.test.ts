import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { createTestKey, type TestKey } from '../fixtures/access-jwt';
import { forgedCases } from '../fixtures/forged-identity';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;
let stranger: TestKey;

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database);
  stranger = await createTestKey('stranger-key');
});

afterAll(() => database.close());

async function expectDenied(response: Response, kind: 'page' | 'api') {
  if (kind === 'page') {
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/denied');
  } else {
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  }
}

describe('forged identity through the request pipeline', () => {
  it('AC-AUTH-01 AC-AUTH-02 every forged or unverifiable assertion gets the uniform denial', async () => {
    // Every case carries an active member's email, so only the assertion is wrong.
    const cases = await forgedCases(harness.teamKey, stranger);
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const forged of cases) {
      const headers = await forged.headers();
      if (headers['cf-access-authenticated-user-email']) {
        headers['cf-access-authenticated-user-email'] = PEOPLE.active.email;
      }
      await expectDenied(await harness.send('/members', { headers }), 'page');
      await expectDenied(await harness.send('/api/v1/me', { headers, routeId: null }), 'api');
    }
    expect(harness.resolved).toEqual([]);
  });

  it('INV-1 a verified identity without an active membership is denied', async () => {
    for (const person of [PEOPLE.unknown, PEOPLE.suspended, PEOPLE.revoked, PEOPLE.expired]) {
      await expectDenied(
        await harness.send('/members', { headers: await harness.as(person.email) }),
        'page',
      );
    }
    expect(harness.resolved).toEqual([]);
  });

  it('R-PLAT-01 an active member reaches the route with locals.member set', async () => {
    let seen: unknown;
    const own = await createHarness(database, {
      resolve: (event) => {
        seen = event.locals.member;
        return new Response('ok');
      },
    });
    // R-AUTH-06: the JWT email is trimmed and lower-cased before lookup.
    const response = await own.send('/members', {
      headers: await own.as(`  ${PEOPLE.active.email.toUpperCase()} `),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual({
      id: PEOPLE.active.id,
      role: 'member',
      displayName: 'Active Member',
      avatarMediaId: null,
    });
  });

  it('R-AUTH-23 logs the member as a hash under the LOG_HASH_SALT secret', async () => {
    const { saltedHash } = await import('../../src/lib/server/log');
    const { captured } = await import('./setup-log-capture');
    const own = await createHarness(database, { logHashSalt: 'deployment-salt' });
    const start = captured.length;
    await own.send('/members', { headers: await own.as(PEOPLE.active.email) });
    const line = JSON.parse(captured[start]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      method: 'GET',
      route: '/members',
      status: 200,
      member: await saltedHash('deployment-salt', PEOPLE.active.id),
    });
    expect(Object.keys(line).sort()).toEqual(['member', 'method', 'requestId', 'route', 'status']);
  });

  it('a JSON data request is redirected the way SvelteKit expects', async () => {
    const response = await harness.send('/members', { isDataRequest: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 'redirect', location: '/denied' });
  });

  it('fails closed when the context cannot be created', async () => {
    const { createSecurityHandle } = await import('../../src/lib/server/pipeline');
    const handle = createSecurityHandle({
      getContext: async () => {
        throw new Error('missing D1 binding: DB');
      },
      production: false,
    });
    const request = new Request(`${ORIGIN}/members`);
    const response = await handle({
      event: {
        request,
        url: new URL(request.url),
        locals: { locale: 'en' },
        route: { id: '/members' },
        isDataRequest: false,
        getClientAddress: () => '203.0.113.7',
      } as never,
      resolve: () => {
        throw new Error('must not resolve');
      },
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('unavailable');
  });
});
