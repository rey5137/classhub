import { applyD1Migrations, env } from 'cloudflare:test';
import type { RequestEvent } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { chatHistorySchema, type ChatHistory } from '../../src/lib/contracts/chat';
import { errorBodySchema } from '../../src/lib/contracts/errors';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { auditEvents, chatMessages, siteSettings } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import type { RealtimeHub } from '../../src/lib/server/ports/realtime';
import * as messageByIdRoute from '../../src/routes/api/v1/chat/messages/[id]/+server';
import * as messagesRoute from '../../src/routes/api/v1/chat/messages/+server';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness, ORIGIN, type Harness } from '../fixtures/pipeline-harness';

// §11.2 / R-CHAT-03, 10, 11: chat history through the real pipeline on D1.

type Handler = (event: RequestEvent) => Response | Promise<Response>;

async function resolveChatRoute(event: RequestEvent): Promise<Response> {
  const byId = /^\/api\/v1\/chat\/messages\/(?<id>[^/]+)$/.exec(event.url.pathname);
  const module = (byId ? messageByIdRoute : messagesRoute) as unknown as Record<string, Handler>;
  if (byId) Object.assign(event.params, byId.groups);
  const handler = module[event.request.method];
  return handler ? handler(event) : new Response(null, { status: 405 });
}

let database: Database;
let harness: Harness;
let member: Record<string, string>;
let admin: Record<string, string>;
const notified: string[] = [];
const hub: RealtimeHub = {
  async connect() {
    return new Response(null, { status: 501 });
  },
  async disconnectMember() {},
  async notify(event) {
    notified.push(event.id);
  },
};

/** 120 messages, alternating senders; every pair shares a millisecond. */
const BASE = 1_700_000_000_000;
const seeded: string[] = [];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  harness = await createHarness(database, { resolve: resolveChatRoute, realtime: hub });
  member = await harness.as(PEOPLE.active.email);
  admin = await harness.as(PEOPLE.admin.email);
  const rows = Array.from({ length: 120 }, (_, index) => {
    const createdAt = BASE + Math.floor(index / 2) * 1_000;
    return {
      id: uuidv7(createdAt),
      roomId: 'main',
      senderId: index % 2 === 0 ? PEOPLE.active.id : PEOPLE.admin.id,
      clientNonce: crypto.randomUUID(),
      body: `message ${index}`,
      createdAt,
    };
  });
  for (let start = 0; start < rows.length; start += 10) {
    await database.db.insert(chatMessages).values(rows.slice(start, start + 10));
  }
  seeded.push(...rows.map((row) => row.id));
});

async function history(query = '', headers = member): Promise<ChatHistory> {
  const response = await harness.send(`/api/v1/chat/messages${query}`, { headers });
  expect(response.status).toBe(200);
  return chatHistorySchema.parse(await response.json());
}

async function remove(id: string, headers = member) {
  return harness.send(`/api/v1/chat/messages/${id}`, {
    method: 'DELETE',
    headers: { ...headers, origin: ORIGIN },
  });
}

async function errorCode(response: Response) {
  return [response.status, errorBodySchema.parse(await response.json()).error.code];
}

