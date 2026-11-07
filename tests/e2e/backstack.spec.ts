import { expect, test, type Page } from '@playwright/test';
import { demoPhotoPath } from './demo';

// AC-NAV-11 (R-NAV-12): Back behaves like a native app's stack.

/** Opens a page and waits for hydration: a click before it is a plain browser link. */
async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
}

function tab(page: Page, name: string) {
  return page.locator('nav.tabs').getByRole('link', { name });
}

test.describe('AC-NAV-11 on the website', () => {
  test('a photo Back steps back to the filtered list, and a filter adds no entry', async ({
    page,
  }) => {
    await open(page, '/');
    await page
      .getByRole('navigation', { name: 'Khu vực' })
      .first()
      .getByRole('link', { name: 'Kỷ niệm' })
      .click();
    await expect(page).toHaveURL(/\/memories$/);

    await page.locator('.chips .chip.tnum').first().click();
    await expect(page).toHaveURL(/\/memories\?year=\d+/);
    const filtered = page.url();

    await page.locator('a.photo').first().click();
    await expect(page).toHaveURL(/\/memories\/[^/?]+$/);
    await page.getByRole('link', { name: 'Về trang kỷ niệm' }).click();
    await expect(page).toHaveURL(filtered);

    // The filter replaced /memories, and Back popped the photo: one more step is Home.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a deep-linked photo Back opens the list in its place', async ({ page }) => {
    await open(page, await demoPhotoPath(page.request));
    await page.getByRole('link', { name: 'Về trang kỷ niệm' }).click();
    await expect(page).toHaveURL(/\/memories$/);
    await page.goBack();
    await expect(page).toHaveURL('about:blank');
  });
});

test.describe('AC-NAV-11 in the installed app', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query.includes('display-mode: standalone')
          ? ({ ...original(query), matches: true, media: query } as MediaQueryList)
          : original(query);
    });
  });

  test('tabs never stack: Back from any tab lands on Home', async ({ page }) => {
    await open(page, '/');
    await tab(page, 'Kỷ niệm').click();
    await expect(page).toHaveURL(/\/memories$/);
    await tab(page, 'Trò chuyện').click();
    await expect(page).toHaveURL(/\/chat$/);
    await tab(page, 'Bạn học').click();
    await expect(page).toHaveURL(/\/members$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test('a tab tapped from a photo leaves Home right below it', async ({ page }) => {
    await open(page, '/');
    await tab(page, 'Kỷ niệm').click();
    await page.locator('a.photo').first().click();
    await expect(page).toHaveURL(/\/memories\/[^/?]+$/);

    await tab(page, 'Bạn học').click();
    await expect(page).toHaveURL(/\/members$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
  });

  test('the Home tab steps back to Home instead of stacking it', async ({ page }) => {
    await open(page, '/');
    await tab(page, 'Thảo luận').click();
    await expect(page).toHaveURL(/\/discussions$/);
    await tab(page, 'Trang chủ').click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page).toHaveURL('about:blank');
  });
});
