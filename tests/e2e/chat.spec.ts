import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { DEV_SERVER_START_MS, startDevServer, stopDevServers } from './dev-server';

// §9.3 in the browser (slice 4b): live chat, reconnect, the startup gap, deletion and
// retry, against a dev server of its own (the local hub, R-PLAT-10) over a scratch
// database, in the `chromium-chat` project. The dev identity is one member per server
// and the local hub lives in that server, so both browsers sign in as the demo admin;
// each browser is its own socket, which is what the room counts and broadcasts to.

const BASE = 'http://127.0.0.1:5176';
const WS = /\/api\/v1\/chat\/ws$/;

let scratch: string;
const contexts: BrowserContext[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(2 * DEV_SERVER_START_MS);
  scratch = mkdtempSync(join(tmpdir(), 'classhub-chat-'));
  const env = {
    ...process.env,
    CLASSHUB_OFFLINE: '1',
    CLASSHUB_DB: join(scratch, 'chat.sqlite'),
    CLASSHUB_OBJECTS: join(scratch, 'objects'),
    CLASSHUB_DEV_MEMBER: 'admin@example.com',
  };
  execFileSync('node_modules/.bin/tsx', ['scripts/seed-demo.ts'], {
    env,
    stdio: 'ignore',
    timeout: 60_000,
  });
  await startDevServer(5176, env);
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

test.afterAll(() => {
  stopDevServers();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function browserPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  contexts.push(context);
  return context.newPage();
}

const status = (page: Page) => page.locator('.status[role="status"]');

/** Opens /chat and waits for the room's hello. */
async function openChat(page: Page): Promise<void> {
  await page.goto('/chat');
  await expect(status(page)).toHaveAttribute('data-status', 'online');
}

/** The bodies of the stored messages on screen, oldest first (not the outbox). */
const bodies = (page: Page) => page.locator('.log .msg[data-message-id] .body').allTextContents();

async function send(page: Page, body: string): Promise<void> {
  await page.locator('textarea#message').fill(body);
  await page.locator('textarea#message').press('Enter');
}

/** Waits until `body` shows exactly once as a stored message. */
async function showsOnce(page: Page, body: string): Promise<void> {
  await expect
    .poll(async () => (await bodies(page)).filter((text) => text.trim() === body).length)
    .toBe(1);
}

const tag = () => Math.random().toString(36).slice(2, 8);

test('AC-CHAT-01 two browsers chat both ways, in order, with the online count', async ({
  browser,
}) => {
  const [a, b] = [await browserPage(browser), await browserPage(browser)];
  await openChat(a);
  await openChat(b);
  await expect(status(a)).toHaveAttribute('data-online', '2');
  await expect(status(b)).toHaveAttribute('data-online', '2');

  // The history page went in silently; only live messages from others are announced.
  await expect(b.locator('[data-announcer]')).toHaveText('');
  const [first, second] = [`a→b ${tag()}`, `b→a ${tag()}`];
  await send(a, first);
  await showsOnce(b, first);
  await expect(b.locator('[data-announcer]')).toContainText(first);
  await expect(a.locator('[data-announcer]')).toHaveText('');
  await send(b, second);
  await showsOnce(a, second);
  for (const page of [a, b]) {
    expect((await bodies(page)).slice(-2).map((text) => text.trim())).toEqual([first, second]);
  }
  // Pressing Enter sent; the composer is empty again and nothing is left pending.
  await expect(a.locator('textarea#message')).toHaveValue('');
  await expect(a.locator('[data-outbox]')).toHaveCount(0);

  await b.close();
  await expect(status(a)).toHaveAttribute('data-online', '1');
});

test('AC-CHAT-07 a dropped socket reconnects and shows what it missed once, in order', async ({
  browser,
}) => {
  const [a, b] = [await browserPage(browser), await browserPage(browser)];
  let routes: WebSocketRoute[] = [];
  let release: () => void = () => {};
  let held: Promise<void> = Promise.resolve();
  await a.routeWebSocket(WS, async (ws) => {
    routes.push(ws);
    // While "offline", the reconnect waits here before it reaches the room.
    await held;
    ws.connectToServer();
  });
  await openChat(a);
  await openChat(b);

  held = new Promise((resolve) => (release = resolve));
  for (const ws of routes) await ws.close({ code: 4000, reason: 'test drop' });
  routes = [];
  await expect(status(a)).toHaveAttribute('data-status', 'reconnecting');

  const missed = [`missed 1 ${tag()}`, `missed 2 ${tag()}`, `missed 3 ${tag()}`];
  for (const body of missed) {
    await send(b, body);
    await showsOnce(b, body);
  }
  release();

  await expect(status(a)).toHaveAttribute('data-status', 'online');
  for (const body of missed) await showsOnce(a, body);
  expect((await bodies(a)).slice(-3).map((text) => text.trim())).toEqual(missed);
  const ids = await a
    .locator('.log .msg[data-message-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id')));
  expect(new Set(ids).size).toBe(ids.length);
});

