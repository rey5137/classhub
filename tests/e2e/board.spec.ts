import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { COMMENT_MAX } from '../../src/lib/contracts/discussions';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { DEV_SERVER_START_MS, startDevServer, stopDevServers } from './dev-server';

// The board and thread flows that write (plan §3b checklist 1-3, AC-BRD-02 over 5,000
// threads). They run in the `chromium-board` project against two dev servers of their own,
// the demo admin on 5174 and the demo member Mai on 5175, over one scratch database, so no
// other spec sees their threads. The folder is removed afterwards.

const ADMIN_URL = 'http://127.0.0.1:5174';
const MEMBER_URL = 'http://127.0.0.1:5175';
const SEEDED = 5000;

let scratch: string;
let dbFile: string;

test.describe.configure({ mode: 'serial' });

function env(member: string) {
  return {
    ...process.env,
    CLASSHUB_OFFLINE: '1',
    CLASSHUB_DB: dbFile,
    CLASSHUB_OBJECTS: join(scratch, 'objects'),
    CLASSHUB_DEV_MEMBER: member,
  };
}

/**
 * 5,000 threads in one recursive CTE (no bound parameters, R-DB D1 limit), their last
 * activity a day back and in threes on the same millisecond, so the id tiebreak is paged
 * too; every 1,000th is pinned.
 */
function seedThreads() {
  const database = new BetterSqlite3(dbFile);
  try {
    const admin = database
      .prepare("select id from users where auth_email = 'admin@example.com'")
      .get() as { id: string };
    const base = Date.now() - 86_400_000;
    database.exec(`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < ${SEEDED})
      insert into posts (id, author_id, title, body_md, is_pinned, is_locked, comment_count,
        created_at, updated_at, last_activity_at)
      select printf('%08x-0000-7000-8000-%012x', i, i), '${admin.id}', 'Board ' || i, 'Body ' || i,
        case when i % 1000 = 0 then 1 else 0 end, 0, 0,
        ${base} - i * 1000, ${base} - i * 1000, ${base} - (i / 3) * 1000
      from n`);
  } finally {
    database.close();
  }
}

const PAGED_THREAD = 'eeeeeeee-0000-7000-8000-000000000001';
const pagedComment = (i: number) => `eeeeeeee-0001-7000-8000-${i.toString(16).padStart(12, '0')}`;

/**
 * A thread with 22 comments, so Mai's (the 21st) opens the second page: 20 by the admin, Mai's,
 * then one more by the admin so her deleted comment keeps its place as a stub (R-BRD-08). Its
 * activity is older than every seeded board thread.
 */
function seedPagedThread() {
  const database = new BetterSqlite3(dbFile);
  try {
    const id = (email: string) =>
      (database.prepare('select id from users where auth_email = ?').get(email) as { id: string })
        .id;
    const [admin, mai] = [id('admin@example.com'), id('mai.nguyen@example.com')];
    const base = Date.now() - 30 * 86_400_000;
    database
      .prepare(
        `insert into posts (id, author_id, title, body_md, is_pinned, is_locked, comment_count,
          created_at, updated_at, last_activity_at) values (?, ?, 'Paged thread', 'Body', 0, 0, 22, ?, ?, ?)`,
      )
      .run(PAGED_THREAD, admin, base, base, base + 22);
    database.exec(`
      with recursive n(i) as (select 1 union all select i + 1 from n where i < 22)
      insert into comments (id, post_id, author_id, body_md, created_at, updated_at)
      select printf('eeeeeeee-0001-7000-8000-%012x', i), '${PAGED_THREAD}',
        case when i = 21 then '${mai}' else '${admin}' end, 'Comment ' || i, ${base} + i, ${base} + i
      from n`);
  } finally {
    database.close();
  }
}

/** The board's own order, read straight from the scratch database. */
function boardOrder(): string[] {
  const database = new BetterSqlite3(dbFile, { readonly: true });
  try {
    return (
      database
        .prepare(
          'select id from posts where deleted_at is null order by is_pinned desc, last_activity_at desc, id desc',
        )
        .all() as { id: string }[]
    ).map((row) => row.id);
  } finally {
    database.close();
  }
}

test.beforeAll(async () => {
  test.setTimeout(4 * DEV_SERVER_START_MS);
  scratch = mkdtempSync(join(tmpdir(), 'classhub-board-'));
  dbFile = join(scratch, 'board.sqlite');
  execFileSync('node_modules/.bin/tsx', ['scripts/seed-demo.ts'], {
    env: env('admin@example.com'),
    stdio: 'ignore',
    timeout: 60_000,
  });
  seedThreads();
  seedPagedThread();
  // One at a time, so the two servers don't race each other's first dependency scan.
  await startDevServer(5174, env('admin@example.com'));
  await startDevServer(5175, env('mai.nguyen@example.com'));
});

