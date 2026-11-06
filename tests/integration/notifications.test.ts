import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeMuteUntil } from '../../src/lib/contracts/notifications';
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
import type { Database } from '../../src/lib/server/ports/database';
import { toBase64Url, verifyVapidAuthorization, type VapidKeys } from '../../src/lib/server/push';
import {
  getPrefs,
  setMute,
  updateKinds,
} from '../../src/lib/server/repositories/notification-prefs';
import {
  listSubscriptions,
  upsertSubscription,
} from '../../src/lib/server/repositories/push-subscriptions';
import {
  attachmentOf,
  ChatRoomCore,
  type RoomSocket,
} from '../../src/lib/server/services/chat-room';
import { completeDeletion } from '../../src/lib/server/services/members';
import {
  getNotifications,
  patchNotifications,
  subscribeDevice,
  unsubscribeDevice,
} from '../../src/lib/server/services/notifications';
import { exportOwnData, requestDeletion } from '../../src/lib/server/services/profiles';
import { sendChatPush, sendJoinPush } from '../../src/lib/server/services/push-service';
import { normalizeName } from '../../src/lib/shared/normalize';
import { PEOPLE, seedMembership, setSetupState } from '../fixtures/membership';
import { createHarness, ORIGIN, recordingHub } from '../fixtures/pipeline-harness';
import { POST as postSubRoute } from '../../src/routes/api/v1/notifications/subscriptions/+server';
import {
  GET as getNotifRoute,
  PATCH as patchNotifRoute,
} from '../../src/routes/api/v1/notifications/+server';

const VALID_P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const VALID_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

let database: Database;
let vapid: VapidKeys;
const SITE_ORIGIN = 'https://class.example.test';
let clock = 1_762_000_000_000;

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

async function createActiveUser(name: string, role: 'member' | 'admin' = 'member') {
  const id = uuidv7(clock++);
  const email = `${id}@example.test`;
  await database.db.insert(users).values({
    id,
    authEmail: email,
    accessSub: `sub:${email}`,
    displayName: name,
    displayNameNorm: normalizeName(name),
    role,
    status: 'active',
    createdAt: clock,
    updatedAt: clock,
  });
  return { id, email, role, displayName: name };
}

async function resetNotificationTables() {
  await database.db.delete(pushSubscriptions);
  await database.db.delete(notificationPrefs);
  await database.db.delete(threadFollowers);
  await database.db.delete(chatMessages);
  await database.db.delete(comments);
  await database.db.delete(posts);
  await database.db.delete(siteSettings).where(eq(siteSettings.key, 'features'));
  await setSetupState(database, 'unlocked');
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  vapid = await generateTestVapid();
});

beforeEach(async () => {
  clock = 1_762_000_000_000;
  await resetNotificationTables();
});

