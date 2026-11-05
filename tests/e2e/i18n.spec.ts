import { expect, test } from '@playwright/test';

test('AC-UI-06 the locale switch translates the shell and persists', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('navigation', { name: 'Khu vực' }).first()).toContainText(
    'Trang chủ',
  );
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  await page.locator('summary').click();
  await page.getByRole('button', { name: 'Chuyển sang English' }).click();

  expect(await page.evaluate(() => localStorage.getItem('classhub.locale'))).toBe('en');
  const cookie = (await page.context().cookies()).find(({ name }) => name === 'classhub.locale');
  expect(cookie).toMatchObject({ value: 'en', path: '/', sameSite: 'Lax', secure: false });
  expect(cookie!.expires - Date.now() / 1000).toBeGreaterThan(31_535_990);
  expect(cookie!.expires - Date.now() / 1000).toBeLessThanOrEqual(31_536_000);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Areas' }).first()).toContainText('Home');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('here is our class');
  await expect(page.locator('body')).not.toContainText('nav.home');

  expect(await page.evaluate(() => localStorage.getItem('classhub.locale'))).toBe('en');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('navigation', { name: 'Areas' }).first()).toContainText('Home');
});

test('R-UI-10 English cookie renders the first response without JavaScript', async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await context.addCookies([
      { name: 'classhub.locale', value: 'en', url: 'http://127.0.0.1:5173' },
    ]);
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:5173/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('here is our class');
    await expect(page.getByRole('navigation', { name: 'Areas' }).first()).toContainText('Home');
  } finally {
    await context.close();
  }
});

test('R-UI-10 invalid cookie falls back and localStorage cannot override server language', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await context.addCookies([
    { name: 'classhub.locale', value: 'unknown', url: 'http://127.0.0.1:5173' },
  ]);
  await page.addInitScript(() => localStorage.setItem('classhub.locale', 'en'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('navigation', { name: 'Khu vực' }).first()).toContainText(
    'Trang chủ',
  );
  await context.addCookies([
    { name: 'classhub.locale', value: 'en', url: 'http://127.0.0.1:5173' },
  ]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'en');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('here is our class');
  expect(errors).toEqual([]);
});

test('AC-UI-06 placeholder content follows the selected locale on navigation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  await page.locator('summary').click();
  await page.getByRole('button', { name: 'Chuyển sang English' }).click();
  await expect(page.getByText('Morning in the schoolyard', { exact: true })).toBeAttached();
  await page.goto('/memories');
  await expect(page.getByText('Setting up tents', { exact: true }).first()).toBeAttached();
  await expect(page.getByText('03.2006 · 14 photos', { exact: true }).first()).toBeAttached();
  await page.goto('/chat');
  await expect(
    page.getByText('Please confirm how many are coming before June 30.', { exact: true }),
  ).toBeVisible();
});

test('R-UI-10 the chat lede shows the configured retention days', async ({ page }) => {
  await page.goto('/chat');
  await expect(page.locator('main')).toContainText('365 ngày');
  await expect(page.locator('main')).not.toContainText('90 ngày');
});
