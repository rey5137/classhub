import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { vi as copy } from '../../src/lib/i18n/vi';
import { decodedSize, jpegWithGps, metadataMarkers, signature } from './images';

// R-MEM-13 / R-PROF-10 in the browser (Chromium and WebKit): crop by keyboard, store
// one 512 px square, show it on the profile and the member page, then remove it, which
// also leaves the demo admin as seeded.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('R-MEM-13 R-PROF-10 an avatar is cropped to one 512 px square, shown, and removed', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/profile');
  const fixture = await jpegWithGps(page, 1600, 1200);
  // Hydrated once the editor's button answers; the file input sits behind it.
  const dialog = page.getByRole('dialog', { name: copy['prof.avatar.title'] });
  await expect(async () => {
    await page
      .locator('#avatar-file')
      .setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: fixture });
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass();

  const frame = dialog.getByRole('button', { name: copy['prof.avatar.frame'] });
  await expect(frame).toBeVisible({ timeout: 30_000 });
  const before = await frame.locator('img').getAttribute('style');
  // Keyboard only: zoom in, then move the square.
  await frame.focus();
  await page.keyboard.press('+');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  expect(await frame.locator('img').getAttribute('style')).not.toBe(before);
  expect(
    Number(await dialog.getByRole('slider', { name: copy['prof.avatar.zoom'] }).inputValue()),
  ).toBeGreaterThan(1);

  await dialog.getByRole('button', { name: copy['prof.avatar.next'] }).click();
  // R-MEM-04: the confirm step shows the encoded square that will be stored.
  const result = dialog.getByRole('img', { name: copy['prof.avatar.preview'] });
  await expect(result).toBeVisible({ timeout: 30_000 });
  const axe = await new AxeBuilder({ page }).include('dialog').withTags(TAGS).analyze();
  expect(axe.violations.map((violation) => violation.id)).toEqual([]);

  const patched = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === '/api/v1/me',
  );
  await dialog.getByRole('button', { name: copy['prof.avatar.save'] }).click();
  expect((await patched).status()).toBe(200);
  await expect(page.getByText(copy['prof.avatar.saved'])).toBeVisible();
  const { profile } = (await (await page.request.get('/api/v1/me')).json()) as {
    profile: { id: string; avatarMediaId: string };
  };
  const src = `/api/v1/media/${profile.avatarMediaId}/image`;
  await expect(page.locator(`main img[src="${src}"]`)).toBeVisible();

  const stored = await page.request.get(src);
  const bytes = await stored.body();
  expect(['webp', 'jpeg']).toContain(signature(bytes));
  expect(metadataMarkers(bytes)).toEqual([]);
  expect(await decodedSize(page, src)).toEqual({ width: 512, height: 512 });
  expect(
    (await page.request.get(`/api/v1/media/${profile.avatarMediaId}/thumb`)).status(),
  ).not.toBe(200);

  // The member page renders it through the projection too (R-PROF-04).
  await page.goto(`/members/${profile.id}`);
  await expect(page.locator(`main img[src="${src}"]`)).toBeVisible();

  await page.goto('/profile');
  // The editor's button opens a chooser only once the page is hydrated.
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 500 });
    await page.getByRole('button', { name: copy['prof.avatar.change'] }).click();
    await chooser;
  }).toPass();
  // Enter in a field saves the profile; the picture's own form is never the default button.
  await page.locator('#profile-name').press('Enter');
  await expect(page.getByText(copy['prof.saved'])).toBeVisible();
  await expect(page.locator(`main img[src="${src}"]`)).toBeVisible();
  const kept = (await (await page.request.get('/api/v1/me')).json()) as {
    profile: { avatarMediaId: string | null };
  };
  expect(kept.profile.avatarMediaId).toBe(profile.avatarMediaId);

  await page.getByRole('button', { name: copy['prof.avatar.remove'] }).click();
  await expect(page.getByText(copy['prof.avatar.removed'])).toBeVisible();
  await expect(page.locator(`main img[src="${src}"]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: copy['prof.avatar.add'] })).toBeVisible();
});
