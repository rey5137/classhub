import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatRoom } from '../../src/lib/server/adapters/cloudflare/chat-room';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { createDurableObjectHub } from '../../src/lib/server/adapters/cloudflare/realtime-hub';
import { MEMBERS, Probe, sendFrame, type ClientSocket } from '../contract/realtime';
import { seedMembership } from '../fixtures/membership';

// AC-CHAT-11 / R-CHAT-08: a storage spy on the real DurableObjectState, so it runs on
// the Workers pool; tests/unit/chat-room-source.test.ts is its static half.

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await seedMembership(
    createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]),
  );
});

describe('ChatRoom storage (R-CHAT-08)', () => {
  it('AC-CHAT-11 connect, send, presence, disconnect and delete never touch DO storage', async () => {
    const name = crypto.randomUUID();
    const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(name));
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    await runInDurableObject(stub, (_room: ChatRoom, state) => {
      const storage = state.storage as unknown as Record<string, unknown>;
      for (const method of [
        'put',
        'delete',
        'deleteAll',
        'get',
        'list',
        'transaction',
        'transactionSync',
        'setAlarm',
        'deleteAlarm',
      ]) {
        if (typeof storage[method] === 'function') {
          spies.push(vi.spyOn(storage as Record<string, () => unknown>, method));
        }
      }
      spies.push(vi.spyOn(state.storage.sql, 'exec'));
      if (state.storage.kv) {
        spies.push(vi.spyOn(state.storage.kv, 'put'), vi.spyOn(state.storage.kv, 'delete'));
      }
    });
    expect(spies.length).toBeGreaterThanOrEqual(8);

    const hub = createDurableObjectHub(
      env.CHAT_ROOM as unknown as Parameters<typeof createDurableObjectHub>[0],
      env.INTERNAL_CONTEXT_KEY,
      { roomName: name },
    );
    const open = async (member: (typeof MEMBERS)[keyof typeof MEMBERS]) => {
      const response = await hub.connect(
        new Request('https://classhub.example.test/api/v1/chat/ws', {
          headers: { upgrade: 'websocket' },
        }),
        member,
      );
      response.webSocket!.accept();
      const probe = new Probe(response.webSocket as unknown as ClientSocket);
      await probe.next('hello');
      return probe;
    };
    const first = await open(MEMBERS.active);
    const second = await open(MEMBERS.admin);
    first.send(sendFrame('nothing in DO storage'));
    const { message } = await first.next('ack');
    await second.next('message');
    await hub.notify({ type: 'message.deleted', id: message.id });
    await second.next('deleted');
    second.close();
    await first.next('online');
    await hub.disconnectMember(MEMBERS.active.id);
    await first.closed;

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
