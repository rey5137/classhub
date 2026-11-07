import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { invites, siteSettings, users } from '../../src/lib/server/db/schema';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';
import { key, unique } from '../fixtures/route-manifest';

// R-AUTH-12: while locked, every route in the manifest answers /locked or `423 locked`
// for everyone; only the bootstrap admin reaches /admin/setup, and nothing else.

const PUBLIC = [
  'GET /health',
  'GET /manifest.webmanifest',
  'GET /denied',
  'GET /locked',
  'GET /privacy',
];
const OTHER_ADMIN = {
  id: '01900000-0000-7000-8000-000000000009',
  email: 'second.admin@example.test',
};
const SEEDED = [
  ...Object.values(PEOPLE).map((person) => person.email),
  OTHER_ADMIN.email,
  'Active Member',
  'Class Admin',
];

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
let harness: Harness;

beforeAll(async () => {
  await seedMembership(database, { setupState: 'locked' });
  // The bootstrap admin: `setup` creates their invite before anyone else exists (R-OPS-04).
  await database.db.insert(invites).values({
    id: '01900000-0000-7000-8000-0000000000b1',
    email: PEOPLE.admin.email,
    invitedBy: PEOPLE.admin.id,
    role: 'admin',
    status: 'accepted',
  });
  await database.db.insert(users).values({
    id: OTHER_ADMIN.id,
    authEmail: OTHER_ADMIN.email,
    displayName: 'Second Admin',
    displayNameNorm: 'second admin',
    role: 'admin',
    status: 'active',
  });
  await database.db.insert(invites).values({
    id: '01900000-0000-7000-8000-0000000000b2',
    email: OTHER_ADMIN.email,
    invitedBy: PEOPLE.admin.id,
    role: 'admin',
    status: 'accepted',
  });
  harness = await createHarness(database);
});

afterAll(() => database.close());

async function sweep(headers: Record<string, string>) {
  const answers: [string, number, string | null][] = [];
  for (const route of unique) {
    if (PUBLIC.includes(key(route))) continue;
    const mutating = route.method !== 'GET';
    const response = await harness.send(route.path, {
      method: route.method,
      routeId: null,
      headers: {
        ...headers,
        ...(mutating ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
        ...(route.upgrade ? { upgrade: 'websocket', origin: ORIGIN } : {}),
      },
      body: mutating && route.method !== 'DELETE' ? '{}' : null,
    });
    const body = await response.text();
    for (const text of SEEDED) expect(body, `${key(route)} leaks`).not.toContain(text);
    if (response.status === 423)
      expect(errorBodySchema.parse(JSON.parse(body)).error.code).toBe('locked');
    answers.push([key(route), response.status, response.headers.get('location')]);
  }
  return answers;
}

function expected(route: { method: string; path: string }, pageLocation: string) {
  const page = !route.path.startsWith('/api/') && route.method === 'GET';
  return page ? [key(route), 303, pageLocation] : [key(route), 423, null];
}

describe('setup lock (R-AUTH-12)', () => {
  it('AC-AUTH-06 shows /locked or 423 on every route to anyone who is not the bootstrap admin', async () => {
    const callers = [
      {},
      await harness.as(PEOPLE.unknown.email),
      await harness.as(PEOPLE.active.email),
      await harness.as(PEOPLE.suspended.email),
      await harness.as(OTHER_ADMIN.email),
    ];
    for (const headers of callers) {
      const answers = await sweep(headers);
      expect(answers).toEqual(
        unique
          .filter((route) => !PUBLIC.includes(key(route)))
          .map((route) => expected(route, '/locked')),
      );
    }
    expect(harness.resolved.splice(0)).toEqual([]);
  });

  it('AC-AUTH-06 lets the bootstrap admin reach /admin/setup and nothing else', async () => {
    const headers = await harness.as(PEOPLE.admin.email);
    const answers = await sweep(headers);
    const routes = unique.filter((route) => !PUBLIC.includes(key(route)));
    expect(answers).toEqual(
      routes.map((route) =>
        key(route) === 'GET /admin/setup'
          ? [key(route), 200, null]
          : expected(route, '/admin/setup'),
      ),
    );
    expect(harness.resolved.splice(0)).toEqual(['GET /admin/setup']);
    // HEAD of the setup page is let through, not redirected to itself.
    const head = await harness.send('/admin/setup', { method: 'HEAD', headers });
    expect([head.status, head.headers.get('location')]).toEqual([200, null]);
    expect(harness.resolved.splice(0)).toEqual(['HEAD /admin/setup']);
    // The data request of another page is redirected the same way, as JSON.
    const data = await harness.send('/members', { isDataRequest: true, headers });
    expect(await data.json()).toEqual({ type: 'redirect', location: '/admin/setup' });
  });

  it('AC-AUTH-06 treats a missing setup_state row as locked', async () => {
    await database.db.delete(siteSettings).where(eq(siteSettings.key, 'setup_state'));
    const response = await harness.send('/api/v1/me', {
      headers: await harness.as(PEOPLE.active.email),
    });
    expect(response.status).toBe(423);
    await setSetupState(database, 'unlocked');
    const open = await harness.send('/', { headers: await harness.as(PEOPLE.active.email) });
    expect(open.status).toBe(200);
    await setSetupState(database, 'locked');
    harness.resolved.splice(0);
  });

  it('AC-AUTH-06 locks even the setup page while the Access vars are missing', async () => {
    const unconfigured = await createHarness(database, { accessConfigured: false });
    const setup = await unconfigured.send('/admin/setup', {
      headers: await unconfigured.as(PEOPLE.admin.email),
    });
    expect([setup.status, setup.headers.get('location')]).toEqual([303, '/locked']);
    await setSetupState(database, 'unlocked');
    const api = await unconfigured.send('/api/v1/me', {
      headers: await unconfigured.as(PEOPLE.active.email),
    });
    expect(api.status).toBe(423);
    await setSetupState(database, 'locked');
    expect(unconfigured.resolved).toEqual([]);
  });
});
