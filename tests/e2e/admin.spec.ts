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
