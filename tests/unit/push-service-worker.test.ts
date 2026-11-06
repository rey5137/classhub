import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_NOTIFICATION_BODY,
  FALLBACK_NOTIFICATION_TITLE,
  handleNotificationClick,
  resolveNotificationClickPath,
  handlePush,
  handlePushSubscriptionChange,
  PUSH_ICON_URL,
  type SwClients,
  type SwPushRegistration,
  type SwShownNotification,
} from '../../src/lib/install/sw-core';

function createMockRegistration() {
  const shown: (SwShownNotification & { icon: string; renotify: boolean })[] = [];
  const registration: SwPushRegistration = {
    async getNotifications(filter) {
      if (!filter?.tag) return [...shown];
      return shown.filter((n) => n.tag === filter.tag);
    },
    async showNotification(title, options) {
      const idx = shown.findIndex((n) => n.tag === options.tag);
      const entry = {
        title,
        body: options.body,
        tag: options.tag,
        icon: options.icon,
        renotify: options.renotify,
        data: options.data,
        close: () => {
          const i = shown.findIndex((n) => n.tag === options.tag);
          if (i >= 0) shown.splice(i, 1);
        },
      };
      if (idx >= 0) shown[idx] = entry;
      else shown.push(entry);
    },
  };
  return { registration, shown };
}

describe('service worker push handlers (R-NTF-12)', () => {
  it('AC-NTF-11 shows one notification from a valid payload and the bilingual fallback for garbage', async () => {
    const { registration, shown } = createMockRegistration();

    await handlePush(
      JSON.stringify({
        kind: 'thread',
        title: 'Lê Minh · Thảo luận mới',
        body: 'Họp lớp cuối năm',
        url: '/discussions/01950000-0000-7000-8000-000000000001',
        tag: 'thread-01950000-0000-7000-8000-000000000001',
      }),
      registration,
    );

    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'Lê Minh · Thảo luận mới',
      body: 'Họp lớp cuối năm',
      tag: 'thread-01950000-0000-7000-8000-000000000001',
      icon: PUSH_ICON_URL,
      renotify: true,
    });

    // Garbage / unparseable payload still calls showNotification with bilingual fallback.
    const { registration: reg2, shown: shown2 } = createMockRegistration();
    await handlePush('not-valid-json{{{', reg2);
    expect(shown2).toHaveLength(1);
    expect(shown2[0]).toMatchObject({
      title: FALLBACK_NOTIFICATION_TITLE,
      body: FALLBACK_NOTIFICATION_BODY,
      tag: 'fallback',
      icon: PUSH_ICON_URL,
      renotify: true,
    });
  });

  it('AC-NTF-11 merges three chat pushes into one "3 new messages" notification with the last three lines, and keeps only the last three on a fourth', async () => {
    const { registration, shown } = createMockRegistration();

    await handlePush(
      JSON.stringify({
        kind: 'chat',
        title: 'An',
        body: 'First message',
        url: '/chat',
        tag: 'chat',
      }),
      registration,
    );
    await handlePush(
      JSON.stringify({
        kind: 'chat',
        title: 'Bình',
        body: 'Second message',
        url: '/chat',
        tag: 'chat',
      }),
      registration,
    );
    await handlePush(
      JSON.stringify({
        kind: 'chat',
        title: 'Chi',
        body: 'Third message',
        url: '/chat',
        tag: 'chat',
      }),
      registration,
    );

    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('Class chat · 3 new messages');
    expect(shown[0]?.body).toBe('An: First message\nBình: Second message\nChi: Third message');

    // A 4th chat push increments count to 4 and keeps only the last 3 lines.
    await handlePush(
      JSON.stringify({
        kind: 'chat',
        title: 'Dũng',
        body: 'Fourth message',
        url: '/chat',
        tag: 'chat',
      }),
      registration,
    );
    expect(shown[0]?.title).toBe('Class chat · 4 new messages');
    expect(shown[0]?.body).toBe('Bình: Second message\nChi: Third message\nDũng: Fourth message');
  });

  it('AC-NTF-11 opens same-origin paths on notificationclick and redirects cross-origin URLs to `/`', async () => {
    const origin = 'https://classhub.example.test';
    const opened: string[] = [];
    const navigated: string[] = [];
    const close = vi.fn();

    const emptyClients: SwClients = {
      matchAll: async () => [],
      openWindow: async (url) => {
        opened.push(url);
      },
    };

    // Cross-origin URL must open `/` instead.
    await handleNotificationClick(
      { data: { url: 'https://evil.example.com/phish' }, close },
      emptyClients,
      origin,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(['/']);

    // Protocol-relative URL must also open `/`.
    await handleNotificationClick(
      { data: { url: '//evil.example.com/phish' }, close },
      emptyClients,
      origin,
    );
    expect(opened).toEqual(['/', '/']);

    // Same-origin URL focuses an existing window and navigates it.
    const focus = vi.fn(async () => {});
    const withWindowClients: SwClients = {
      matchAll: async () => [
        {
          url: `${origin}/memories`,
          focus,
          navigate: async (url) => {
            navigated.push(url);
          },
        },
      ],
      openWindow: async (url) => {
        opened.push(url);
      },
    };

    await handleNotificationClick(
      { data: { url: '/discussions/123#c1' }, close },
      withWindowClients,
      origin,
    );
    expect(navigated).toEqual(['/discussions/123#c1']);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('AC-NTF-11 pushsubscriptionchange re-subscribes and posts best-effort without throwing on failure', async () => {
    const { registration } = createMockRegistration();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(
      handlePushSubscriptionChange(
        {
          newSubscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/new-sub',
            toJSON: () => ({
              endpoint: 'https://fcm.googleapis.com/fcm/send/new-sub',
              keys: { p256dh: 'p256dh-val', auth: 'auth-val' },
            }),
          } as unknown as PushSubscription,
        },
        registration,
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AC-NTF-11 titles the merged chat notification from the payload template in either locale, and falls back for an older payload', async () => {
    const chat = (extra: Record<string, unknown>, body: string) =>
      JSON.stringify({ kind: 'chat', title: 'An', body, url: '/chat', tag: 'chat', ...extra });
    for (const [merge, expected] of [
      ['Chat lớp · {n} tin nhắn mới', 'Chat lớp · 2 tin nhắn mới'],
      ['Class chat · {n} new messages', 'Class chat · 2 new messages'],
      [undefined, 'Class chat · 2 new messages'],
      ['no placeholder', 'Class chat · 2 new messages'],
    ] as const) {
      const { registration, shown } = createMockRegistration();
      await handlePush(chat({ merge }, 'one'), registration);
      await handlePush(chat({ merge }, 'two'), registration);
      expect(shown).toHaveLength(1);
      expect(shown[0]?.title).toBe(expected);
    }
  });

  it('AC-NTF-11 sends a path that still starts with // or /\\ after URL parsing to `/`', () => {
    const origin = 'https://class.example.test';
    expect(resolveNotificationClickPath(`${origin}//evil.example/x`, origin)).toBe('/');
    expect(resolveNotificationClickPath(`${origin}/\\evil.example/x`, origin)).toBe('/');
    expect(resolveNotificationClickPath('/chat?x=1#top', origin)).toBe('/chat?x=1#top');
  });
});