test('AC-CHAT-15 a message sent between the history load and the socket open shows once', async ({
  browser,
}) => {
  const b = await browserPage(browser);
  await openChat(b);
  const a = await browserPage(browser);
  const between = `between ${tag()}`;
  const catchUps: string[] = [];
  a.on('request', (request) => {
    if (request.url().includes('/api/v1/chat/messages?after=')) catchUps.push(request.url());
  });
  // The first history page is fetched, then held while B sends; only then does A get it
  // and open its socket, so its timeline lacks `between` and hello.lastId points past it.
  await a.route('**/api/v1/chat/messages', async (route) => {
    const response = await route.fetch();
    await send(b, between);
    await showsOnce(b, between);
    await route.fulfill({ response });
  });
  await openChat(a);
  await showsOnce(a, between);
  expect(catchUps).toHaveLength(1);
  // A catch-up is history too: nothing is read out.
  await expect(a.locator('[data-announcer]')).toHaveText('');
  expect((await bodies(a)).at(-1)?.trim()).toBe(between);
});

test('R-CHAT-03 deleting your message leaves a tombstone in the other browser', async ({
  browser,
}) => {
  const [a, b] = [await browserPage(browser), await browserPage(browser)];
  await openChat(a);
  await openChat(b);
  const body = `delete me ${tag()}`;
  await send(a, body);
  await showsOnce(b, body);
  const id = await a
    .locator('.log .msg[data-message-id]', { hasText: body })
    .getAttribute('data-message-id');

  await a.locator(`.msg[data-message-id="${id}"] button.action`).click();
  await a.locator('dialog .dialog-actions button.primary').click();

  for (const page of [a, b]) {
    await expect(page.locator(`.msg.gone[data-message-id="${id}"]`)).toHaveCount(1);
    expect((await bodies(page)).map((text) => text.trim())).not.toContain(body);
  }
  // Focus went somewhere stable, not to the page body.
  await expect(a.locator('textarea#message')).toBeFocused();
});

test('R-CHAT-02 a message the room did not save shows not sent, and Retry resends the same nonce', async ({
  browser,
}) => {
  const [a, b] = [await browserPage(browser), await browserPage(browser)];
  const frames: { clientNonce: string; body: string }[] = [];
  await a.routeWebSocket(WS, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { clientNonce: string; body: string };
      frames.push(frame);
      // The first send never reaches the room: answer as a failed D1 batch would (R-CHAT-06).
      if (frames.length === 1) {
        ws.send(
          JSON.stringify({ type: 'error', code: 'not_saved', clientNonce: frame.clientNonce }),
        );
      } else {
        server.send(message);
      }
    });
  });
  await openChat(a);
  await openChat(b);

  const body = `retry me ${tag()}`;
  await send(a, body);
  const failed = a.locator('[data-outbox="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.locator('.body')).toHaveText(body);
  await failed.locator('button.action').first().click();

  await showsOnce(a, body);
  await showsOnce(b, body);
  await expect(a.locator('[data-outbox]')).toHaveCount(0);
  expect(frames).toHaveLength(2);
  expect(frames[1]!.clientNonce).toBe(frames[0]!.clientNonce);
});

test('R-CHAT-12 the unread marker sits above the first unread message and the mark moves to the newest', async ({
  browser,
}) => {
  const reader = await browserPage(browser);
  const history = (await (await reader.request.get('/api/v1/chat/messages')).json()) as {
    items: { id: string; sender: { id: string } }[];
  };
  const viewer = history.items.at(-1)!.sender.id;
  // Read up to a message with someone else's message after it (the seeded room has several).
  const index = history.items.findIndex(
    (item, at) => at > 0 && item.sender.id !== viewer && at < history.items.length - 1,
  );
  const lastRead = history.items[index - 1]!.id;
  await reader.addInitScript((id) => localStorage.setItem('classhub.chat.lastRead', id), lastRead);
  await openChat(reader);
  const firstUnread = history.items.slice(index).find((item) => item.sender.id !== viewer)!.id;
  await expect(reader.locator('.unread + .msg')).toHaveAttribute('data-message-id', firstUnread);
  await expect(reader.locator('.unread')).toHaveCount(1);
  await expect
    .poll(() => reader.evaluate(() => localStorage.getItem('classhub.chat.lastRead')))
    .toBe(history.items.at(-1)!.id);
});

for (const route of ['/chat', '/']) {
  test(`AC-BUD-03 ${route} makes no repeating request while idle for 5 minutes`, async ({
    browser,
  }) => {
    const page = await browserPage(browser);
    await page.clock.install();
    const requests: string[] = [];
    const framesSent: string[] = [];
    page.on('request', (request) => requests.push(`${request.method()} ${request.url()}`));
    page.on('websocket', (ws) => {
      if (WS.test(ws.url())) ws.on('framesent', (frame) => framesSent.push(String(frame.payload)));
    });
    if (route === '/chat') await openChat(page);
    else await page.goto(route);
    await page.waitForLoadState('networkidle');
    requests.length = 0;

    await page.clock.runFor(5 * 60_000);
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
    expect(framesSent).toEqual([]);
    if (route === '/chat') await expect(status(page)).toHaveAttribute('data-status', 'online');
  });
}
