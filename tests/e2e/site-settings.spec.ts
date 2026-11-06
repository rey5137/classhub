import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { jpegWithGps } from './images';

// R-UI-01: these tests change the shared demo site's settings through /admin, so they
// run in their own one-worker project after the others and put back what they found.

const ORIGIN = 'http://127.0.0.1:5173';
const SETTINGS = '/api/v1/admin/settings';
const routes = ['/', '/members', '/info/reunion', '/admin'];

async function readSettings(request: APIRequestContext) {
  const response = await request.get(SETTINGS);
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown> & {
    theme: string;
    features: Record<string, boolean>;
  };
}

async function restore(request: APIRequestContext, settings: Record<string, unknown>) {
  const response = await request.patch(SETTINGS, {
    headers: { origin: ORIGIN },
    data: settings,
  });
  expect(response.status()).toBe(200);
}

/** The page as structure and text: no scripts or nonces, and <html>'s theme attributes are outside <body>. */
async function snapshot(page: Page) {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    // The settings form shows which theme is picked: that is the setting itself, not the page.
    body.querySelectorAll('script, form[action="?/settings"]').forEach((node) => node.remove());
    return body.outerHTML.replace(/\snonce="[^"]*"/g, '');
  });
}

async function look(page: Page) {
  return page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    colours: [
      getComputedStyle(document.documentElement).backgroundColor,
      getComputedStyle(document.querySelector('h1')!).color,
    ].join(' '),
  }));
}

async function saveFromAdmin(page: Page, change: (page: Page) => Promise<void>) {
  await page.goto('/admin');
  // The layout marks the locale once hydrated; a click before that would be undone.
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  await change(page);
  await page.getByRole('button', { name: 'Lưu cài đặt' }).click();
  await expect(page.getByText('Đã lưu cài đặt.')).toBeVisible();
}

test('AC-UI-01 switching the theme from /admin changes every screen’s look and no content or markup', async ({
  page,
}) => {
  const original = await readSettings(page.request);
  try {
    if (original.theme !== 'yearbook') await restore(page.request, { theme: 'yearbook' });
    const before = new Map<string, { dom: string; look: Awaited<ReturnType<typeof look>> }>();
    for (const route of routes) {
      await page.goto(route);
      before.set(route, { dom: await snapshot(page), look: await look(page) });
    }

    await saveFromAdmin(page, (admin) =>
      admin.locator('input[name="theme"][value="minimal"]').check(),
    );
    // The response to the save is already in the new theme (R-UI-08, no flash).
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'minimal');

    for (const route of routes) {
      await page.goto(route);
      const after = { dom: await snapshot(page), look: await look(page) };
      const was = before.get(route)!;
      expect(after.look.theme, route).toBe('minimal');
      expect(was.look.theme, route).toBe('yearbook');
      expect(after.look.colours, route).not.toBe(was.look.colours);
      expect(after.dom, route).toBe(was.dom);
    }
  } finally {
    await restore(page.request, original);
  }
});

test('AC-NAV-04 turning discussions off hides them and turning them on shows the same threads', async ({
  page,
}) => {
  const original = await readSettings(page.request);
  const threads = async () => {
    const response = await page.request.get('/api/v1/posts');
    return { status: response.status(), body: await response.json() };
  };
  const nav = (target: Page) =>
    target
      .getByRole('navigation', { name: 'Khu vực' })
      .first()
      .getByRole('link', { name: 'Thảo luận' });
  try {
    const before = await threads();
    expect(before.status).toBe(200);

    await saveFromAdmin(page, (admin) => admin.locator('input[name="discussions"]').uncheck());
    await page.goto('/');
    await expect(nav(page)).toHaveCount(0);
    expect((await page.goto('/discussions'))?.status()).toBe(404);
    const off = await threads();
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('feature_disabled');
    // A crafted data request gets the load's own 404 node error and no thread data.
    const seeded = before.body.items[0] as { id: string; title: string };
    for (const path of ['/discussions', `/discussions/${seeded.id}`]) {
      const data = await page.request.get(`${path}/__data.json?x-sveltekit-invalidated=01`);
      const text = await data.text();
      expect(text, path).not.toContain(seeded.title);
      expect(text, path).toContain('"status":404');
    }

    await saveFromAdmin(page, (admin) => admin.locator('input[name="discussions"]').check());
    await page.goto('/');
    await expect(nav(page)).toHaveCount(1);
    expect((await page.goto('/discussions'))?.status()).toBe(200);
    expect(await threads()).toEqual(before);

    // R-NAV-02: a board already open when discussions go off. The click is a client
    // navigation, which asks for `__data.json` and must get the 404 page, not the thread.
    await page.goto('/discussions');
    await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
    const thread = page.locator('main a[href^="/discussions/"]:not([href*="?"])').first();
    await expect(thread).toBeVisible();
    await restore(page.request, { features: { discussions: false } });
    await thread.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('404');
  } finally {
    await restore(page.request, original);
  }
});