test.afterAll(() => {
  stopDevServers();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// Server-rendered links are relative (`./discussions/<id>`) and client-rendered ones
// absolute, so both read back as the thread id or the path they point at.
const threadLinks = (html: string) =>
  [...html.matchAll(/href="[^"]*discussions\/([0-9a-f-]{36})"/g)].map((match) => match[1]!);
const olderLink = (html: string, at: string) => {
  const href = /href="([^"]*discussions\?cursor=[^"]+)"/.exec(html)?.[1];
  if (!href) return null;
  const url = new URL(href.replaceAll('&amp;', '&'), at);
  return `${url.pathname}${url.search}`;
};

test('AC-BRD-02 the board over 5,000 threads lists pinned first and pages with no duplicate or gap', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const expected = boardOrder();
  expect(expected.length).toBeGreaterThan(SEEDED);

  // In the browser: the first pages through the "older threads" link, pinned rows on top.
  await page.goto(`${ADMIN_URL}/discussions`);
  const rows = page.locator('.threads .post');
  await expect(rows).toHaveCount(20);
  const pinnedFlags = await rows.evaluateAll((posts) =>
    posts.map((post) => post.querySelector('.pin') !== null),
  );
  const pinnedCount = pinnedFlags.filter(Boolean).length;
  expect(pinnedCount).toBe(6); // five seeded and the demo seed's own
  expect(pinnedFlags).toEqual(pinnedFlags.map((_, index) => index < pinnedCount));
  const clicked: string[] = [];
  const shown = () =>
    page
      .locator('.threads .post h3 a')
      .evaluateAll((links) =>
        links.map((link) => /([0-9a-f-]{36})$/.exec(link.getAttribute('href') ?? '')?.[1] ?? ''),
      );
  for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
    const hrefs = await shown();
    expect(hrefs).toHaveLength(20);
    clicked.push(...hrefs);
    await page.getByRole('link', { name: 'Bài cũ hơn' }).click();
    // The next page has replaced this one once its first row is a different thread.
    await expect.poll(async () => (await shown())[0]).not.toBe(hrefs[0]);
  }
  expect(clicked).toEqual(expected.slice(0, 60));

  // Every remaining page, following each page's own "older threads" link as plain HTML
  // (no JS), so all 251 pages are read without 251 clicks.
  const seen: string[] = [];
  let next: string | null = '/discussions';
  let pages = 0;
  while (next) {
    const response = await page.request.get(`${ADMIN_URL}${next}`);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const ids = threadLinks(html);
    expect(ids.length).toBeLessThanOrEqual(20);
    seen.push(...ids);
    next = olderLink(html, `${ADMIN_URL}${next}`);
    pages += 1;
    // A cursor that doesn't move would loop forever; fail instead.
    expect(pages).toBeLessThanOrEqual(Math.ceil(expected.length / 20));
  }
  expect(pages).toBe(Math.ceil(expected.length / 20));
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toEqual(expected);
});

async function contexts(browser: Browser): Promise<[BrowserContext, BrowserContext]> {
  const admin = await browser.newContext({ baseURL: ADMIN_URL });
  // The second account posts with JavaScript off: every form here is a plain form (R-AUTH-17).
  const member = await browser.newContext({ baseURL: MEMBER_URL, javaScriptEnabled: false });
  return [admin, member];
}

async function writeThread(page: Page, title: string, body: string): Promise<string> {
  await page.goto('/discussions');
  await page.getByText('Viết bài', { exact: true }).click();
  await page.getByLabel('Tiêu đề').fill(title);
  await page.getByLabel('Nội dung').fill(body);
  await page.getByRole('button', { name: 'Đăng bài' }).click();
  await expect(page).toHaveURL(/\/discussions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  return new URL(page.url()).pathname;
}

test('plan 3b checklist 1-2: a thread with Markdown, a second account comments, it rises to the top; a lock hides the comment form until unlocked', async ({
  browser,
}) => {
  const [adminContext, memberContext] = await contexts(browser);
  const admin = await adminContext.newPage();
  const member = await memberContext.newPage();
  try {
    const title = `Picnic ${Date.now()}`;
    const path = await writeThread(
      admin,
      title,
      'Hẹn cả lớp **thứ Bảy**.\n\n- mang nước\n- mang ảnh cũ\n\n[Bản đồ](https://maps.example.test/park)',
    );
    const body = admin.locator('.post .markdown');
    await expect(body.locator('strong')).toHaveText('thứ Bảy');
    await expect(body.locator('li')).toHaveText(['mang nước', 'mang ảnh cũ']);
    const link = body.getByRole('link', { name: 'Bản đồ' });
    await expect(link).toHaveAttribute('href', 'https://maps.example.test/park');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');

    // Mai comments without JavaScript; Post/Redirect/Get lands on the comment.
    await member.goto(path);
    await member.locator('#comment-body').fill('Mình đi được!');
    await member.getByRole('button', { name: 'Gửi bình luận' }).click();
    await expect(member).toHaveURL(new RegExp(`${path}#comment-[0-9a-f-]{36}$`));
    const anchor = new URL(member.url()).hash;
    await expect(member.locator(anchor)).toContainText('Mai Nguyen');
    await expect(member.locator(anchor)).toContainText('Mình đi được!');

    // The board: the commented thread is the first unpinned one.
    await member.goto('/discussions');
    const firstUnpinned = member
      .locator('.threads .post')
      .filter({ hasNot: member.locator('.pin') });
    await expect(firstUnpinned.first().getByRole('heading')).toHaveText(title);
    await expect(firstUnpinned.first()).toContainText('1 trả lời');

    // Admin pins and locks it: it tops the board and Mai's comment form is gone.
    await admin.getByRole('button', { name: 'Ghim bài' }).click();
    await expect(admin.getByText('Đã ghim bài.')).toBeVisible();
    await admin.getByRole('button', { name: 'Khoá bình luận' }).click();
    await expect(admin.getByText('Đã khoá bình luận.')).toBeVisible();
    // R-BRD-07: admins included.
    await expect(admin.locator('#comment-body')).toHaveCount(0);
    await member.goto('/discussions');
    await expect(member.locator('.threads .post').first().getByRole('heading')).toContainText(
      title,
    );
    await member.goto(path);
    await expect(member.locator('#comment-body')).toHaveCount(0);
    await expect(member.getByText('Cuộc thảo luận này đã khoá')).toBeVisible();

    await admin.getByRole('button', { name: 'Mở khoá bình luận' }).click();
    await expect(admin.getByText('Đã mở khoá bình luận.')).toBeVisible();
    await member.reload();
    await expect(member.locator('#comment-body')).toBeVisible();
  } finally {
    await adminContext.close();
    await memberContext.close();
  }
});

test('plan 3b checklist 3, AC-BRD-01: a script tag and a javascript: link in a post show as text, never as a tag or a link', async ({
  browser,
}) => {
  const [adminContext, memberContext] = await contexts(browser);
  const admin = await adminContext.newPage();
  let dialogs = 0;
  admin.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  try {
    await writeThread(
      admin,
      `Hostile ${Date.now()}`,
      '<script>alert(1)</script>\n\n[x](javascript:alert(1))',
    );
    const body = admin.locator('.post .markdown');
    await expect(body).toContainText('<script>alert(1)</script>');
    await expect(body.locator('script')).toHaveCount(0);
    await expect(body.locator('a')).toHaveCount(0);
    await expect(admin.locator('a[href^="javascript:" i]')).toHaveCount(0);
    expect(dialogs).toBe(0);
  } finally {
    await adminContext.close();
    await memberContext.close();
  }
});

test('R-AUTH-17 R-BRD-07 without JavaScript a failed comment edit and a comment delete on the second page stay on that page', async ({
  browser,
}) => {
  const [adminContext, memberContext] = await contexts(browser);
  const member = await memberContext.newPage();
  try {
    await member.goto(`/discussions/${PAGED_THREAD}`);
    await member.getByRole('link', { name: 'Bình luận mới hơn' }).click();
    await expect(member).toHaveURL(/\?cursor=/);
    const secondPage = member.url();
    const own = member.locator(`#comment-${pagedComment(21)}`);
    await expect(own).toContainText('Comment 21');
    await expect(member.locator(`#comment-${pagedComment(1)}`)).toHaveCount(0);

    // Over the limit, so the server refuses it; maxlength is lifted so the text can be typed.
    const tooLong = 'x'.repeat(COMMENT_MAX + 1);
    await own.getByText('Sửa', { exact: true }).click();
    const field = own.getByLabel('Nội dung bình luận');
    await field.evaluate((element) => element.removeAttribute('maxlength'));
    await field.fill(tooLong);
    await own.getByRole('button', { name: 'Lưu' }).click();
    await expect(member).toHaveURL(/\?cursor=[^&]+&\/editComment$/);
    await expect(own.getByText('Bình luận cần từ 1 đến 2.000 ký tự.')).toBeVisible();
    await expect(own.getByLabel('Nội dung bình luận')).toHaveValue(tooLong);
    await expect(member.locator(`#comment-${pagedComment(1)}`)).toHaveCount(0);

    await member.goto(secondPage);
    await own.getByText('Xoá', { exact: true }).click();
    await own.getByRole('button', { name: 'Xoá bình luận' }).click();
    await expect(member).toHaveURL(/\?cursor=[^&]+&\/deleteComment$/);
    await expect(member.getByText('Đã xoá bình luận.')).toBeVisible();
    await expect(own).toContainText('Bình luận đã xoá');
    await expect(member.locator(`#comment-${pagedComment(22)}`)).toContainText('Comment 22');
    await expect(member.locator(`#comment-${pagedComment(1)}`)).toHaveCount(0);
  } finally {
    await adminContext.close();
    await memberContext.close();
  }
});
