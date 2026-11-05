import { expect, test } from '@playwright/test';

// AC-PROF-07 in the browser: the demo seed's classmates, searched without accents or case.

test('AC-PROF-07 the directory finds a classmate by an accented, upper-case name and opens their page', async ({
  page,
}) => {
  await page.goto('/members');
  const people = page.locator('.person');
  await expect(people.first()).toBeVisible();
  expect(await people.count()).toBeGreaterThan(5);

  const search = page.getByRole('searchbox');
  await search.fill('NGUYỄN');
  await search.press('Enter');
  await expect(page).toHaveURL(/[?&]q=NGUY/);
  await expect(people).toHaveCount(1);
  await expect(people.first()).toContainText('Mai Nguyen');

  await people.first().getByRole('link').click();
  await expect(page).toHaveURL(/\/members\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mai Nguyen');
  // R-PROF-03: the messaging link is shared with members; the phone only with admins,
  // and the demo identity is the admin.
  await expect(page.getByRole('link', { name: 'https://zalo.me/demo-mai' })).toHaveAttribute(
    'href',
    'https://zalo.me/demo-mai',
  );
  await expect(page.getByRole('link', { name: '+84000000001' })).toHaveAttribute(
    'href',
    'tel:+84000000001',
  );
});

test('AC-PROF-07 a search with no match says so', async ({ page }) => {
  await page.goto('/members?q=zzzz');
  await expect(page.locator('.person')).toHaveCount(0);
  await expect(page.getByText('zzzz')).toBeVisible();
});
