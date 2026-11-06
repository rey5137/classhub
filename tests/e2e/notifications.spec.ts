import { expect, test, type Page } from '@playwright/test';

// AC-NTF-12: /notifications at 390 px with stubbed pushManager and Notification.

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const VALID_P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const VALID_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

interface StubPushOptions {
  initialPermission?: NotificationPermission;
  requestPermissionResult?: NotificationPermission;
  existingEndpoint?: string | null;
  subscribeEndpoint?: string;
}

async function stubPushEnvironment(page: Page, options: StubPushOptions = {}) {
  const {
    initialPermission = 'default',
    requestPermissionResult = 'granted',
    existingEndpoint = null,
    subscribeEndpoint = 'https://fcm.googleapis.com/fcm/send/e2e-sub-token-1',
  } = options;

  await page.addInitScript(
    ({ initPerm, reqPerm, existingEp, subEp, p256dh, auth }) => {
      const state = {
        permission: initPerm as NotificationPermission,
        requestPermissionCalls: 0,
        subscribeCalls: 0,
        unsubscribeCalls: 0,
        currentEndpoint: existingEp as string | null,
      };
      (window as unknown as { __pushStub: typeof state }).__pushStub = state;

      function makeSub(endpoint: string) {
        return {
          endpoint,
          expirationTime: null,
          options: { userVisibleOnly: true, applicationServerKey: null },
          getKey: () => null,
          toJSON: () => ({
            endpoint,
            expirationTime: null,
            keys: { p256dh, auth },
          }),
          unsubscribe: async () => {
            state.unsubscribeCalls++;
            state.currentEndpoint = null;
            return true;
          },
        };
      }

      const fakePushManager = {
        getSubscription: async () =>
          state.currentEndpoint ? makeSub(state.currentEndpoint) : null,
        subscribe: async () => {
          state.subscribeCalls++;
          state.currentEndpoint = subEp;
          return makeSub(subEp);
        },
        permissionState: async () => state.permission,
      };

      const FakeNotification = {
        get permission() {
          return state.permission;
        },
        requestPermission: async () => {
          state.requestPermissionCalls++;
          state.permission = reqPerm as NotificationPermission;
          return state.permission;
        },
      };

      Object.defineProperty(window, 'Notification', {
        value: FakeNotification,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'PushManager', {
        value: function PushManager() {},
        configurable: true,
        writable: true,
      });

      if ('serviceWorker' in navigator) {
        Object.defineProperty(navigator.serviceWorker, 'getRegistration', {
          value: async () => ({ pushManager: fakePushManager }),
          configurable: true,
        });
      }
    },
    {
      initPerm: initialPermission,
      reqPerm: requestPermissionResult,
      existingEp: existingEndpoint,
      subEp: subscribeEndpoint,
      p256dh: VALID_P256DH,
      auth: VALID_AUTH,
    },
  );
}

async function clearAllNotificationState(page: Page) {
  const origin = new URL(page.url()).origin;
  const res = await page.request.get('/api/v1/notifications');
  if (!res.ok()) return;
  const body = (await res.json()) as {
    devices: Array<{ id: string }>;
  };
  for (const d of body.devices) {
    await page.request.delete(`/api/v1/notifications/subscriptions/${d.id}`, {
      headers: { origin },
    });
  }
  await page.request.patch('/api/v1/notifications', {
    headers: { origin },
    data: {
      kinds: { chat: true, thread: true, reply: true, join: true },
      mute: null,
    },
  });
}

test.describe('/notifications at 390 px (AC-NTF-12)', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: ANDROID_UA,
    hasTouch: true,
    isMobile: true,
  });

  test('AC-NTF-12 permission is requested only on tapping Turn on, kind toggles and mute persist across reloads, Unmute clears mute, and Remove drops a device', async ({
    page,
  }) => {
    await stubPushEnvironment(page, {
      initialPermission: 'default',
      requestPermissionResult: 'granted',
      subscribeEndpoint: 'https://fcm.googleapis.com/fcm/send/e2e-turn-on-1',
    });

    await page.goto('/profile');
    await clearAllNotificationState(page);

    // /profile links to /notifications.
    const profileLink = page.locator('main a[href="/notifications"]').first();
    await expect(profileLink).toBeVisible();
    await profileLink.click();
    await expect(page).toHaveURL(/\/notifications$/);

    // Never prompts on page load.
    const callsOnLoad = await page.evaluate(
      () =>
        (window as unknown as { __pushStub: { requestPermissionCalls: number } }).__pushStub
          .requestPermissionCalls,
    );
    expect(callsOnLoad).toBe(0);
    await expect(page.locator('.device-state')).toHaveAttribute('data-state', 'off');

    // Tap "Turn on for this device" -> prompts once, subscribes, and lists the device.
    await page.getByRole('button', { name: 'Bật cho thiết bị này' }).click();
    await expect(page.locator('.device-state')).toHaveAttribute('data-state', 'on');
    const callsAfterTap = await page.evaluate(
      () =>
        (window as unknown as { __pushStub: { requestPermissionCalls: number } }).__pushStub
          .requestPermissionCalls,
    );
    expect(callsAfterTap).toBe(1);
    await expect(page.locator('.device-item')).toHaveCount(1);
    await expect(page.locator('.device-item')).toContainText('Chrome on Android');

    // Toggle chat kind off and mute for 1 hour; verify both persist across reload.
    const chatCheckbox = page.locator('input[name="chat"]');
    await expect(chatCheckbox).toBeChecked();
    await chatCheckbox.uncheck();
    await expect(page.getByRole('status')).toContainText('Đã lưu cài đặt thông báo.');

    await page.getByRole('button', { name: '1 giờ' }).click();
    await expect(page.locator('.mute-active')).toBeVisible();

    await page.reload();
    await expect(page.locator('input[name="chat"]')).not.toBeChecked();
    await expect(page.locator('.mute-active')).toBeVisible();

    // Unmute clears mute_until immediately and persists across reload.
    await page.getByRole('button', { name: 'Bật lại ngay' }).click();
    await expect(page.locator('.mute-active')).toHaveCount(0);
    await expect(page.locator('.mute-choices')).toBeVisible();

    await page.reload();
    await expect(page.locator('.mute-active')).toHaveCount(0);

    // Re-enable chat kind.
    await page.locator('input[name="chat"]').check();
    await expect(page.locator('input[name="chat"]')).toBeChecked();

    // Remove drops the device from the list.
    await page.locator('.device-item').getByRole('button', { name: 'Xoá' }).click();
    await expect(page.locator('.device-item')).toHaveCount(0);
  });

  test('AC-NTF-12 when permission is granted and getSubscription() returns an unlisted subscription on load, it is posted once', async ({
    page,
  }) => {
    await page.goto('/profile');
    await clearAllNotificationState(page);

    let postCount = 0;
    await page.route('/api/v1/notifications/subscriptions', async (route) => {
      if (route.request().method() === 'POST') postCount++;
      await route.continue();
    });

    await stubPushEnvironment(page, {
      initialPermission: 'granted',
      existingEndpoint: 'https://fcm.googleapis.com/fcm/send/e2e-healed-sub-1',
    });

    await page.goto('/notifications');
    await expect(page.locator('.device-state')).toHaveAttribute('data-state', 'on');
    await expect(page.locator('.device-item')).toHaveCount(1);
    await expect(page.locator('.device-item')).toContainText('Chrome on Android');
    expect(postCount).toBe(1);

    // Never called requestPermission on load.
    const callsOnLoad = await page.evaluate(
      () =>
        (window as unknown as { __pushStub: { requestPermissionCalls: number } }).__pushStub
          .requestPermissionCalls,
    );
    expect(callsOnLoad).toBe(0);

    // Reloading when the device is now listed does not post again.
    await page.reload();
    await expect(page.locator('.device-item')).toHaveCount(1);
    expect(postCount).toBe(1);

    await clearAllNotificationState(page);
  });

  test('AC-NTF-12 iPhone UA outside standalone shows the /install link instead of the Turn-on button', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: IPHONE_UA,
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await stubPushEnvironment(page, { initialPermission: 'default' });

    await page.goto('/notifications');
    const installLink = page.locator('.install-link');
    await expect(installLink).toBeVisible();
    await expect(installLink).toHaveAttribute('href', '/install');
    await expect(page.getByRole('button', { name: 'Bật cho thiết bị này' })).toHaveCount(0);

    await context.close();
  });
});