describe('notifications integration (§16)', () => {
  it('AC-NTF-02 refuses invalid endpoints and keys at the API, and never leaks an endpoint or key in logs, API responses or exports', async () => {
    const logLines: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void logLines.push(args.join(' '))),
    );

    try {
      const transport = createRecordingPushTransport(400);
      const harness = await createHarness(database, {
        now: () => clock,
        push: transport,
        vapid,
        resolve: async (event) => {
          const p = event.url.pathname;
          if (p === '/api/v1/notifications' && event.request.method === 'GET') {
            return getNotifRoute(event as never);
          }
          if (p === '/api/v1/notifications' && event.request.method === 'PATCH') {
            return patchNotifRoute(event as never);
          }
          if (p === '/api/v1/notifications/subscriptions' && event.request.method === 'POST') {
            return postSubRoute(event as never);
          }
          return new Response('ok');
        },
      });
      const headers = {
        ...(await harness.as(PEOPLE.active.email)),
        'content-type': 'application/json',
        origin: ORIGIN,
      };

      for (const badBody of [
        {
          endpoint: 'http://fcm.googleapis.com/fcm/send/secret-token-1',
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
        },
        {
          endpoint: 'https://fcm.googleapis.com.evil.test/fcm/send/secret-token-2',
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
        },
        {
          endpoint: 'https://fcm.googleapis.com:8443/fcm/send/secret-token-3',
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
        },
        {
          endpoint: 'https://fcm.googleapis.com/fcm/send/secret-token-4',
          p256dh: 'malformed-key',
          auth: VALID_AUTH,
        },
      ]) {
        const res = await harness.send('/api/v1/notifications/subscriptions', {
          method: 'POST',
          headers,
          body: JSON.stringify(badBody),
          routeId: '/api/v1/notifications/subscriptions',
        });
        expect(res.status).toBe(400);
      }

      // Valid subscription is accepted, then a 400 push failure logs status only.
      const secretEndpoint = 'https://fcm.googleapis.com/fcm/send/super-secret-endpoint-token-999';
      const okRes = await harness.send('/api/v1/notifications/subscriptions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          endpoint: secretEndpoint,
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
          deviceLabel: 'Chrome on Android',
        }),
        routeId: '/api/v1/notifications/subscriptions',
      });
      expect(okRes.status).toBe(201);
      const okText = await okRes.text();

      const getRes = await harness.send('/api/v1/notifications', {
        method: 'GET',
        headers,
        routeId: '/api/v1/notifications',
      });
      expect(getRes.status).toBe(200);
      const getText = await getRes.text();

      await sendChatPush(
        { database, push: transport, vapid, now: () => clock },
        {
          senderId: PEOPLE.admin.id,
          senderName: 'Admin',
          messageText: 'Hello',
          connectedMemberIds: [],
          now: clock,
        },
      );

      const exported = await exportOwnData(
        { database, realtime: recordingHub() },
        { id: PEOPLE.active.id, role: 'member', displayName: 'Active Member' },
        clock,
      );
      expect(exported.ok).toBe(true);
      const exportText = JSON.stringify(exported.ok ? exported.body : {});
      expect(exported.ok && exported.body.devices).toEqual([
        expect.objectContaining({ deviceLabel: 'Chrome on Android' }),
      ]);

      const combinedOutput = [okText, getText, exportText, ...logLines].join('\n');
      expect(combinedOutput).not.toContain(secretEndpoint);
      expect(combinedOutput).not.toContain('super-secret-endpoint-token-999');
      expect(combinedOutput).not.toContain(VALID_P256DH);
      expect(combinedOutput).not.toContain(VALID_AUTH);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('AC-NTF-04 chat pushes exclude sender, connected sockets, muted, chat-off, suspended and coalesced members, never double-push on concurrent sends, and push again after 60 s', async () => {
    const sender = await createActiveUser('Sender');
    const connected = await createActiveUser('Connected');
    const mutedUser = await createActiveUser('Muted');
    const chatOffUser = await createActiveUser('ChatOff');
    const suspendedUser = await createActiveUser('Suspended');
    const recipient = await createActiveUser('Recipient');

    await database.db
      .update(users)
      .set({ status: 'suspended' })
      .where(eq(users.id, suspendedUser.id));

    for (const u of [sender, connected, mutedUser, chatOffUser, suspendedUser, recipient]) {
      await upsertSubscription(database, {
        userId: u.id,
        endpoint: `https://fcm.googleapis.com/fcm/send/token-${u.id}`,
        p256dh: VALID_P256DH,
        auth: VALID_AUTH,
        locale: 'vi',
        deviceLabel: `Device ${u.displayName}`,
        now: clock,
      });
    }

    await setMute(database.db, mutedUser.id, '1h', 'Asia/Ho_Chi_Minh', clock);
    await updateKinds(database.db, chatOffUser.id, { chat: false }, clock);

    const transport = createRecordingPushTransport(201);
    const openSockets: RoomSocket[] = [];
    const room = new ChatRoomCore({
      database,
      sockets: () => openSockets,
      push: transport,
      vapid,
      now: () => clock,
    });

    const makeSocket = (u: {
      id: string;
      role: 'member' | 'admin';
      displayName: string;
    }): RoomSocket => ({
      attachment: attachmentOf(
        {
          memberId: u.id,
          role: u.role,
          displayName: u.displayName,
          authUntil: clock + 3_600_000,
          exp: Math.floor(clock / 1000) + 60,
        },
        clock,
        SITE_ORIGIN,
      ),
      send: () => {},
      close: () => {},
    });

    const senderSocket = makeSocket(sender);
    const connectedSocket = makeSocket(connected);
    openSockets.push(senderSocket, connectedSocket);

    // Concurrent messages: recipient must be pushed at most once inside the 60-s window.
    await Promise.all([
      room.message(
        senderSocket,
        JSON.stringify({ type: 'send', clientNonce: uuidv7(clock + 10), body: 'Hello 1' }),
      ),
      room.message(
        senderSocket,
        JSON.stringify({ type: 'send', clientNonce: uuidv7(clock + 11), body: 'Hello 2' }),
      ),
    ]);

    const recipientSub = (await listSubscriptions(database.db, recipient.id))[0]!;
    expect(transport.deliveries.map((d) => d.subscriptionId)).toEqual([recipientSub.id]);
    // R-NTF-01: the VAPID `sub` is the origin the sender's socket connected through.
    const signed = await verifyVapidAuthorization(
      transport.deliveries[0]!.headers.Authorization!,
      vapid.publicKey,
      clock,
    );
    expect(signed.claims?.sub).toBe(SITE_ORIGIN);

    // Inside the 60-s coalesce window (e.g. +30 s): nothing is sent.
    transport.clear();
    clock += 30_000;
    await room.message(
      senderSocket,
      JSON.stringify({ type: 'send', clientNonce: uuidv7(clock + 12), body: 'Inside window' }),
    );
    expect(transport.deliveries).toHaveLength(0);

    // After the 60-s window (+31 s more = +61 s total): pushes again.
    clock += 31_000;
    await room.message(
      senderSocket,
      JSON.stringify({ type: 'send', clientNonce: uuidv7(clock + 13), body: 'After window' }),
    );
    expect(transport.deliveries.map((d) => d.subscriptionId)).toEqual([recipientSub.id]);
  });

  it('AC-NTF-06 computes morning mute across midnight and time zones, stops pushes while muted, resumes after mute_until without a write, and unmutes at once', async () => {
    // 1. Morning across midnight in Asia/Ho_Chi_Minh (+07:00) and America/New_York (-05:00).
    // 2026-11-06T23:30:00+07:00 (before midnight) -> 2026-11-07T07:00:00+07:00 = 2026-11-07T00:00:00Z
    const beforeMidnightHcm = Date.parse('2026-11-06T23:30:00+07:00');
    const afterMidnightHcm = Date.parse('2026-11-07T01:15:00+07:00');
    const expectedMorningHcm = Date.parse('2026-11-07T07:00:00+07:00');
    expect(computeMuteUntil('morning', beforeMidnightHcm, 'Asia/Ho_Chi_Minh')).toBe(
      expectedMorningHcm,
    );
    expect(computeMuteUntil('morning', afterMidnightHcm, 'Asia/Ho_Chi_Minh')).toBe(
      expectedMorningHcm,
    );

    // America/New_York (EST, -05:00 in Nov): 2026-11-06T22:00:00-05:00 -> 2026-11-07T07:00:00-05:00
    const beforeMidnightNy = Date.parse('2026-11-06T22:00:00-05:00');
    const afterMidnightNy = Date.parse('2026-11-07T03:00:00-05:00');
    const expectedMorningNy = Date.parse('2026-11-07T07:00:00-05:00');
    expect(computeMuteUntil('morning', beforeMidnightNy, 'America/New_York')).toBe(
      expectedMorningNy,
    );
    expect(computeMuteUntil('morning', afterMidnightNy, 'America/New_York')).toBe(
      expectedMorningNy,
    );

    expect(computeMuteUntil('1h', clock, 'Asia/Ho_Chi_Minh')).toBe(clock + 3_600_000);
    expect(computeMuteUntil('8h', clock, 'Asia/Ho_Chi_Minh')).toBe(clock + 8 * 3_600_000);
    expect(computeMuteUntil('1w', clock, 'Asia/Ho_Chi_Minh')).toBe(clock + 7 * 86_400_000);

    // 2. Pushes stop while muted and resume after mute_until passes with no write; Unmute resumes at once.
    const member = await createActiveUser('Mute Tester');
    await upsertSubscription(database, {
      userId: member.id,
      endpoint: 'https://fcm.googleapis.com/fcm/send/mute-test-sub',
      p256dh: VALID_P256DH,
      auth: VALID_AUTH,
      locale: 'vi',
      deviceLabel: 'Phone',
      now: clock,
    });

    await setMute(database.db, member.id, '1h', 'Asia/Ho_Chi_Minh', clock);
    const transport = createRecordingPushTransport(201);

    clock += 1_800_000; // +30 min (still muted)
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Muted msg',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(0);

    // Advance past 1h mute; GET /api/v1/notifications reports muteUntil = null without writing to DB.
    clock += 1_800_001;
    const viewAfterExpiry = await getNotifications({ database, vapid }, member, {
      featureEnabled: true,
      now: clock,
    });
    expect(viewAfterExpiry.ok && viewAfterExpiry.body.muteUntil).toBeNull();

    // Next push arrives automatically once mute_until has passed.
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Resumed msg',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(1);

    // Mute again for 8h, then Unmute at once -> push resumes immediately.
    transport.clear();
    clock += 120_000;
    await patchNotifications(
      { database, vapid },
      member,
      { mute: '8h' },
      { featureEnabled: true, timeZone: 'Asia/Ho_Chi_Minh', now: clock },
    );
    await patchNotifications(
      { database, vapid },
      member,
      { mute: null },
      { featureEnabled: true, timeZone: 'Asia/Ho_Chi_Minh', now: clock },
    );
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Unmuted msg',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(1);
  });

  it('AC-NTF-07 404/410 delete immediately, 5 consecutive failures delete, a success in between resets the count, and a failing push never fails the chat ack', async () => {
    const member = await createActiveUser('Failure Tester');
    const sub404 = await upsertSubscription(database, {
      userId: member.id,
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-404',
      p256dh: VALID_P256DH,
      auth: VALID_AUTH,
      locale: 'vi',
      deviceLabel: 'Sub 404',
      now: clock,
    });
    const sub410 = await upsertSubscription(database, {
      userId: member.id,
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-410',
      p256dh: VALID_P256DH,
      auth: VALID_AUTH,
      locale: 'vi',
      deviceLabel: 'Sub 410',
      now: clock + 1,
    });
    const subFlaky = await upsertSubscription(database, {
      userId: member.id,
      endpoint: 'https://fcm.googleapis.com/fcm/send/sub-flaky',
      p256dh: VALID_P256DH,
      auth: VALID_AUTH,
      locale: 'vi',
      deviceLabel: 'Sub Flaky',
      now: clock + 2,
    });
    expect(sub404.ok && sub410.ok && subFlaky.ok).toBe(true);

    const transport = createRecordingPushTransport((d) => {
      if (d.endpoint.endsWith('sub-404')) return 404;
      if (d.endpoint.endsWith('sub-410')) return 410;
      return 503;
    });

    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Msg 1',
        connectedMemberIds: [],
        now: clock,
      },
    );

    // 404 and 410 were deleted immediately; subFlaky remains with failure_count = 1.
    let remaining = await listSubscriptions(database.db, member.id);
    expect(remaining.map((r) => r.deviceLabel)).toEqual(['Sub Flaky']);

    // 3 more failures -> failure_count = 4 (still present).
    for (const status of [429, 'network_error' as const, 500]) {
      clock += 61_000;
      transport.setNextStatus(status);
      await sendChatPush(
        { database, push: transport, vapid, now: () => clock },
        {
          senderId: PEOPLE.admin.id,
          senderName: 'Admin',
          messageText: `Fail ${status}`,
          connectedMemberIds: [],
          now: clock,
        },
      );
    }
    remaining = await listSubscriptions(database.db, member.id);
    expect(remaining).toHaveLength(1);

    // A 201 success resets failure_count to 0!
    clock += 61_000;
    transport.setNextStatus(201);
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Recovery msg',
        connectedMemberIds: [],
        now: clock,
      },
    );
    const [flakyRow] = await database.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, member.id));
    expect(flakyRow?.failureCount).toBe(0);

    // Reset unseen_pushes so we can test 5 consecutive failures without entering quiet mode.
    await database.db
      .update(notificationPrefs)
      .set({ unseenPushes: 0 })
      .where(eq(notificationPrefs.userId, member.id));

    // Now 5 consecutive failures delete subFlaky on the 5th failure.
    for (let i = 1; i <= 5; i++) {
      clock += 61_000;
      transport.setNextStatus(i % 2 === 0 ? 'network_error' : 502);
      await sendChatPush(
        { database, push: transport, vapid, now: () => clock },
        {
          senderId: PEOPLE.admin.id,
          senderName: 'Admin',
          messageText: `Consecutive fail ${i}`,
          connectedMemberIds: [],
          now: clock,
        },
      );
      const list = await listSubscriptions(database.db, member.id);
      expect(list).toHaveLength(i < 5 ? 1 : 0);
    }

    // A throwing PushTransport never fails the chat ack.
    const frames: string[] = [];
    const senderSocket: RoomSocket = {
      attachment: attachmentOf(
        {
          memberId: PEOPLE.admin.id,
          role: 'admin',
          displayName: 'Admin',
          authUntil: clock + 3_600_000,
          exp: Math.floor(clock / 1000) + 60,
        },
        clock,
      ),
      send: (txt) => frames.push(txt),
      close: () => {},
    };
    const throwingRoom = new ChatRoomCore({
      database,
      sockets: () => [senderSocket],
      push: {
        async send() {
          throw new Error('push transport exploded');
        },
      },
      vapid,
      now: () => clock,
    });
    const ackNonce = uuidv7(clock + 99);
    await throwingRoom.message(
      senderSocket,
      JSON.stringify({ type: 'send', clientNonce: ackNonce, body: 'Must still ack' }),
    );
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(frames[0]!)).toMatchObject({ type: 'ack', clientNonce: ackNonce });
  });

  it('AC-NTF-09 caps subscriptions at 5 (replacing oldest), moves endpoint across members, forbids deleting another member’s sub, and deletes all push rows on member deletion', async () => {
    const alice = await createActiveUser('Alice');
    const bob = await createActiveUser('Bob');

    for (let i = 1; i <= 6; i++) {
      clock += 1000;
      await subscribeDevice(
        { database },
        alice,
        {
          endpoint: `https://fcm.googleapis.com/fcm/send/alice-sub-${i}`,
          p256dh: VALID_P256DH,
          auth: VALID_AUTH,
          locale: 'vi',
          deviceLabel: `Device ${i}`,
        },
        { featureEnabled: true, now: clock },
      );
    }

    const aliceDevices = await listSubscriptions(database.db, alice.id);
    expect(aliceDevices).toHaveLength(5);
    expect(aliceDevices.map((d) => d.deviceLabel)).toEqual([
      'Device 6',
      'Device 5',
      'Device 4',
      'Device 3',
      'Device 2',
    ]);

    // Bob posts Alice's endpoint `alice-sub-2`: it moves to Bob.
    clock += 1000;
    await subscribeDevice(
      { database },
      bob,
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/alice-sub-2',
        p256dh: VALID_P256DH,
        auth: VALID_AUTH,
        locale: 'en',
        deviceLabel: 'Bob Shared Tablet',
      },
      { featureEnabled: true, now: clock },
    );
    expect(
      (await listSubscriptions(database.db, alice.id)).map((d) => d.deviceLabel),
    ).not.toContain('Device 2');
    const bobDevices = await listSubscriptions(database.db, bob.id);
    expect(bobDevices.map((d) => d.deviceLabel)).toEqual(['Bob Shared Tablet']);

    // Alice cannot delete Bob's subscription (`not_found`).
    const forbiddenDel = await unsubscribeDevice({ database }, alice, bobDevices[0]!.id, {
      featureEnabled: true,
    });
    expect(forbiddenDel).toEqual({ ok: false, code: 'not_found' });

    // Completing Alice's deletion removes her subscriptions, prefs, and thread_followers rows.
    const postId = uuidv7(clock++);
    await database.db.insert(posts).values({
      id: postId,
      authorId: bob.id,
      title: 'Thread',
      bodyMd: 'Body',
      createdAt: clock,
    });
    await database.db.insert(threadFollowers).values({ postId, userId: alice.id });

    await requestDeletion(
      { database, realtime: recordingHub() },
      alice,
      { keepContent: true },
      clock,
    );
    const completed = await completeDeletion(
      { database, realtime: recordingHub() },
      { id: PEOPLE.admin.id, role: 'admin', displayName: 'Admin' },
      alice.id,
      clock + 1,
    );
    expect(completed.ok).toBe(true);
    expect(await listSubscriptions(database.db, alice.id)).toHaveLength(0);
    expect(
      await database.db
        .select()
        .from(notificationPrefs)
        .where(eq(notificationPrefs.userId, alice.id)),
    ).toHaveLength(0);
    expect(
      await database.db.select().from(threadFollowers).where(eq(threadFollowers.userId, alice.id)),
    ).toHaveLength(0);
  });

  it('AC-NTF-10 sends nothing when notifications is off, VAPID keys are missing, site is locked or chat feature is off; API answers feature_disabled and subscriptions are kept', async () => {
    const member = await createActiveUser('Toggle Tester');
    await subscribeDevice(
      { database },
      member,
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/toggle-sub',
        p256dh: VALID_P256DH,
        auth: VALID_AUTH,
        locale: 'vi',
        deviceLabel: 'Toggle Phone',
      },
      { featureEnabled: true, now: clock },
    );

    const transport = createRecordingPushTransport(201);

    // 1. Without VAPID keys: nothing sent.
    await sendChatPush(
      { database, push: transport, vapid: undefined, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'No vapid',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(0);

    // 2. Site locked: nothing sent.
    await setSetupState(database, 'locked');
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Site locked',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(0);
    await setSetupState(database, 'unlocked');

    // 3. Chat feature off: nothing sent.
    await database.db.insert(siteSettings).values({
      key: 'features',
      valueJson: JSON.stringify({
        memories: true,
        discussions: true,
        chat: false,
        join: false,
        notifications: true,
      }),
      updatedAt: clock,
    });
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Chat off',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(0);

    // 4. Notifications feature off: nothing sent, API answers feature_disabled (404), subscriptions are kept.
    await database.db
      .update(siteSettings)
      .set({
        valueJson: JSON.stringify({
          memories: true,
          discussions: true,
          chat: true,
          join: false,
          notifications: false,
        }),
      })
      .where(eq(siteSettings.key, 'features'));

    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.admin.id,
        senderName: 'Admin',
        messageText: 'Notifications off',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(0);

    const harness = await createHarness(database, {
      now: () => clock,
      push: transport,
      vapid,
      resolve: async (event) => getNotifRoute(event as never),
    });
    const res = await harness.send('/api/v1/notifications', {
      method: 'GET',
      headers: await harness.as(member.email),
      routeId: '/api/v1/notifications',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'feature_disabled' } });

    // Subscriptions are still kept in D1!
    expect(await listSubscriptions(database.db, member.id)).toHaveLength(1);
  });

  it('AC-NTF-14 enters quiet mode after 10 unseen pushes, sends one summary with capped counts for enabled kinds on the next event, doubles intervals (6h -> 12h -> 24h), still delivers join pushes, resets on one page load, and writes nothing on an active member’s page loads', async () => {
    const adminQuiet = await createActiveUser('Quiet Admin', 'admin');
    await subscribeDevice(
      { database },
      adminQuiet,
      {
        endpoint: 'https://fcm.googleapis.com/fcm/send/quiet-admin-sub',
        p256dh: VALID_P256DH,
        auth: VALID_AUTH,
        locale: 'en',
        deviceLabel: 'Quiet Admin Phone',
      },
      { featureEnabled: true, now: clock },
    );

    // Enable `chat` and `thread`, disable `reply` so summary counts only `chat` and `thread`.
    await updateKinds(
      database.db,
      adminQuiet.id,
      { chat: true, thread: true, reply: false },
      clock,
    );
    await database.db.insert(siteSettings).values({
      key: 'features',
      valueJson: JSON.stringify({
        memories: true,
        discussions: true,
        chat: true,
        join: true,
        notifications: true,
      }),
      updatedAt: clock,
    });

    const transport = createRecordingPushTransport(201);

    // 10 unseen chat pushes (each > 60 s apart).
    for (let i = 1; i <= 10; i++) {
      clock += 61_000;
      await sendChatPush(
        { database, push: transport, vapid, now: () => clock },
        {
          senderId: PEOPLE.active.id,
          senderName: 'Classmate',
          messageText: `Item push ${i}`,
          connectedMemberIds: [],
          now: clock,
        },
      );
    }
    expect(transport.deliveries).toHaveLength(10);
    const prefsAfter10 = await getPrefs(database.db, adminQuiet.id);
    expect(prefsAfter10.unseenPushes).toBe(10);
    expect(prefsAfter10.quietSince).toBe(clock);

    // Seed 105 chat messages, 2 threads, and 4 replies since quietSince.
    const postId = uuidv7(clock);
    for (let i = 0; i < 105; i++) {
      await database.db.insert(chatMessages).values({
        id: uuidv7(clock + i),
        roomId: 'main',
        senderId: PEOPLE.active.id,
        clientNonce: `quiet-msg-${i}`,
        body: `Message ${i}`,
        createdAt: clock + i,
      });
    }
    for (let i = 0; i < 2; i++) {
      await database.db.insert(posts).values({
        id: i === 0 ? postId : uuidv7(clock + 200 + i),
        authorId: PEOPLE.active.id,
        title: `Thread ${i}`,
        bodyMd: 'Body',
        createdAt: clock + i,
      });
    }
    for (let i = 0; i < 4; i++) {
      await database.db.insert(comments).values({
        id: uuidv7(clock + 300 + i),
        postId,
        authorId: PEOPLE.active.id,
        bodyMd: `Reply ${i}`,
        createdAt: clock + i,
      });
    }

    // Next event after 10 unseen pushes sends ONE summary (Urgency: low, Topic: summary), no item push.
    transport.clear();
    clock += 61_000;
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.active.id,
        senderName: 'Classmate',
        messageText: 'Event 11 triggers first summary',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0]?.headers.Topic).toBe('summary');
    expect(transport.deliveries[0]?.headers.Urgency).toBe('low');

    // Join push STILL arrives while quiet!
    transport.clear();
    await sendJoinPush(
      { database, push: transport, vapid, now: () => clock },
      { requestedName: 'New Applicant', now: clock },
    );
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0]?.headers.Topic).toBe('join');

    // Next summary comes no sooner than 6 h, then 12 h, then 24 h.
    const HOUR = 3_600_000;
    for (const requiredHours of [6, 12, 24]) {
      transport.clear();
      clock += requiredHours * HOUR - 1_000; // 1 second before interval
      await sendChatPush(
        { database, push: transport, vapid, now: () => clock },
        {
          senderId: PEOPLE.active.id,
          senderName: 'Classmate',
          messageText: 'Too early for summary',
          connectedMemberIds: [],
          now: clock,
        },
      );
      expect(transport.deliveries).toHaveLength(0);

      clock += 2_000; // past interval
      await sendChatPush(
        { database, push: transport, vapid, now: () => clock },
        {
          senderId: PEOPLE.active.id,
          senderName: 'Classmate',
          messageText: 'Summary now due',
          connectedMemberIds: [],
          now: clock,
        },
      );
      expect(transport.deliveries).toHaveLength(1);
      expect(transport.deliveries[0]?.headers.Topic).toBe('summary');
    }

    // One page load resets unseen_pushes, quiet_since and summaries_sent, and item pushes resume.
    const harness = await createHarness(database, {
      now: () => clock,
      push: transport,
      vapid,
    });
    const headers = await harness.as(adminQuiet.email, `sub:${adminQuiet.email}`);
    expect((await harness.send('/', { headers })).status).toBe(200);

    const resetPrefs = await getPrefs(database.db, adminQuiet.id);
    expect(resetPrefs.unseenPushes).toBe(0);
    expect(resetPrefs.quietSince).toBeNull();
    expect(resetPrefs.summariesSent).toBe(0);

    // An active member's subsequent page loads write nothing to notification_prefs.
    const beforeUpdatedAt = (await getPrefs(database.db, adminQuiet.id)).updatedAt;
    clock += 1_000;
    expect((await harness.send('/', { headers })).status).toBe(200);
    const afterUpdatedAt = (await getPrefs(database.db, adminQuiet.id)).updatedAt;
    expect(afterUpdatedAt).toBe(beforeUpdatedAt);

    // Item pushes now resume!
    transport.clear();
    clock += 61_000;
    await sendChatPush(
      { database, push: transport, vapid, now: () => clock },
      {
        senderId: PEOPLE.active.id,
        senderName: 'Classmate',
        messageText: 'Back to normal chat pushes',
        connectedMemberIds: [],
        now: clock,
      },
    );
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0]?.headers.Topic).toBe('chat');
  });
});
