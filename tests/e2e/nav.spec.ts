import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { MEMBER_DEMO, PHOTO_DEMO, THREAD_DEMO, demoMemberPath, routePath } from './demo';

const routes = [
  '/',
  '/memories',
  PHOTO_DEMO,
  '/discussions',
  THREAD_DEMO,
  '/chat',
  '/members',
  MEMBER_DEMO,
  '/info/reunion',
  '/profile',
  '/install',
  '/admin',
  '/locked',
  '/denied',
];

const combos = [
  { theme: 'yearbook', mode: 'light' },
  { theme: 'yearbook', mode: 'dark' },
  { theme: 'minimal', mode: 'light' },
  { theme: 'minimal', mode: 'dark' },
  { theme: 'night', mode: 'dark' },
];

const widths = [390, 1280];

function url(route: string, theme: string, mode: string): string {
  const separator = route.includes('?') ? '&' : '?';
  return `${route}${separator}theme=${theme}&mode=${mode}`;
}

test('AC-NAV-01 the shell links reach every area from a nested route', async ({ page }) => {
  const areas = [
    ['Kỷ niệm', '/memories'],
    ['Thảo luận', '/discussions'],
    ['Trò chuyện', '/chat'],
    ['Bạn học', '/members'],
    ['Trang chủ', '/'],
  ] as const;

  const nested = await demoMemberPath(page.request);
  for (const [name, path] of areas) {
    await page.goto(nested);
    await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
    const navigation = page.getByRole('navigation', { name: 'Khu vực' }).first();
    const href = await navigation
      .getByRole('link', { name })
      .evaluate((link) => link.getAttribute('href'));
    expect(href?.startsWith('/')).toBe(true);
    await navigation.getByRole('link', { name }).click();
    await expect(page).toHaveURL(path === '/' ? /\/$/ : new RegExp(`${path}$`));
  }
});

test.describe('AC-UI-02 AC-NAV-01 every route renders without axe violations in every theme and size', () => {
  test.describe.configure({ mode: 'parallel' });
  for (const route of routes) {
    for (const { theme, mode } of combos) {
      for (const width of widths) {
        test(`${route} ${theme}/${mode} at ${width}`, async ({ page }) => {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
          const response = await page.goto(url(await routePath(page.request, route), theme, mode));

          // R-AUTH-11: /denied is a 403 for everyone who lands on it.
          expect(response?.status()).toBe(route === '/denied' ? 403 : 200);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await expect(page.locator('main')).toBeVisible();

          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();

          expect(
            results.violations,
            JSON.stringify(
              results.violations.map((violation) => ({
                id: violation.id,
                nodes: violation.nodes.map((node) => node.target),
              })),
              null,
              2,
            ),
          ).toEqual([]);
        });
      }
    }
  }
});

test('R-UI-10 every route has its own translated document title (WCAG 2.4.2)', async ({ page }) => {
  const titles = new Set<string>();
  for (const route of routes) {
    await page.goto(await routePath(page.request, route));
    const title = await page.title();
    expect(title, route).toMatch(/ · Class Hub$/);
    expect(title, route).not.toBe('Class Hub');
    titles.add(title);
  }
  expect(titles.size).toBeGreaterThanOrEqual(8);
  await page.goto('/memories');
  expect(await page.title()).toContain('Kỷ niệm');
});

test('R-UI-12 touch targets are at least 44 px on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, selectors] of [
    ['/memories', ['.account summary', '.chip >> nth=0', '.manage summary >> nth=0']],
    ['/', ['.rowhead a >> nth=0']],
  ] as const) {
    await page.goto(route);
    for (const selector of selectors) {
      const box = await page.locator(selector).boundingBox();
      expect(box, selector).not.toBeNull();
      expect(box!.height, selector).toBeGreaterThanOrEqual(44);
      expect(box!.width, selector).toBeGreaterThanOrEqual(44);
    }
  }
});

test('R-UI-08 the account menu closes on Esc, navigation, language switch and outside click', async ({
  page,
}) => {
  await page.goto('/');
  const menu = page.locator('details.account');
  const toggle = menu.locator('summary');
  await toggle.click();
  await expect(menu).toHaveJSProperty('open', true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveJSProperty('open', false);

  await toggle.click();
  await page.getByRole('link', { name: 'Trang cá nhân' }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(menu).toHaveJSProperty('open', false);

  await toggle.click();
  await page.locator('h1').click();
  await expect(menu).toHaveJSProperty('open', false);

  await toggle.click();
  await page.getByRole('button', { name: 'Chuyển sang English' }).click();
  await expect(menu).toHaveJSProperty('open', false);
});

test('R-UI-08 the bottom space is reserved once and the tab bar fits four items', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/members');
  const gap = await page.evaluate(() => {
    const main = document.querySelector('main')!.getBoundingClientRect();
    return document.documentElement.scrollHeight - main.bottom;
  });
  // The tab bar reserve (72 px) is already inside main's padding; nothing more below it.
  expect(gap).toBeLessThanOrEqual(1);
  const tabs = page.locator('nav.tabs a');
  const count = await tabs.count();
  const boxes = await tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(boxes[count - 1]!.right).toBeGreaterThan(388);
  expect(boxes[0]!.left).toBeLessThan(2);
});
