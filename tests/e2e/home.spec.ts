import { expect, test } from '@playwright/test';
import { demoThreadPath } from './demo';

// AC-BRD-05 in the browser: Home for the demo seed (seed-demo.ts), read-only, so it
// runs on the shared data/dev.sqlite.

test('AC-BRD-05 Home shows the welcome, pinned info, the reunion card, newest photos and active threads, in that order', async ({
  page,
}) => {
  await page.goto('/');
  const main = page.locator('main');

  // The welcome block: the greeting and the class name with its years.
  const greeting = main.getByRole('heading', { level: 1 });
  await expect(greeting).toHaveText('Chào An Bui, lớp mình đây.');
  await expect(main.locator('.page-header .lede')).toContainText('·');

  // Pinned: the pinned info page and the pinned thread; the reunion page is its own card.
  const pinned = main.locator('section.pinned');
  await expect(pinned.getByRole('link', { name: 'Ban cán sự lớp' })).toHaveAttribute(
    'href',
    '/info/ban-can-su',
  );
  await expect(pinned.getByRole('link', { name: 'Đăng ký họp lớp 20 năm' })).toBeVisible();
  await expect(pinned.locator('.pin')).toHaveText(['GHIM']);
  await expect(pinned.getByRole('link', { name: 'Họp lớp 20 năm', exact: true })).toHaveCount(0);
  await expect(pinned.getByRole('link', { name: 'Quỹ lớp', exact: true })).toHaveCount(0);

  const reunion = main.locator('.reunion');
  await expect(reunion.getByRole('heading', { name: 'Họp lớp 20 năm' })).toBeVisible();
  await expect(reunion).toContainText('sân trường cũ');
  await expect(reunion.getByRole('link', { name: 'Xem chi tiết' })).toHaveAttribute(
    'href',
    '/info/reunion',
  );

  // The newest photos: at least the ten painted ones, never more than twelve, each a link
  // to its photo page with a thumbnail.
  const photos = main.getByRole('region', { name: 'Ảnh mới' }).getByRole('link');
  const photoCount = await photos.count();
  expect(photoCount).toBeGreaterThanOrEqual(10);
  expect(photoCount).toBeLessThanOrEqual(12);
  await expect(photos.first()).toHaveAttribute('href', /^\/memories\/[0-9a-f-]{36}$/);
  await expect(photos.first().locator('img')).toHaveAttribute('src', /\/thumb$/);

  // The most recently active unpinned threads, five at most; the pinned one is listed above only.
  const active = main.locator('.active .post');
  const activeCount = await active.count();
  expect(activeCount).toBeGreaterThanOrEqual(3);
  expect(activeCount).toBeLessThanOrEqual(5);
  await expect(main.locator('.active')).toContainText('Ai còn giữ ảnh chuyến dã ngoại Ba Vì?');
  await expect(main.locator('.active')).not.toContainText('Đăng ký họp lớp 20 năm');

  // R-BRD-01: the sections follow the spec's order in the document.
  const order = await page.evaluate(() => {
    const at = (selector: string) => document.querySelector(selector);
    const nodes = ['main h1', 'main section.pinned', 'main .reunion', 'main .rail', 'main .active'];
    return nodes.map((selector, index) => {
      const next = nodes[index + 1];
      if (!next) return true;
      const a = at(selector);
      const b = at(next);
      return Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
  });
  expect(order).toEqual([true, true, true, true, true]);
});

test("R-UI-11 the browser's time zone reaches the tz cookie and the server renders times in it", async ({
  browser,
  baseURL,
}) => {
  // Far from the Level B default (Asia/Ho_Chi_Minh), so the first render is in the wrong zone.
  const context = await browser.newContext({
    baseURL,
    timezoneId: 'America/New_York',
  });
  try {
    const page = await context.newPage();
    await page.goto(await demoThreadPath(page.request));
    await expect
      .poll(async () => (await context.cookies()).find((cookie) => cookie.name === 'tz'))
      .toMatchObject({ value: 'America%2FNew_York', path: '/', sameSite: 'Lax' });
    // After the one re-render, the post's time is the browser's own reading of its instant.
    const time = page.locator('main article time').first();
    await expect
      .poll(() =>
        time.evaluate(
          (element) =>
            element.textContent ===
            new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(element.getAttribute('datetime') ?? ''),
            ),
        ),
      )
      .toBe(true);
    // A fresh server render reads the cookie: right before any JavaScript runs.
    const html = await (await page.request.get(page.url())).text();
    const datetime = await time.getAttribute('datetime');
    const expected = await page.evaluate(
      (iso) =>
        new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso ?? ''),
        ),
      datetime,
    );
    expect(html).toContain(`>${expected}</time>`);
  } finally {
    await context.close();
  }
});
