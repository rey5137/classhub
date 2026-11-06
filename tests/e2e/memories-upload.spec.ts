import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { vi as copy } from '../../src/lib/i18n/vi';
import { decodedSize, jpegWithGps, metadataMarkers, signature } from './images';

// §7.1 in the browser (Chromium and WebKit, playwright.config.ts): what the encoder
// stores, and what it refuses before any request.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function openSheet(page: Page) {
  const sheet = page.getByRole('dialog', { name: copy['mem.upload.title'] });
  // A click that lands before hydration does nothing; click again until the sheet opens.
  await expect(async () => {
    await page.getByRole('button', { name: copy['mem.add'] }).click();
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass();
  // R-MEM-05: the sheet says only an optimized copy is kept.
  await expect(sheet.getByText(copy['mem.upload.originals'])).toBeVisible();
  return sheet;
}

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).include('dialog').withTags(TAGS).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

test('AC-MEM-01 a 12 MP JPEG with GPS EXIF is stored as a ≤ 2000 px copy and ≤ 480 px thumb, ≤ 2 MB, with no EXIF', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/memories');
  const fixture = await jpegWithGps(page, 4000, 3000);
  // The scan below sees the metadata in the original, so a clean result means it was dropped.
  expect(metadataMarkers(fixture)).toEqual(['APP1', 'Exif', 'GPS']);

  const sheet = await openSheet(page);
  // R-MEM-04: the encode runs in a worker, and the page logs no error doing so.
  const workers: string[] = [];
  const errors: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await sheet
    .locator('#upload-files')
    .setInputFiles({ name: 'reunion.jpg', mimeType: 'image/jpeg', buffer: fixture });
  // R-MEM-04: the preview is the encoded copy itself, not the original.
  const preview = sheet.getByRole('img', {
    name: copy['mem.upload.preview'].replace('{name}', 'reunion.jpg'),
  });
  await expect(preview).toBeVisible({ timeout: 30_000 });
  expect(await preview.getAttribute('src')).toMatch(/^blob:/);
  expect(workers).toEqual([expect.stringMatching(/worker/)]);
  expect(errors).toEqual([]);
  await axeClean(page);

  await sheet.getByLabel(copy['mem.upload.caption']).fill('AC-MEM-01 synthetic fixture');
  await sheet.getByLabel(copy['mem.upload.year']).fill('2005');
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

  const image = await page.request.get(`/api/v1/media/${id}/image`);
  const thumb = await page.request.get(`/api/v1/media/${id}/thumb`);
  expect([image.status(), thumb.status()]).toEqual([200, 200]);
  const imageBytes = await image.body();
  const thumbBytes = await thumb.body();

  const kind = signature(imageBytes);
  expect(['webp', 'jpeg']).toContain(kind);
  expect(signature(thumbBytes)).toBe(kind);
  expect(image.headers()['content-type']).toBe(`image/${kind}`);
  expect(imageBytes.length + thumbBytes.length).toBeLessThanOrEqual(2_000_000);
  expect(metadataMarkers(imageBytes)).toEqual([]);
  expect(metadataMarkers(thumbBytes)).toEqual([]);

  const stored = await decodedSize(page, `/api/v1/media/${id}/image`);
  const small = await decodedSize(page, `/api/v1/media/${id}/thumb`);
  expect(Math.max(stored.width, stored.height)).toBeLessThanOrEqual(2000);
  expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(480);
  // Scaled, not cropped: the 4:3 shape survives.
  expect(stored.width / stored.height).toBeCloseTo(4 / 3, 2);
  expect(small.width / small.height).toBeCloseTo(4 / 3, 1);
});

test('AC-MEM-02 an unsupported file and an undecodable HEIC are refused with the reason and no request', async ({
  page,
}) => {
  await page.goto('/memories');
  const mediaRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/media'))
      mediaRequests.push(request.url());
  });
  const sheet = await openSheet(page);
  const files = [
    {
      file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('lớp mình') },
      reason: 'image.refused.unsupported',
    },
    {
      file: {
        name: 'wave.gif',
        mimeType: 'image/gif',
        buffer: Buffer.from('R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64'),
      },
      reason: 'image.refused.unsupported',
    },
    {
      file: {
        name: 'IMG_0001.heic',
        mimeType: 'image/heic',
        // A HEIC header followed by bytes no decoder can read.
        buffer: Buffer.concat([
          Buffer.from([0, 0, 0, 24]),
          Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'),
          Buffer.alloc(256, 0x5a),
        ]),
      },
      reason: 'image.refused.heic_undecodable',
    },
  ] as const;
  for (const { file, reason } of files) {
    await sheet.locator('#upload-files').setInputFiles(file);
    await expect(sheet.getByRole('status')).toHaveText(copy[reason].replace('{name}', file.name));
  }
  await axeClean(page);
  expect(mediaRequests).toEqual([]);
});
