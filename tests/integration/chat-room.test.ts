import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { CLOSE_FORBIDDEN, CLOSE_REAUTH } from '../../src/lib/contracts/chat';
import type { ChatRoom } from '../../src/lib/server/adapters/cloudflare/chat-room';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { createDurableObjectHub } from '../../src/lib/server/adapters/cloudflare/realtime-hub';
import { chatMessages, siteSettings, users } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import type { RealtimeHub, RealtimeMember } from '../../src/lib/server/ports/realtime';
import { ChatRoomCore, type RoomSocket } from '../../src/lib/server/services/chat-room';
import { suspendMember } from '../../src/lib/server/services/members';
import { normalizeName } from '../../src/lib/shared/normalize';
import { MEMBERS, Probe, sendFrame, type ClientSocket } from '../contract/realtime';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';

// §9.2 on the Workers pool: the real ChatRoom Durable Object and D1, each test in a
// room of its own. A failing database or a fake clock is put into the live instance
// (`rig`), so the sockets, attachments and hibernation handlers stay the real ones.

let database: Database;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
});

interface Room {
  hub: RealtimeHub;
  name: string;
  open(member: RealtimeMember): Promise<Probe>;
}

function room(): Room {
  const name = crypto.randomUUID();
  const hub = createDurableObjectHub(
    env.CHAT_ROOM as unknown as Parameters<typeof createDurableObjectHub>[0],
    env.INTERNAL_CONTEXT_KEY,
    { roomName: name },
  );
  return {
    hub,
    name,
    async open(member) {
      const response = await hub.connect(
        new Request('https://classhub.example.test/api/v1/chat/ws', {
          headers: { upgrade: 'websocket' },
        }),
        member,
      );
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      const probe = new Probe(response.webSocket as unknown as ClientSocket);
      await probe.next('hello');
      return probe;
    },
  };
}

/** Replaces the live room's database and clock; sockets stay the Durable Object's own. */
async function rig(target: Room, deps: { database?: Database; now?: () => number }) {
  const stub = env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName(target.name));
  await runInDurableObject(stub, (instance: ChatRoom) => {
    const live = instance as unknown as {
      room: ChatRoomCore;
      ctx: DurableObjectState;
      wrap(socket: WebSocket): RoomSocket;
    };
    live.room = new ChatRoomCore({
      database: deps.database ?? database,
      sockets: () => live.ctx.getWebSockets().map((socket) => live.wrap(socket)),
      ...(deps.now ? { now: deps.now } : {}),
    });
  });
}

