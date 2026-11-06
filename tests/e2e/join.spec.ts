import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DEV_SERVER_START_MS, startDevServer, stopDevServers } from './dev-server';

// §6.8 in the browser (slice 4d): /join with the `join` setting on, against a dev server
// of its own over a scratch database (port 5177), so no other spec sees the toggle or the
// requests. dev:offline answers Cloudflare's always-pass Turnstile test keys itself
// (R-PLAT-10); the widget script is stubbed here to issue their dummy token.

const BASE = 'http://127.0.0.1:5177';
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
let scratch: string;

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: BASE });

test.beforeAll(async () => {
  test.setTimeout(2 * DEV_SERVER_START_MS);
  scratch = mkdtempSync(join(tmpdir(), 'classhub-join-'));
  const env = {
    ...process.env,
    CLASSHUB_OFFLINE: '1',
    CLASSHUB_DB: join(scratch, 'join.sqlite'),
    CLASSHUB_OBJECTS: join(scratch, 'objects'),
    CLASSHUB_DEV_MEMBER: 'admin@example.com',
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
  };
  execFileSync('node_modules/.bin/tsx', ['scripts/seed-demo.ts'], {
    env,
    stdio: 'ignore',
    timeout: 60_000,
  });
  await startDevServer(5177, env);
});

test.afterAll(() => {
  stopDevServers();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function setJoin(request: APIRequestContext, on: boolean) {
  const response = await request.patch('/api/v1/admin/settings', {
    headers: { origin: BASE },
    data: { features: { join: on } },
  });
  expect(response.status()).toBe(200);
}

/** Stands in for Turnstile's widget: implicit rendering adds the token input to the form. */
async function stubTurnstile(page: Page) {
  await page.route(TURNSTILE_SCRIPT, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `for (const el of document.querySelectorAll('.cf-turnstile')) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'cf-turnstile-response';
        input.value = ${JSON.stringify(DUMMY_TOKEN)};
        el.append(input);
      }`,
    }),
  );
}

async function request(page: Page, email: string) {
  await page.goto('/join');
  await page.locator('#join-name').fill('Synthetic Classmate');
  await page.locator('#join-email').fill(email);
  await page.locator('#join-note').fill('12A, 2012');
  await expect(page.locator('input[name="cf-turnstile-response"]')).toHaveCount(1);
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('.join h2')).toBeVisible();
  return page.locator('main').innerText();
}

test('AC-AUTH-19 /join answers 404 while join requests are off', async ({ request }) => {
  expect((await request.get('/join')).status()).toBe(404);
  expect((await request.post('/join', { headers: { origin: BASE }, form: {} })).status()).toBe(404);
});

test('AC-AUTH-19 with join on, /join shows the site name and the form, no member data, and admits Turnstile in its CSP only', async ({
  page,
}) => {
  await setJoin(page.request, true);
  await stubTurnstile(page);
  const response = await page.goto('/join');
  expect(response?.status()).toBe(200);
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain('script-src');
  expect(csp).toMatch(/script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  expect(csp).toMatch(/frame-src https:\/\/challenges\.cloudflare\.com/);
  await expect(page.locator('#join-name')).toBeVisible();
  await expect(page.locator('.cf-turnstile')).toHaveAttribute(
    'data-sitekey',
    '1x00000000000000000000AA',
  );
  // The dev identity is the demo admin; the public page still renders as nobody.
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('An Bui');
  await expect(page.locator('nav a')).toHaveCount(0);
  // No way into the members' site: no brand link, account menu, profile or admin link.
  for (const href of ['/', '/profile', '/admin']) {
    await expect(page.locator(`a[href="${href}"]`)).toHaveCount(0);
  }
  await expect(page.locator('details.account')).toHaveCount(0);
  // The layout sets data-locale on mount: the switch is live once it is there.
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  await page.locator('header button.language').click();
  await expect(page.locator('h1')).toHaveText('Ask to join');
  await expect(page.locator('img[src^="/api/v1/media"]')).toHaveCount(0);

  const home = await page.goto('/');
  expect(home?.headers()['content-security-policy']).not.toContain('challenges.cloudflare.com');
});

test('AC-AUTH-19 a request gets the same confirmation as a repeat of it, and lands in the admin queue', async ({
  page,
}) => {
  await stubTurnstile(page);
  const first = await request(page, 'synthetic.classmate@example.test');
  const repeat = await request(page, 'SYNTHETIC.classmate@example.test');
  const member = await request(page, 'mai.nguyen@example.com');
  expect(repeat).toBe(first);
  expect(member).toBe(first);

  await page.goto('/admin');
  const card = page.locator('section[aria-labelledby="join-head"]');
  await expect(card.locator('.request')).toHaveCount(1);
  await expect(card).toContainText('synthetic.classmate@example.test');
  await expect(card).toContainText('12A, 2012');
  await card.locator('form[action="?/joinApprove"] button').click();
  await expect(card.locator('.request')).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="list-head"]')).toContainText(
    'synthetic.classmate@example.test',
  );
  await setJoin(page.request, false);
});

test('the account links stay on member pages with every optional section off', async ({ page }) => {
  const off = { memories: false, discussions: false, chat: false };
  const patch = (features: Record<string, boolean>) =>
    page.request.patch('/api/v1/admin/settings', {
      headers: { origin: BASE },
      data: { features },
    });
  expect((await patch(off)).status()).toBe(200);
  try {
    await page.goto('/');
    await expect(page.locator('details.account a[href="/profile"]')).toHaveCount(1);
    await expect(page.locator('details.account a[href="/admin"]')).toHaveCount(1);
    await expect(page.locator('header a.brand[href="/"]')).toHaveCount(1);
  } finally {
    expect((await patch({ memories: true, discussions: true, chat: true })).status()).toBe(200);
  }
});