test('R-UI-01 a logo uploads through the upload sheet, shows to members and is removed again', async ({
  page,
}) => {
  const original = await readSettings(page.request);
  try {
    await page.goto('/admin');
    await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
    await page.getByRole('button', { name: 'Tải lên: Logo' }).click();
    const sheet = page.getByRole('dialog');
    const image = await jpegWithGps(page, 640, 640);
    await sheet
      .locator('#upload-files')
      .setInputFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: image });
    // A site picture has no caption, album or year.
    await expect(sheet.locator('#upload-caption')).toHaveCount(0);
    await sheet.locator('#upload-submit').click();
    await expect(sheet).toBeHidden();

    await expect.poll(async () => (await readSettings(page.request)).logoMediaId).not.toBeNull();
    const { logoMediaId } = await readSettings(page.request);
    await page.goto('/');
    await expect(page.locator('header img.logo')).toHaveAttribute(
      'src',
      `/api/v1/media/${logoMediaId}/image`,
    );
    expect((await page.request.get(`/api/v1/media/${logoMediaId}/image`)).status()).toBe(200);

    // Removing it works without JavaScript and retires the picture.
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Gỡ: Logo' }).click();
    await expect(page.getByText('Đã lưu cài đặt.')).toBeVisible();
    expect((await readSettings(page.request)).logoMediaId).toBeNull();
    expect((await page.request.get(`/api/v1/media/${logoMediaId}/image`)).status()).toBe(404);
  } finally {
    await restore(page.request, original);
  }
});

test('R-UI-01 each theme option previews its own page, card, heading face and accent', async ({
  page,
}) => {
  await page.goto('/admin');
  const previews = await page.locator('.swatch').evaluateAll((swatches) =>
    swatches.map((swatch) => {
      const style = (selector: string) => getComputedStyle(swatch.querySelector(selector)!);
      return {
        theme: (swatch as HTMLElement).dataset.theme,
        look: [
          getComputedStyle(swatch).backgroundColor,
          style('.sample').backgroundColor,
          style('.sample b').fontFamily,
          style('.sample i').backgroundColor,
        ].join(' | '),
        // A round dot read as a second radio button (review 3b1 #7).
        round: [...swatch.querySelectorAll('*')].some((node) =>
          getComputedStyle(node).borderRadius.includes('50%'),
        ),
      };
    }),
  );
  expect(previews.map((preview) => preview.theme)).toEqual(['yearbook', 'minimal', 'night']);
  expect(new Set(previews.map((preview) => preview.look)).size).toBe(3);
  expect(previews.some((preview) => preview.round)).toBe(false);
});

test('R-UI-01 a refused mode, density or language is shown beside its field and named by it', async ({
  page,
}) => {
  await page.goto('/admin');
  await expect(page.locator('html')).toHaveAttribute('data-locale', 'vi');
  // Values no browser offers: the server refuses them, nothing is saved.
  await page.evaluate(() => {
    for (const name of ['mode', 'density'])
      (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement).value = 'bogus';
    document.querySelector('#settings-locale option:checked')!.setAttribute('value', 'xx');
  });
  await page.getByRole('button', { name: 'Lưu cài đặt' }).click();
  for (const [field, owner] of [
    ['mode', 'fieldset:has(input[name="mode"])'],
    ['density', 'fieldset:has(input[name="density"])'],
    ['locale', '#settings-locale'],
  ] as const) {
    await expect(page.locator(`#settings-${field}-error`)).toBeVisible();
    await expect(page.locator(owner)).toHaveAttribute(
      'aria-describedby',
      new RegExp(`\\bsettings-${field}-error\\b`),
    );
  }
});