/** A fresh active member, so suspending one leaves PEOPLE untouched. */
async function newMember(name = 'Chat Classmate'): Promise<RealtimeMember> {
  const id = uuidv7();
  const now = Date.now();
  await database.db.insert(users).values({
    id,
    authEmail: `${id}@example.test`,
    displayName: name,
    displayNameNorm: normalizeName(name),
    role: 'member',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return { id, role: 'member', displayName: name, authUntil: now + 3_600_000 };
}

async function rowsFor(clientNonce: string) {
  return database.db.select().from(chatMessages).where(eq(chatMessages.clientNonce, clientNonce));
}

const actor = { id: PEOPLE.admin.id, role: 'admin' as const, displayName: 'Class Admin' };

describe('ChatRoom (§9.2)', () => {
  it('AC-CHAT-02 a nonce resent after a reconnect yields one row and the original id', async () => {
    const chat = room();
    const frame = sendFrame('sent once');
    const first = await chat.open(MEMBERS.active);
    first.send(frame);
    const original = await first.next('ack');
    first.close();
    expect(await first.closed).toBe(1000);

    const again = await chat.open(MEMBERS.active);
    again.send(frame);
    again.send(frame);
    expect((await again.next('ack')).message.id).toBe(original.message.id);
    expect((await again.next('ack')).message.id).toBe(original.message.id);
    expect(await rowsFor(frame.clientNonce)).toHaveLength(1);
    again.close();
  });

  it('AC-CHAT-03 with D1 failing the sender gets not_saved and nobody a broadcast', async () => {
    const chat = room();
    const sender = await chat.open(MEMBERS.active);
    const other = await chat.open(MEMBERS.admin);
    await sender.next('online');
    await rig(chat, {
      database: {
        db: database.db,
        batch: async () => {
          throw new Error('D1_ERROR: storage unavailable');
        },
      },
    });
    const frame = sendFrame('lost in transit');
    sender.send(frame);
    expect(await sender.next('error')).toEqual({
      type: 'error',
      code: 'not_saved',
      clientNonce: frame.clientNonce,
    });
    expect(await sender.pending()).toEqual([]);
    expect(await other.pending()).toEqual([]);
    expect(await rowsFor(frame.clientNonce)).toEqual([]);
    sender.close();
    other.close();
  });

  it('AC-CHAT-05 suspending a member closes their socket with 4003', async () => {
    const chat = room();
    const member = await newMember();
    const target = await chat.open(member);
    const result = await suspendMember({ database, realtime: chat.hub }, actor, member.id);
    expect(result).toMatchObject({ ok: true });
    expect(await target.closed).toBe(CLOSE_FORBIDDEN);
  });

  it('AC-CHAT-05 a send racing the suspension is refused and stored nowhere', async () => {
    const chat = room();
    const member = await newMember();
    const racer = await chat.open(member);
    const other = await chat.open(MEMBERS.admin);
    await racer.next('online');
    // Suspended in D1 after the socket opened; no disconnect reached the room.
    await database.db.update(users).set({ status: 'suspended' }).where(eq(users.id, member.id));
    const frame = sendFrame('one last word');
    racer.send(frame);
    expect(await racer.closed).toBe(CLOSE_FORBIDDEN);
    expect(racer.frames.filter((item) => item.type !== 'online')).toEqual([]);
    expect(await rowsFor(frame.clientNonce)).toEqual([]);
    expect((await other.pending()).filter((type) => type !== 'online')).toEqual([]);
    other.close();
  });

  it('AC-CHAT-05 with disconnectMember throwing, no further broadcast reaches the member', async () => {
    const chat = room();
    const member = await newMember();
    const suspended = await chat.open(member);
    const sender = await chat.open(MEMBERS.active);
    await suspended.next('online');
    const failing: RealtimeHub = {
      ...chat.hub,
      async disconnectMember() {
        throw new Error('room unreachable');
      },
    };
    expect(await suspendMember({ database, realtime: failing }, actor, member.id)).toMatchObject({
      ok: true,
    });
    sender.send(sendFrame('after the suspension'));
    const { message } = await sender.next('ack');
    expect((await sender.next('message')).message).toEqual(message);
    expect(await suspended.closed).toBe(CLOSE_FORBIDDEN);
    expect(suspended.frames.some((frame) => frame.type === 'message')).toBe(false);
    sender.close();
  });

  it('AC-CHAT-06 the sixth message inside one second is rate-limited', async () => {
    const chat = room();
    const sender = await chat.open(MEMBERS.active);
    const at = Date.now();
    await rig(chat, { now: () => at });
    const frames = Array.from({ length: 6 }, (_, index) => sendFrame(`burst ${index}`));
    for (const frame of frames) sender.send(frame);
    for (let index = 0; index < 5; index += 1) {
      expect((await sender.next('ack')).clientNonce).toBe(frames[index]!.clientNonce);
    }
    expect(await sender.next('error')).toEqual({
      type: 'error',
      code: 'rate_limited',
      clientNonce: frames[5]!.clientNonce,
    });
    expect(await rowsFor(frames[5]!.clientNonce)).toEqual([]);
    // One second later one more token has come back.
    await rig(chat, { now: () => at + 1_000 });
    sender.send(sendFrame('after a pause'));
    expect((await sender.next('ack')).message).toMatchObject({ body: 'after a pause' });
    sender.close();
  });

  it('AC-CHAT-12 after setup_state leaves unlocked the next message closes every socket with 4003', async () => {
    const chat = room();
    const sender = await chat.open(MEMBERS.active);
    const other = await chat.open(MEMBERS.admin);
    await setSetupState(database, 'locked');
    try {
      const frame = sendFrame('while locking');
      sender.send(frame);
      expect(await sender.closed).toBe(CLOSE_FORBIDDEN);
      expect(await other.closed).toBe(CLOSE_FORBIDDEN);
      expect(other.frames.some((item) => item.type === 'message')).toBe(false);
      expect(sender.frames.some((item) => item.type === 'message')).toBe(false);
      // The sender was still authorized, so the message is stored (R-CHAT-16).
      expect(await rowsFor(frame.clientNonce)).toHaveLength(1);
    } finally {
      await setSetupState(database, 'unlocked');
    }
  });

  it('AC-CHAT-13 with chat turned off the next message closes every socket; messages stay stored', async () => {
    const chat = room();
    const sender = await chat.open(MEMBERS.active);
    const other = await chat.open(MEMBERS.admin);
    await database.db.insert(siteSettings).values({
      key: 'features',
      valueJson: JSON.stringify({ memories: true, discussions: true, chat: false }),
    });
    try {
      const frame = sendFrame('as chat goes off');
      sender.send(frame);
      expect(await sender.closed).toBe(CLOSE_FORBIDDEN);
      expect(await other.closed).toBe(CLOSE_FORBIDDEN);
      expect(other.frames.some((item) => item.type === 'message')).toBe(false);
      expect(await rowsFor(frame.clientNonce)).toHaveLength(1);
    } finally {
      await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
    }
  });

  it('AC-CHAT-14 a socket past its authUntil is closed with 4001 on its next message', async () => {
    const chat = room();
    const at = Date.now();
    const sender = await chat.open({ ...MEMBERS.active, authUntil: at + 60_000 });
    let clock = at;
    await rig(chat, { now: () => clock });
    sender.send(sendFrame('in time'));
    expect((await sender.next('ack')).message).toMatchObject({ body: 'in time' });
    clock = at + 60_000;
    const late = sendFrame('too late');
    sender.send(late);
    expect(await sender.closed).toBe(CLOSE_REAUTH);
    expect(await rowsFor(late.clientNonce)).toEqual([]);
  });

  it('AC-CHAT-14 a reader past authUntil gets no broadcast and is closed with 4001 when another sends', async () => {
    const chat = room();
    const at = Date.now();
    const reader = await chat.open({ ...MEMBERS.admin, authUntil: at + 60_000 });
    const sender = await chat.open(MEMBERS.active);
    await reader.next('online');
    await rig(chat, { now: () => at + 60_000 });
    sender.send(sendFrame('for current sessions only'));
    const { message } = await sender.next('ack');
    expect((await sender.next('message')).message).toEqual(message);
    expect(await reader.closed).toBe(CLOSE_REAUTH);
    expect(reader.frames).toEqual([]);
    sender.close();
  });

  it('AC-CHAT-14 a socket past authUntil gets no deletion or presence frame, and is closed with 4001', async () => {
    const chat = room();
    const at = Date.now();
    const reader = await chat.open({ ...MEMBERS.admin, authUntil: at + 60_000 });
    const other = await chat.open(MEMBERS.active);
    await reader.next('online');
    await rig(chat, { now: () => at + 60_000 });
    const id = crypto.randomUUID();
    await chat.hub.notify({ type: 'message.deleted', id });
    expect(await other.next('deleted')).toEqual({ type: 'deleted', id });
    expect(await reader.closed).toBe(CLOSE_REAUTH);
    expect(reader.frames).toEqual([]);
    other.close();
  });

  it('AC-CHAT-14 with the authorization read failing the message is saved and acked, not broadcast', async () => {
    const chat = room();
    const sender = await chat.open(MEMBERS.active);
    const other = await chat.open(MEMBERS.admin);
    await sender.next('online');
    await rig(chat, {
      database: {
        db: database.db,
        // The batch commits but its authorization reads come back unusable.
        batch: async (queries) => (await database.batch(queries)).slice(0, 2),
      },
    });
    const frame = sendFrame('saved, not delivered');
    sender.send(frame);
    expect((await sender.next('ack')).message).toMatchObject({ body: 'saved, not delivered' });
    expect(await sender.pending()).toEqual([]);
    expect(await other.pending()).toEqual([]);
    expect(await rowsFor(frame.clientNonce)).toHaveLength(1);
    sender.close();
    other.close();
  });

  it('R-CHAT-05 refuses a bad frame, an oversized frame and a binary frame without storing', async () => {
    const chat = room();
    const sender = await chat.open(MEMBERS.active);
    const nonce = crypto.randomUUID();
    sender.send({ type: 'send', clientNonce: nonce, body: '   ' });
    expect(await sender.next('error')).toEqual({
      type: 'error',
      code: 'validation',
      clientNonce: nonce,
    });
    sender.send({ type: 'send', clientNonce: nonce, body: 'x'.repeat(1_001) });
    expect((await sender.next('error')).code).toBe('validation');
    sender.send({ type: 'send', clientNonce: nonce, body: 'x', senderId: PEOPLE.admin.id });
    expect((await sender.next('error')).code).toBe('validation');
    sender.send('not json');
    expect((await sender.next('error')).code).toBe('validation');
    sender.send(JSON.stringify({ type: 'send', clientNonce: nonce, body: 'x'.repeat(4_100) }));
    expect((await sender.next('error')).code).toBe('payload_too_large');
    (sender.socket as unknown as WebSocket).send(new Uint8Array([1, 2, 3]));
    expect((await sender.next('error')).code).toBe('validation');
    expect(await rowsFor(nonce)).toEqual([]);
    // 1,000 code points of emoji is within the limit though over 1,000 UTF-16 units.
    sender.send(sendFrame('😀'.repeat(1_000)));
    expect((await sender.next('ack')).message.deleted).toBe(false);
    sender.close();
  });
});
