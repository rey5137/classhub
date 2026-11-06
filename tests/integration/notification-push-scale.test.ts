import { applyD1Migrations, env } from 'cloudflare:test';
import { eq, inArray } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCloudflarePushTransport,
  deliverPushBatch,
  type PushServiceBinding,
} from '../../src/lib/server/adapters/cloudflare/push-transport';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { createRecordingPushTransport } from '../../src/lib/server/adapters/recording/push-transport';
import {
  chatMessages,
  comments,
  notificationPrefs,
  posts,
  pushSubscriptions,
  siteSettings,
  threadFollowers,
  users,
} from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { AppContext } from '../../src/lib/server/context';
import type { PushTransport } from '../../src/lib/server/ports/push-transport';
import type { Database } from '../../src/lib/server/ports/database';
import { toBase64Url, type VapidKeys } from '../../src/lib/server/push';
import { getPrefs, readSummaryCounts } from '../../src/lib/server/repositories/notification-prefs';
import { upsertSubscription } from '../../src/lib/server/repositories/push-subscriptions';
import {
  pushAfterCommit,
  sendChatPush,
  sendItemPush,
} from '../../src/lib/server/services/push-service';
import { normalizeName } from '../../src/lib/shared/normalize';
import { seedMembership, setSetupState } from '../fixtures/membership';

const VALID_P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const VALID_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const SITE_ORIGIN = 'https://class.example.test';
const HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];

let database: Database;
let vapid: VapidKeys;
let clock = 1_762_000_000_000;
let statements: { sql: string; params: unknown[] }[] = [];

/** The D1 binding with every bound statement recorded, as the AC-MEM-09 test records its statements. */
function countingDatabase(): Database {
  const real = env.DB as unknown as {
    prepare(sql: string): { bind(...params: unknown[]): unknown };
  };
  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop, target) as unknown;
      return (sql: string) => {
        const stmt = target.prepare(sql);
        return new Proxy(stmt, {
          get(inner, key) {
            if (key !== 'bind') return Reflect.get(inner, key, inner) as unknown;
            return (...params: unknown[]) => {
              statements.push({ sql, params });
              return inner.bind(...params);
            };
          },
        });
      };
    },
  });
  return createD1Database(wrapped as unknown as Parameters<typeof createD1Database>[0]);
}

async function generateTestVapid(): Promise<VapidKeys> {
  const kp = (await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey'],
  )) as CryptoKeyPair;
  return {
    privateKey: toBase64Url(
      new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey)),
    ),
    publicKey: toBase64Url(
      new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey)),
    ),
  };
}

async function member(name: string, devices = 1, host = HOSTS[0]!) {
  const id = uuidv7(clock++);
  const email = `${id}@example.test`;
  await database.db.insert(users).values({
    id,
    authEmail: email,
    accessSub: `sub:${email}`,
    displayName: name,
    displayNameNorm: normalizeName(name),
    role: 'member',
    status: 'active',
    createdAt: clock,
    updatedAt: clock,
  });
  for (let i = 0; i < devices; i++) {
    await upsertSubscription(database, {
      userId: id,
      endpoint: `https://${host}/push/${id}-${i}`,
      p256dh: VALID_P256DH,
      auth: VALID_AUTH,
      locale: 'en',
      deviceLabel: `Device ${i}`,
      now: clock++,
    });
  }
  return id;
}

async function makeQuiet(userIds: string[]) {
  await database.db
    .update(notificationPrefs)
    .set({ unseenPushes: 10, quietSince: clock - 1000, summariesSent: 0, lastPushAt: 0 })
    .where(inArray(notificationPrefs.userId, userIds));
}

function makeCtx(push: PushTransport) {
  return { database, push, vapid, siteOrigin: SITE_ORIGIN, now: () => clock };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  vapid = await generateTestVapid();
});

beforeEach(async () => {
  clock = 1_762_000_000_000;
  statements = [];
  await database.db.delete(pushSubscriptions);
  await database.db.delete(notificationPrefs);
  await database.db.delete(threadFollowers);
  await database.db.delete(chatMessages);
  await database.db.delete(comments);
  await database.db.delete(posts);
  await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
  await setSetupState(database, 'unlocked');
});

