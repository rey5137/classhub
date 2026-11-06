import { expect, test, type Page } from '@playwright/test';

// R-NAV-07..11 on dev:offline. SvelteKit registers src/service-worker.ts in dev as well, so
// this target exercises the real worker; the CSP, headers and Access Bypass need the live site
// (AC-NAV-10, manual).

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DAY = 86_400_000;
const KEY = 'classhub:install-card-dismissed';

test.describe('desktop', () => {
  test('AC-NAV-06 every page head links the manifest, the touch icon and the theme colour', async ({
    page,
  }) => {
    for (const path of ['/', '/profile', '/install', '/locked', '/denied']) {
      await page.goto(path);
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
        'href',
        '/manifest.webmanifest',
      );
      expect(await page.locator('link[rel="manifest"]').getAttribute('crossorigin')).toBeNull();
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
        'href',
        '/icons/apple-touch-icon.png',
      );
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
        'content',
        /^#[0-9a-f]{6}$/i,
      );
      await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
        'content',
        /\S/,
      );
      await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute(
        'content',
        'yes',
      );
    }
    const manifest = await page.request.get('/manifest.webmanifest');
    expect(manifest.headers()['content-type']).toBe('application/manifest+json');
    for (const icon of (await manifest.json()).icons) {
      expect((await page.request.get(icon.src)).status()).toBe(200);
    }
  });

  test('AC-NAV-07 after one visit an offline navigation shows the offline page; Cache Storage holds only it and the icons', async ({
    page,
    context,
  }) => {
    await page.goto('/profile');
    await page.evaluate(() => navigator.serviceWorker.ready);
    // The first load is not controlled; the second is.
    await page.goto('/profile');
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);

    const cached = await page.evaluate(async () => {
      const out: Record<string, string[]> = {};
      for (const name of await caches.keys()) {
        out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
      }
      return out;
    });
    const names = Object.keys(cached);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^classhub-/);
    expect(cached[names[0]!]!.sort()).toEqual(
      [
        '/offline.html',
        '/offline.css',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/icon-maskable-512.png',
        '/icons/apple-touch-icon.png',
      ].sort(),
    );

    // Online, the page is live data, not the offline page.
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/Không có kết nối mạng/);

    await context.setOffline(true);
    await page.goto('/memories').catch(() => {});
    await expect(page.getByRole('heading', { name: 'Không có kết nối mạng' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible();
    // Its stylesheet came from the precache too: the body is the grid the stylesheet gives it.
    await expect(page.locator('body')).toHaveCSS('display', 'grid');
    await context.setOffline(false);
  });

  test('AC-NAV-09 desktop shows no card; /install renders the steps and /profile links to it', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.install-card')).toHaveCount(0);

    await page.goto('/profile');
    await page.getByRole('link', { name: 'Cài ứng dụng lên màn hình chính' }).click();
    await expect(page).toHaveURL(/\/install$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Cài ứng dụng' })).toBeVisible();
    await expect(page.locator('.current')).toHaveAttribute('data-kind', 'desktop-menu');
    await page.locator('details.others summary').click();
    await expect(page.getByText('iPhone và iPad')).toBeVisible();
  });
});

async function stubPrompt(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __prompted: number }).__prompted = 0;
  });
  // The listener is added after hydration: fire the event until the page has caught it.
  const dispatch = () =>
    page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: async () => {
          (window as unknown as { __prompted: number }).__prompted++;
        },
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      });
      window.dispatchEvent(event);
    });
  return dispatch;
}

test.describe('phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    userAgent: ANDROID_UA,
    hasTouch: true,
    isMobile: true,
  });

  test('AC-NAV-09 the card shows at 390 px, dismissal lasts across reloads and ends after 30 days', async ({
    page,
  }) => {
    await page.goto('/');
    const card = page.locator('.install-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: 'Xem cách cài' })).toHaveAttribute(
      'href',
      '/install',
    );
    await card.getByRole('button', { name: 'Để sau' }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), KEY))).toBeGreaterThan(0);

    // 29 days in: still hidden. 31 days in: back.
    await page.evaluate(({ k, at }) => localStorage.setItem(k, String(at)), {
      k: KEY,
      at: Date.now() - 29 * DAY,
    });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.evaluate(({ k, at }) => localStorage.setItem(k, String(at)), {
      k: KEY,
      at: Date.now() - 31 * DAY,
    });
    await page.reload();
    await expect(card).toBeVisible();
  });

  test('AC-NAV-09 a captured beforeinstallprompt shows the Install button, which calls prompt() and hides the card for good', async ({
    page,
  }) => {
    const dispatch = await stubPrompt(page);
    await page.goto('/');
    const install = page.locator('.install-card').getByRole('button', { name: 'Cài ứng dụng' });
    await expect(async () => {
      await dispatch();
      await expect(install).toBeVisible({ timeout: 500 });
    }).toPass();
    await install.click();
    await expect
      .poll(() => page.evaluate(() => (window as never as { __prompted: number }).__prompted))
      .toBe(1);
    await expect(page.locator('.install-card')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.install-card')).toHaveCount(0);
  });

  test('AC-NAV-09 /install offers the Install button once the event is captured', async ({
    page,
  }) => {
    const dispatch = await stubPrompt(page);
    await page.goto('/install');
    const install = page.locator('.steps').getByRole('button', { name: 'Cài ứng dụng' });
    await expect(async () => {
      await dispatch();
      await expect(install).toBeVisible({ timeout: 500 });
    }).toPass();
    await install.click();
    await expect
      .poll(() => page.evaluate(() => (window as never as { __prompted: number }).__prompted))
      .toBe(1);
  });

  test('AC-NAV-09 a standalone app shows no card and says it is installed', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.install-card')).toHaveCount(0);
    await page.goto('/install');
    await expect(page.locator('.current')).toHaveAttribute('data-kind', 'installed');
  });

  test('AC-NAV-09 an in-app browser gets the open-in-Chrome steps and a link to copy', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      userAgent: `${ANDROID_UA} Zalo/24.6.1`,
      hasTouch: true,
      isMobile: true,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    await page.goto('/install');
    await expect(page.locator('.current')).toHaveAttribute('data-kind', 'in-app');
    await expect(page.locator('.current')).toContainText('Chrome');
    await page.getByRole('button', { name: 'Sao chép liên kết' }).click();
    await expect(page.getByText('Đã sao chép liên kết')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${new URL(page.url()).origin}/`,
    );
    await context.close();
  });
});
