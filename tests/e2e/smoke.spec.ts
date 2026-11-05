import { expect, test } from '@playwright/test';

test('the shell renders', async ({ page }) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Class Hub' })).toBeVisible();
});
