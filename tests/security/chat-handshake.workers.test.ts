import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { CONTEXT_HEADER, signContext } from '../../src/lib/server/internal-context';
import { seedMembership, PEOPLE } from '../fixtures/membership';

// AC-CHAT-04 / R-CHAT-04: a request that reaches the ChatRoom Durable Object directly,
// without a valid, unexpired context signed under INTERNAL_CONTEXT_KEY, gets no socket.

const member = {
  memberId: PEOPLE.active.id,
  role: 'admin' as const,
  displayName: 'Active Member',
  authUntil: Date.now() + 3_600_000,
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seedMembership(
    createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]),
  );
});

async function direct(headers: Record<string, string>): Promise<Response> {
  const room = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('main'));
  return (await room.fetch('https://chat-room.internal/connect', { headers })) as Response;
}

function refused(response: Response) {
  return { status: response.status, socket: response.webSocket ?? null };
}

describe('ChatRoom handshake (R-CHAT-04)', () => {
  it('AC-CHAT-04 refuses an upgrade with no signed context', async () => {
    expect(refused(await direct({ upgrade: 'websocket' }))).toEqual({ status: 403, socket: null });
  });

  it('AC-CHAT-04 refuses a context signed under another key or tampered with', async () => {
    const foreign = await signContext(member, 'not-the-worker-secret');
    expect(refused(await direct({ upgrade: 'websocket', [CONTEXT_HEADER]: foreign }))).toEqual({
      status: 403,
      socket: null,
    });
    const valid = await signContext(member, env.INTERNAL_CONTEXT_KEY);
    const [body, signature] = valid.split('.') as [string, string];
    const swapped = `${body}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(refused(await direct({ upgrade: 'websocket', [CONTEXT_HEADER]: swapped }))).toEqual({
      status: 403,
      socket: null,
    });
    for (const garbage of ['', 'x', 'a.b', `${body}.`, JSON.stringify(member)]) {
      expect(refused(await direct({ upgrade: 'websocket', [CONTEXT_HEADER]: garbage }))).toEqual({
        status: 403,
        socket: null,
      });
    }
  });

  it('AC-CHAT-04 refuses an expired context', async () => {
    const expired = await signContext(member, env.INTERNAL_CONTEXT_KEY, Date.now() - 31_000);
    expect(refused(await direct({ upgrade: 'websocket', [CONTEXT_HEADER]: expired }))).toEqual({
      status: 403,
      socket: null,
    });
  });

  it('AC-CHAT-04 answers a valid context with a socket, and nothing to a non-upgrade', async () => {
    const valid = await signContext(member, env.INTERNAL_CONTEXT_KEY);
    expect(refused(await direct({ [CONTEXT_HEADER]: valid }))).toEqual({
      status: 426,
      socket: null,
    });
    const response = await direct({ upgrade: 'websocket', [CONTEXT_HEADER]: valid });
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    response.webSocket!.close(1000, 'done');
  });
});
