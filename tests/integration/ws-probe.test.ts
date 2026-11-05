import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCloudflareContext } from '../../src/lib/server/adapters/cloudflare/context';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { createWsProbe } from '../../src/lib/server/adapters/cloudflare/ws-probe';
import type { Database } from '../../src/lib/server/ports/database';
import { GET } from '../../src/routes/__probe/ws/+server';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// R-OPS-16: the temporary probe through the real pipeline and the real ChatRoom
// Durable Object on the Workers pool. Removed with the probe in slice 4a.

const PATH = '/__probe/ws';
const upgrade = { upgrade: 'websocket', origin: ORIGIN };
let database: Database;
let withProbe: Harness;
let withoutProbe: Harness;

const route = (event: RequestEvent) =>
  (GET as unknown as (event: RequestEvent) => Promise<Response>)(event);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  const wsProbe = createWsProbe({ CHAT_ROOM: env.CHAT_ROOM, WS_PROBE: '1' });
  withProbe = await createHarness(database, { resolve: route, ...(wsProbe ? { wsProbe } : {}) });
  withoutProbe = await createHarness(database, { resolve: route });
});

describe('WebSocket probe (R-OPS-16)', () => {
  it('exists only when WS_PROBE is "1"', () => {
    const base = { DB: env.DB, MEDIA: env.MEDIA, CHAT_ROOM: env.CHAT_ROOM };
    expect(createCloudflareContext(base).wsProbe).toBeUndefined();
    expect(createCloudflareContext({ ...base, WS_PROBE: '0' }).wsProbe).toBeUndefined();
    expect(createCloudflareContext({ ...base, WS_PROBE: 'true' }).wsProbe).toBeUndefined();
    expect(createCloudflareContext({ ...base, WS_PROBE: '1' }).wsProbe).toBeTypeOf('function');
  });

  it('answers 404 to a signed-in member when WS_PROBE is off', async () => {
    const response = await withoutProbe.send(PATH, {
      headers: { ...upgrade, ...(await withoutProbe.as(PEOPLE.active.email)) },
      routeId: '/__probe/ws',
    });
    expect(response.status).toBe(404);
  });

  it('refuses an upgrade without an Access identity, with the uniform denial', async () => {
    const before = withProbe.resolved.length;
    const response = await withProbe.send(PATH, { headers: upgrade, routeId: '/__probe/ws' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    expect(withProbe.resolved.length).toBe(before);
  });

  it('refuses a suspended member and a cross-origin upgrade', async () => {
    const suspended = await withProbe.send(PATH, {
      headers: { ...upgrade, ...(await withProbe.as(PEOPLE.suspended.email)) },
      routeId: '/__probe/ws',
    });
    expect(suspended.status).toBe(403);
    const crossOrigin = await withProbe.send(PATH, {
      headers: {
        upgrade: 'websocket',
        origin: 'https://evil.example.test',
        ...(await withProbe.as(PEOPLE.active.email)),
      },
      routeId: '/__probe/ws',
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('answers 423 while the site is locked', async () => {
    await setSetupState(database, 'locked');
    try {
      const response = await withProbe.send(PATH, {
        headers: { ...upgrade, ...(await withProbe.as(PEOPLE.active.email)) },
        routeId: '/__probe/ws',
      });
      expect(response.status).toBe(423);
    } finally {
      await setSetupState(database, 'unlocked');
    }
  });

  it('upgrades a signed-in member to 101 and echoes a message', async () => {
    const response = await withProbe.send(PATH, {
      headers: { ...upgrade, ...(await withProbe.as(PEOPLE.active.email)) },
      routeId: '/__probe/ws',
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();
    const echoed = new Promise<string>((resolve) => {
      socket!.addEventListener('message', (event) => resolve(String(event.data)));
    });
    socket!.send('probe-ping');
    expect(await echoed).toBe('probe-ping');
    socket!.close(1000, 'done');
  });

  it('a plain GET (no upgrade) is a 404 even with the probe on', async () => {
    const response = await withProbe.send(PATH, {
      headers: { origin: ORIGIN, ...(await withProbe.as(PEOPLE.active.email)) },
      routeId: '/__probe/ws',
    });
    expect(response.status).toBe(404);
  });

  it.each([
    [1005, 1000],
    [1006, 1000],
    [1015, 1000],
    [1000, 1000],
    [4001, 4001],
  ])('answers a client close %i with a sendable code %i', async (received, sent) => {
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('ws-probe-close'));
    await runInDurableObject(stub, async (room) => {
      const codes: number[] = [];
      const socket = { close: (code: number) => void codes.push(code) } as unknown as WebSocket;
      await room.webSocketClose(socket, received);
      expect(codes).toEqual([sent]);
    });
  });

  it('a close on a socket that is already gone does not throw', async () => {
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('ws-probe-close'));
    await runInDurableObject(stub, async (room) => {
      const socket = {
        close: () => {
          throw new TypeError('WebSocket already closed');
        },
      } as unknown as WebSocket;
      await expect(room.webSocketClose(socket, 1006)).resolves.toBeUndefined();
    });
  });
});
