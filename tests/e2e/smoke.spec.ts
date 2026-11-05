import { expect, test } from '@playwright/test';

test('AC-NAV-01 the shell hydrates without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const response = await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('link', { name: /Our Class/ })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('lớp mình');
  expect(errors).toEqual([]);
});