describe('push path at class scale (R-NTF-05, R-NTF-07, R-NTF-13)', () => {
  it('AC-NTF-04 AC-NTF-05 no statement on the chat, thread or reply push path binds more than 100 parameters with 50 subscribed members', async () => {
    const actor = await member('Actor');
    const others: string[] = [];
    for (let i = 0; i < 49; i++) others.push(await member(`Member ${i}`));
    // Quiet members and long exclude lists are on the path too.
    await makeQuiet(others.slice(0, 5));
    const post = uuidv7(clock++);
    await database.db.insert(posts).values({
      id: post,
      authorId: actor,
      title: 'Thread',
      bodyMd: 'Body',
      createdAt: clock,
      updatedAt: clock,
    } as never);
    await database.db
      .insert(threadFollowers)
      .values(others.map((userId) => ({ postId: post, userId })));
    statements = [];
    const scaled = countingDatabase();

    // Chat: 54 excluded ids (the sender plus 53 connected sockets) in both NOT IN lists.
    const chat = createRecordingPushTransport(201);
    const connected = Array.from({ length: 53 }, () => uuidv7(clock++));
    await sendChatPush(
      { ...makeCtx(chat), database: scaled },
      {
        senderId: actor,
        senderName: 'Actor',
        messageText: 'hello',
        connectedMemberIds: connected,
      },
    );
    // 44 chat pushes plus the 5 quiet members' summaries.
    expect(chat.deliveries).toHaveLength(49);

    const thread = createRecordingPushTransport(201);
    clock += 1000;
    await sendItemPush({ ...makeCtx(thread), database: scaled }, 'thread', {
      postId: post,
      threadTitle: 'Thread',
      actorId: actor,
      actorName: 'Actor',
    });
    expect(thread.deliveries.length).toBeGreaterThan(0);

    const reply = createRecordingPushTransport(201);
    clock += 1000;
    await sendItemPush({ ...makeCtx(reply), database: scaled }, 'reply', {
      postId: post,
      threadTitle: 'Thread',
      actorId: actor,
      actorName: 'Actor',
      commentText: 'hi',
    });
    expect(reply.deliveries.length).toBeGreaterThan(0);

    expect(statements.length).toBeGreaterThan(10);
    // The cap that matters is 100; the 54-id NOT IN lists are the widest binds seen.
    for (const { params } of statements) expect(params.length).toBeLessThanOrEqual(100);
    expect(Math.max(...statements.map(({ params }) => params.length))).toBeGreaterThan(50);
    expect(statements.some(({ sql }) => /insert into "notification_prefs"/i.test(sql))).toBe(false);
  });

  it('R-NTF-05 one event signs one VAPID JWT per push service with one key import', async () => {
    const actor = await member('Actor');
    await member('A1', 2, HOSTS[0]);
    await member('A2', 1, HOSTS[0]);
    await member('B1', 2, HOSTS[1]);
    const transport = createRecordingPushTransport(201);
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    try {
      await sendChatPush(makeCtx(transport), {
        senderId: actor,
        senderName: 'Actor',
        messageText: 'hello',
        connectedMemberIds: [],
      });
      const pkcs8Imports = importKey.mock.calls.filter(([format]) => format === 'pkcs8');
      expect(pkcs8Imports).toHaveLength(1);
    } finally {
      importKey.mockRestore();
    }
    expect(transport.deliveries).toHaveLength(5);
    const auths = new Map<string, Set<string>>();
    for (const d of transport.deliveries) {
      const host = new URL(d.endpoint).host;
      auths.set(host, (auths.get(host) ?? new Set()).add(d.headers.Authorization!));
    }
    expect([...auths.keys()].sort()).toEqual([...HOSTS].sort());
    for (const set of auths.values()) expect(set.size).toBe(1);
    // The request carries the plaintext payload and the keys; nothing is encrypted yet.
    expect(JSON.parse(transport.deliveries[0]!.payload)).toMatchObject({ tag: 'chat' });
    expect(transport.deliveries[0]!.p256dh).toBe(VALID_P256DH);
  });

  it('AC-NTF-08 AC-NTF-14 45 quiet members with one device each, due at once, take at most 7 deliver calls and a throwing batch does not stop the others', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
    try {
      const actor = await member('Actor');
      const normal: string[] = [];
      for (let i = 0; i < 4; i++) normal.push(await member(`Normal ${i}`));
      const quiet: string[] = [];
      for (let i = 0; i < 45; i++) quiet.push(await member(`Quiet ${i}`));
      await makeQuiet(quiet);

      const calls: number[] = [];
      const binding: PushServiceBinding = {
        async deliver(batch) {
          calls.push(batch.length);
          if (calls.length === 2) throw new RangeError(`boom ${batch[0]!.endpoint}`);
          return deliverPushBatch(
            batch,
            (async () => new Response(null, { status: 410 })) as unknown as typeof fetch,
          );
        },
      };
      await sendChatPush(makeCtx(createCloudflarePushTransport(binding)), {
        senderId: actor,
        senderName: 'Actor',
        messageText: 'hi',
        connectedMemberIds: [],
      });

      // 4 chat pushes + 45 summaries = 49 deliveries in one event: batches of 40 and 9.
      expect(calls).toEqual([40, 9]);
      // The throwing batch (the 9 deliveries of the second call) stays; the first 40 got their
      // 410 recorded and were deleted.
      const left = await database.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions);
      expect(left.length).toBe(1 + 0 + 9 + 0);
      expect(lines.filter((l) => l.includes('"pushError":"deliver"'))).toEqual([
        '{"pushError":"deliver","errorClass":"RangeError"}',
      ]);
      expect(lines.join('\n')).not.toContain('boom');
      expect(lines.join('\n')).not.toContain(HOSTS[0]!);
      // Every quiet member's summary was claimed in this one event.
      const prefs = await database.db
        .select({ sent: notificationPrefs.summariesSent })
        .from(notificationPrefs)
        .where(inArray(notificationPrefs.userId, quiet));
      expect(prefs.every((p) => p.sent === 1)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('AC-NTF-14 a summary that does not fit the event ceiling is not claimed and stays due', async () => {
    const actor = await member('Actor');
    for (let i = 0; i < 8; i++) await member(`Normal ${i}`);
    const quiet: string[] = [];
    for (let i = 0; i < 5; i++) quiet.push(await member(`Quiet ${i}`));
    await makeQuiet(quiet);
    const transport = createRecordingPushTransport(201);
    await sendChatPush(
      { ...makeCtx(transport), maxDeliveriesPerEvent: 10 },
      { senderId: actor, senderName: 'Actor', messageText: 'hi', connectedMemberIds: [] },
    );
    // 8 chat pushes, then summaries until the ceiling: 2 of the 5 are claimed.
    expect(transport.deliveries).toHaveLength(10);
    const claimed: string[] = [];
    const untouched: string[] = [];
    for (const id of quiet) {
      const prefs = await getPrefs(database.db, id);
      if (prefs.summariesSent === 1) claimed.push(id);
      else {
        expect(prefs.summariesSent).toBe(0);
        expect(prefs.lastPushAt).toBe(0);
        untouched.push(id);
      }
    }
    expect(claimed).toHaveLength(2);
    expect(untouched).toHaveLength(3);
    expect(transport.deliveries.filter((d) => d.headers.Topic === 'summary')).toHaveLength(2);
  });

  it('R-NTF-13 the summary reply count covers only comments on threads the member follows', async () => {
    const author = await member('Author');
    const reader = await member('Reader');
    const mk = async (title: string) => {
      const id = uuidv7(clock++);
      await database.db.insert(posts).values({
        id,
        authorId: author,
        title,
        bodyMd: 'b',
        createdAt: clock,
        updatedAt: clock,
      } as never);
      return id;
    };
    const followed = await mk('Followed');
    const other = await mk('Other');
    await database.db.insert(threadFollowers).values({ postId: followed, userId: reader });
    const since = clock;
    for (const [postId, n] of [
      [followed, 2],
      [other, 5],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await database.db.insert(comments).values({
          id: uuidv7(clock++),
          postId,
          authorId: author,
          bodyMd: 'c',
          createdAt: clock,
          updatedAt: clock,
        } as never);
      }
    }
    const counts = await readSummaryCounts(
      database.db,
      reader,
      { chat: false, thread: false, reply: true } as never,
      since,
      { chat: true, discussions: true },
    );
    expect(counts.reply).toBe(2);
  });

  it('R-AUTH-28 the join push is never awaited inline: without waitUntil it is dropped, with one it runs', async () => {
    const task = vi.fn(async () => {});
    const base = {
      database,
      push: createRecordingPushTransport(201),
      vapid,
    } as unknown as AppContext;
    await pushAfterCommit(base, 'join', task);
    expect(task).not.toHaveBeenCalled();

    const pending: Promise<unknown>[] = [];
    await pushAfterCommit(
      { ...base, waitUntil: (work) => void pending.push(work) } as AppContext,
      'join',
      task,
    );
    await Promise.all(pending);
    expect(task).toHaveBeenCalledTimes(1);

    // Thread and reply pushes keep the awaited fallback for local dev and tests.
    await pushAfterCommit(base, 'thread', task);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