describe('chat history (R-CHAT-10, 11)', () => {
  it('R-CHAT-10 returns the newest 50, oldest first, and pages back with before=', async () => {
    const newest = await history();
    expect(newest.items.map((item) => item.id)).toEqual(seeded.slice(70));
    expect(newest.nextCursor).toBe(seeded[70]);
    const older = await history(`?before=${newest.nextCursor}`);
    expect(older.items.map((item) => item.id)).toEqual(seeded.slice(20, 70));
    const oldest = await history(`?before=${older.nextCursor}`);
    expect(oldest.items.map((item) => item.id)).toEqual(seeded.slice(0, 20));
    expect(oldest.nextCursor).toBeNull();
  });

  it('R-CHAT-11 catches up with after=, oldest first, gap-free across pages', async () => {
    const first = await history(`?after=${seeded[9]}`);
    expect(first.items.map((item) => item.id)).toEqual(seeded.slice(10, 60));
    expect(first.nextCursor).toBe(seeded[59]);
    const second = await history(`?after=${first.nextCursor}`);
    expect(second.items.map((item) => item.id)).toEqual(seeded.slice(60, 110));
    const last = await history(`?after=${second.nextCursor}`);
    expect(last.items.map((item) => item.id)).toEqual(seeded.slice(110));
    expect(last.nextCursor).toBeNull();
    // A message sharing its cursor's millisecond is still returned (keyset on created_at, id).
    expect((await history(`?after=${seeded[10]}`)).items[0]!.id).toBe(seeded[11]);
  });

  it('R-PROF-04 shows each sender as a projection: id, name and nothing of their contacts', async () => {
    const { items } = await history();
    for (const item of items) {
      expect(
        Object.keys(item.sender).every((key) =>
          ['id', 'displayName', 'avatarMediaId'].includes(key),
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(items)).not.toContain('@example.test');
    expect(items.at(-1)).toMatchObject({
      sender: { id: PEOPLE.admin.id, displayName: 'Class Admin' },
      deleted: false,
      body: 'message 119',
    });
  });

  it('R-API-02 refuses a bad cursor, both cursors, an unknown id and an extra parameter', async () => {
    for (const query of [
      '?before=not-a-uuid',
      `?before=${seeded[5]}&after=${seeded[6]}`,
      `?after=${crypto.randomUUID()}`,
      '?limit=500',
    ]) {
      const response = await harness.send(`/api/v1/chat/messages${query}`, { headers: member });
      expect([query, ...(await errorCode(response))]).toEqual([query, 400, 'validation']);
    }
  });
});

describe('chat tombstones (R-CHAT-03)', () => {
  it('R-CHAT-03 a sender deletes their own message: a tombstone with no body, announced live', async () => {
    const id = seeded[118]!;
    const response = await remove(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(notified.splice(0)).toEqual([id]);
    const [row] = await database.db.select().from(chatMessages).where(eq(chatMessages.id, id));
    expect(row).toMatchObject({ body: '' });
    expect(row!.deletedAt).toBeTypeOf('number');
    const tombstone = (await history()).items.find((item) => item.id === id);
    expect(tombstone).toEqual({
      id,
      createdAt: row!.createdAt,
      sender: { id: PEOPLE.active.id, displayName: 'Active Member' },
      deleted: true,
    });
    // Deleting it again is the same refusal as an unknown id.
    expect(await errorCode(await remove(id))).toEqual([403, 'forbidden']);
    // A member's own delete is not moderation, so it is not audited.
    const audits = await database.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audits).toEqual([]);
  });

  it('R-CHAT-03 a member cannot delete another’s message; unknown and malformed ids answer the same', async () => {
    const others = seeded[117]!;
    for (const id of [others, crypto.randomUUID(), 'not-a-uuid']) {
      expect([id, ...(await errorCode(await remove(id)))]).toEqual([id, 403, 'forbidden']);
    }
    const [row] = await database.db.select().from(chatMessages).where(eq(chatMessages.id, others));
    expect(row).toMatchObject({ body: 'message 117', deletedAt: null });
    expect(notified).toEqual([]);
  });

  it('R-CHAT-03 an admin deletes anyone’s message, audited without its content', async () => {
    const id = seeded[116]!;
    expect((await remove(id, admin)).status).toBe(200);
    expect(notified.splice(0)).toEqual([id]);
    const audits = await database.db.select().from(auditEvents).where(eq(auditEvents.entityId, id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: PEOPLE.admin.id,
      action: 'chat.delete',
      entityType: 'chat_message',
    });
    expect(JSON.stringify(audits)).not.toContain('message 116');
  });

  it('R-CHAT-03 a hub that cannot be reached does not undo the tombstone', async () => {
    const failing = await createHarness(database, {
      resolve: resolveChatRoute,
      realtime: {
        ...hub,
        async notify() {
          throw new Error('room unreachable');
        },
      },
    });
    const response = await failing.send(`/api/v1/chat/messages/${seeded[114]}`, {
      method: 'DELETE',
      headers: { ...(await failing.as(PEOPLE.active.email)), origin: ORIGIN },
    });
    expect(response.status).toBe(200);
    const [row] = await database.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, seeded[114]!));
    expect(row!.deletedAt).toBeTypeOf('number');
  });
});

describe('chat feature flag (R-NAV-02)', () => {
  it('R-NAV-02 with chat off the history and delete routes answer feature_disabled; data stays', async () => {
    await database.db.insert(siteSettings).values({
      key: 'features',
      valueJson: JSON.stringify({ memories: true, discussions: true, chat: false }),
    });
    try {
      const list = await harness.send('/api/v1/chat/messages', { headers: member });
      expect(await errorCode(list)).toEqual([404, 'feature_disabled']);
      expect(await errorCode(await remove(seeded[112]!))).toEqual([404, 'feature_disabled']);
    } finally {
      await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
    }
    const [row] = await database.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, seeded[112]!));
    expect(row).toMatchObject({ body: 'message 112', deletedAt: null });
    expect((await history()).items.length).toBe(50);
  });
});
