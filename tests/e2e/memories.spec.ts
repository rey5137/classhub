import { expect, test } from '@playwright/test';
import { vi as copy } from '../../src/lib/i18n/vi';
import { jpegWithGps } from './images';

// §7.4 in the browser: an album, an upload into it, the wall's filters, the photo page
// and a delete, all as the demo admin (the dev identity). Run on Chromium only: WebKit
// segfaults on the macOS this was built on (playwright.config.ts keeps both projects).

test('AC-MEM-03 upload with caption and album → wall → album and year filters → photo page → delete', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Unique per run, even for two workers that start in the same millisecond.
  const stamp = crypto.randomUUID().slice(0, 8);
  const albumName = `AC-MEM-03 album ${stamp}`;
  const caption = `AC-MEM-03 photo ${stamp}`;

  // An album made on /memories, with a year tag the wall's year filter can find.
  await page.goto('/memories');
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  await page.getByText(copy['mem.album.new'], { exact: true }).click();
  const albumForm = page.locator('form[action="?/createAlbum"]');
  await albumForm.getByLabel(copy['mem.album.name']).fill(albumName);
  await albumForm.getByLabel(copy['mem.album.year']).fill('2003');
  await albumForm.getByRole('button', { name: copy['mem.album.create'] }).click();
  await expect(page).toHaveURL(/\/memories\?album=[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: albumName })).toBeVisible();
  const albumId = new URL(page.url()).searchParams.get('album');

  // The upload sheet from 2b, into that album.
  const fixture = await jpegWithGps(page, 1200, 900);
  const sheet = page.getByRole('dialog', { name: copy['mem.upload.title'] });
  await expect(async () => {
    await page.getByRole('button', { name: copy['mem.add'] }).click();
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass();
  await sheet
    .locator('#upload-files')
    .setInputFiles({ name: 'class.jpg', mimeType: 'image/jpeg', buffer: fixture });
  await sheet.getByLabel(copy['mem.upload.caption']).fill(caption);
  await sheet.getByLabel(copy['mem.upload.album']).selectOption({ label: albumName });
  const completed = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/complete$/.test(new URL(response.url()).pathname),
  );
  await sheet.getByRole('button', { name: copy['mem.upload.submit'] }).click();
  const response = await completed;
  expect(response.status()).toBe(201);
  const { id } = (await response.json()) as { id: string };
  await expect(sheet.getByText(copy['mem.upload.done'].replace('{count}', '1'))).toBeVisible();
  await sheet.getByRole('button', { name: copy['mem.upload.close'] }).first().click();

  // On the album's wall, by caption and uploader.
  const tile = page.getByRole('link', { name: new RegExp(caption) });
  await expect(tile).toBeVisible();
  await expect(tile).toContainText('An Bui');
  await expect(tile).toContainText('2003');

  // The filters are plain links: the album's year shows it, another year does not.
  const years = page.getByRole('list', { name: copy['mem.yearChips'] });
  await years.getByRole('link', { name: '2003', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`album=${albumId}&year=2003$`));
  await expect(tile).toBeVisible();
  await years.getByRole('link', { name: '2005', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`album=${albumId}&year=2005$`));
  await expect(page.getByRole('heading', { name: copy['mem.emptyFiltered'] })).toBeVisible();
  const albumsList = page.getByRole('list', { name: copy['mem.albums'] });
  await albumsList.getByRole('link', { name: copy['mem.allAlbums'] }).click();
  await expect(page).toHaveURL(/\/memories\?year=2005$/);
  await years.getByRole('link', { name: '2003', exact: true }).click();
  await expect(page).toHaveURL(/\/memories\?year=2003$/);
  await expect(tile).toBeVisible();

  // The photo page: caption, uploader, album and year.
  await tile.click();
  await expect(page).toHaveURL(new RegExp(`/memories/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: caption })).toBeVisible();
  await expect(page.locator('dd', { hasText: 'An Bui' })).toBeVisible();
  await expect(page.getByRole('link', { name: albumName })).toBeVisible();
  await expect(page.getByRole('img', { name: caption })).toBeVisible();

  // Delete asks once more, then the photo is gone from the wall and its URLs at once.
  await page.getByText(copy['photo.delete'], { exact: true }).click();
  await page.getByRole('button', { name: copy['photo.deleteConfirm'] }).click();
  await expect(page).toHaveURL(/\/memories$/);
  await page.goto(`/memories?album=${albumId}`);
  await expect(page.getByRole('heading', { name: copy['mem.emptyFiltered'] })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(caption) })).toHaveCount(0);
  for (const variant of ['image', 'thumb']) {
    expect((await page.request.get(`/api/v1/media/${id}/${variant}`)).status()).toBe(404);
  }
  expect((await page.request.get(`/memories/${id}`)).status()).toBe(404);
});
