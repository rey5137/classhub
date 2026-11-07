import { expect, test } from '@playwright/test';

// R-UI accessibility: on the invite screen every row action names its person, so a
// screen reader's list of buttons never repeats one bare verb.
test('the /admin row actions each have a distinct accessible name', async ({ page }) => {
  await page.goto('/admin');
  const names = await page
    .locator('.people button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
  expect(names.length).toBeGreaterThan(2);
  expect(names.every((name) => name.includes(':'))).toBe(true);
  expect(new Set(names).size).toBe(names.length);
});

// R-BAK-09: the backup status card is on /admin; the dev seed records no backup, so it says so.
test('R-BAK-09 /admin shows the backup status card', async ({ page }) => {
  await page.goto('/admin');
  const card = page.locator('[aria-labelledby="backup-head"]');
  await expect(card.locator('#backup-head')).toBeVisible();
  await expect(card.locator('dl')).toHaveCount(0);
  await expect(card.locator('p').first()).not.toBeEmpty();
});
