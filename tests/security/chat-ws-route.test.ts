import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createDurableObjectHub } from '../../src/lib/server/adapters/cloudflare/realtime-hub';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { siteSettings } from '../../src/lib/server/db/schema';
import { CONTEXT_HEADER, verifyContext } from '../../src/lib/server/internal-context';
import type { RealtimeHub, RealtimeMember } from '../../src/lib/server/ports/realtime';
import { GET } from '../../src/routes/api/v1/chat/ws/+server';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// R-CHAT-04 / R-AUTH-17: `/api/v1/chat/ws` checks identity, membership, Origin, the lock
// and the chat flag in the pipeline, so a refused upgrade never reaches the hub, and the
// hub's request to the room carries only the upgrade and the signed context.

const PATH = '/api/v1/chat/ws';
const ROUTE_ID = '/api/v1/chat/ws';
const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
const connects: { member: RealtimeMember; request: Request }[] = [];
let failConnect = false;
const hub: RealtimeHub = {
  async connect(request, member) {
    connects.push({ request, member });
    if (failConnect) throw new Error('INTERNAL_CONTEXT_KEY is not set');
    return new Response(null, { status: 204, headers: { 'x-from-hub': '1' } });
  },
  async disconnectMember() {},
  async notify() {},
};
let harness: Harness;

const route = (event: RequestEvent) =>
  (GET as unknown as (event: RequestEvent) => Promise<Response>)(event);

beforeAll(async () => {
  await seedMembership(database);
  harness = await createHarness(database, { resolve: route, realtime: hub });
});

afterAll(() => database.close());

async function upgrade(headers: Record<string, string>) {
  return harness.send(PATH, {
    headers: { upgrade: 'websocket', origin: ORIGIN, ...headers },
    routeId: ROUTE_ID,
  });
}

async function code(response: Response): Promise<string> {
  return errorBodySchema.parse(await response.json()).error.code;
}

describe('chat socket route (R-CHAT-04)', () => {
  it('R-CHAT-04 refuses an upgrade with no Access identity before the hub', async () => {
    const response = await upgrade({
      'cf-access-authenticated-user-email': PEOPLE.active.email,
    });
    expect([response.status, await code(response)]).toEqual([403, 'forbidden']);
    expect(connects).toEqual([]);
  });

  it('R-CHAT-04 refuses a suspended member, an invite and an unknown email before the hub', async () => {
    for (const email of [PEOPLE.suspended.email, PEOPLE.revoked.email, PEOPLE.unknown.email]) {
      const response = await upgrade(await harness.as(email));
      expect([email, response.status, await code(response)]).toEqual([email, 403, 'forbidden']);
    }
    expect(connects).toEqual([]);
  });

  it('R-AUTH-17 refuses an upgrade from another origin, or with none, before the hub', async () => {
    const identity = await harness.as(PEOPLE.active.email);
    for (const origin of ['https://evil.example.test', 'null']) {
      const response = await upgrade({ ...identity, origin });
      expect([origin, response.status, await code(response)]).toEqual([origin, 403, 'forbidden']);
    }
    const missing = await harness.send(PATH, {
      headers: { upgrade: 'websocket', ...identity },
      routeId: ROUTE_ID,
    });
    expect(missing.status).toBe(403);
    expect(connects).toEqual([]);
  });

  it('R-CHAT-04 answers 423 while the site is locked, before the hub', async () => {
    await setSetupState(database, 'locked');
    try {
      const response = await upgrade(await harness.as(PEOPLE.active.email));
      expect([response.status, await code(response)]).toEqual([423, 'locked']);
    } finally {
      await setSetupState(database, 'unlocked');
    }
    expect(connects).toEqual([]);
  });

  it('R-NAV-02 answers feature_disabled while chat is off, before the hub', async () => {
    await database.db.insert(siteSettings).values({
      key: 'features',
      valueJson: JSON.stringify({ memories: true, discussions: true, chat: false }),
    });
    try {
      const response = await upgrade(await harness.as(PEOPLE.active.email));
      expect([response.status, await code(response)]).toEqual([404, 'feature_disabled']);
    } finally {
      await database.db.delete(siteSettings);
      await setSetupState(database, 'unlocked');
    }
    expect(connects).toEqual([]);
  });

  it('R-CHAT-04 a plain GET without the upgrade is the uniform not_found', async () => {
    const response = await harness.send(PATH, {
      headers: await harness.as(PEOPLE.active.email),
      routeId: ROUTE_ID,
    });
    expect([response.status, await code(response)]).toEqual([404, 'not_found']);
    expect(connects).toEqual([]);
  });

  it('R-CHAT-04 hands an active member to the hub with authUntil = the Access JWT exp', async () => {
    const identity = await harness.as(PEOPLE.active.email);
    const response = await upgrade(identity);
    expect(response.headers.get('x-from-hub')).toBe('1');
    const token = identity['cf-access-jwt-assertion']!;
    const { exp } = JSON.parse(
      atob(token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')),
    );
    expect(connects.splice(0).map((call) => call.member)).toEqual([
      {
        id: PEOPLE.active.id,
        role: 'member',
        displayName: 'Active Member',
        authUntil: exp * 1000,
      },
    ]);
  });

  it('R-CHAT-04 a hub that cannot sign answers unavailable', async () => {
    failConnect = true;
    try {
      const response = await upgrade(await harness.as(PEOPLE.active.email));
      expect([response.status, await code(response)]).toEqual([503, 'unavailable']);
    } finally {
      failConnect = false;
      connects.splice(0);
    }
  });

  it('R-CHAT-04 the room request is built from scratch: no client header, a fresh context', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const rooms = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (url: string, init: RequestInit) => {
          calls.push({ url: `${id} ${url}`, headers: new Headers(init.headers) });
          return new Response(null, { status: 204 });
        },
      }),
    };
    const key = 'route-test-key';
    const doHub = createDurableObjectHub(
      rooms as unknown as Parameters<typeof createDurableObjectHub>[0],
      key,
    );
    const member = { id: 'm-1', role: 'member' as const, displayName: 'An', authUntil: 9e12 };
    await doHub.connect(
      new Request(`${ORIGIN}${PATH}`, {
        headers: {
          upgrade: 'websocket',
          origin: ORIGIN,
          cookie: 'CF_Authorization=secret-cookie',
          'cf-access-jwt-assertion': 'secret-jwt',
          'x-classhub-context': 'forged-by-client',
        },
      }),
      member,
    );
    expect(calls).toHaveLength(1);
    // Only the site origin travels on, as the VAPID `sub` (R-NTF-01); no client header does.
    expect(calls[0]!.url).toBe(
      `main https://chat-room.internal/connect?origin=${encodeURIComponent(ORIGIN)}`,
    );
    expect([...calls[0]!.headers.keys()].sort()).toEqual(['upgrade', CONTEXT_HEADER]);
    const context = await verifyContext(calls[0]!.headers.get(CONTEXT_HEADER), key);
    expect(context).toMatchObject({ memberId: 'm-1', role: 'member', authUntil: 9e12 });
    await expect(
      createDurableObjectHub(
        rooms as unknown as Parameters<typeof createDurableObjectHub>[0],
        undefined,
      ).connect(new Request(`${ORIGIN}${PATH}`), member),
    ).rejects.toThrow('INTERNAL_CONTEXT_KEY');
  });
});
