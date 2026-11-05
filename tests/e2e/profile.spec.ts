import { expect, test } from '@playwright/test';

// R-PROF-10/11: clearing the profile and asking for deletion each take a second,
// explicit step. Nothing is submitted here, so the demo data stays as seeded.

test('R-PROF-10 R-PROF-11 clear and deletion ask for confirmation before submitting', async ({
  page,
}) => {
  await page.goto('/profile');
  for (const [open, confirm] of [
    ['Xoá thông tin cá nhân', 'Đồng ý, xoá thông tin cá nhân'],
    ['Yêu cầu xoá dữ liệu', 'Đồng ý, yêu cầu xoá tài khoản'],
  ] as const) {
    const button = page.getByRole('button', { name: confirm });
    await expect(button).toBeHidden();
    await page.locator('summary', { hasText: open }).click();
    await expect(button).toBeVisible();
  }
});
