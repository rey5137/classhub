import { expect, test } from '@playwright/test';

test('AC-UI-07 a token-only fixture theme restyles the shell without touching components', async ({
  page,
}) => {
  await page.goto('/');

  const heading = await page.locator('h1').innerText();
  const before = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      heading: getComputedStyle(document.querySelector('h1')!).color,
    };
  });

  await page.addStyleTag({ path: 'tests/fixtures/fixture-theme.css' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'fixture';
    document.documentElement.dataset.mode = 'dark';
  });

  const after = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      heading: getComputedStyle(document.querySelector('h1')!).color,
      cardRadius: getComputedStyle(document.querySelector('.reunion')!).borderRadius,
    };
  });

  expect(after.background).toBe('rgb(18, 52, 86)');
  expect(after.heading).toBe('rgb(255, 209, 102)');
  expect(after.cardRadius).toBe('14px');
  expect(after).not.toEqual(before);
  expect(await page.locator('h1').innerText()).toBe(heading);
});

test('R-UI-07 display text uses the bundled font for Latin and Vietnamese glyphs', async ({
  page,
}) => {
  await page.goto('/?theme=yearbook&mode=light');
  await page.evaluate(() => document.fonts.ready);
  const session = await page.context().newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'h1',
  });
  const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.every((font) => font.familyName === 'Patrick Hand' && font.isCustomFont)).toBe(true);
});

test('AC-NAV-01 the chat composer stays immediately above the mobile tabs and desktop edge', async ({
  page,
}) => {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/chat');
    const composer = page.locator('.composer');
    await expect(composer).toHaveCSS('position', 'fixed');
    const box = await composer.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.y + box!.height - (width === 390 ? 772 : 844))).toBeLessThanOrEqual(1);
  }
});

test('AC-NAV-01 memories shows the seeded photo wall and album filters alongside the rails', async ({
  page,
}) => {
  await page.goto('/memories');
  await expect(page.locator('.wall > li .photo img')).toHaveCount(10);
  await expect(page.locator('.filters .chip')).not.toHaveCount(0);
});

test('R-UI-06 minimal headings use the neutral theme text colour', async ({ page }) => {
  await page.goto('/?theme=minimal&mode=light');
  const colours = await page.evaluate(() => ({
    heading: getComputedStyle(document.querySelector('h1')!).color,
    body: getComputedStyle(document.body).color,
  }));
  expect(colours.heading).toBe(colours.body);
});

// Home's prototype rails (placeholder tiles, RSVP faces, the classmates rail) gave way to
// the real Home in 3b; the classmates' tints live on /members.
test('R-UI-05 avatar tints vary across classmates in every theme', async ({ page }) => {
  for (const [theme, mode] of [
    ['yearbook', 'light'],
    ['yearbook', 'dark'],
    ['minimal', 'light'],
    ['minimal', 'dark'],
    ['night', 'dark'],
  ]) {
    await page.goto(`/members?theme=${theme}&mode=${mode}`);
    const avatars = await page
      .locator('.person .avatar')
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).backgroundColor),
      );
    expect(avatars.length).toBeGreaterThanOrEqual(10);
    // The palette has ten tones: the first ten classmates each get their own.
    expect(new Set(avatars.slice(0, 10)).size).toBe(10);
  }
});

test.describe('R-UI-02 system mode', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`mode system follows prefers-color-scheme ${scheme} on the first paint`, async ({
      browser,
    }) => {
      const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto('http://127.0.0.1:5173/?theme=yearbook&mode=system');
        await expect(page.locator('html')).toHaveAttribute('data-mode', 'system');
        expect(
          await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim(),
          ),
        ).toBe(scheme === 'dark' ? '#0d1a29' : '#f0f9fd');
      } finally {
        await context.close();
      }
    });
  }

  test('night stays dark under mode system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?theme=night&mode=system');
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  });
});

test.describe('R-UI-02/04 per-mode accent override', () => {
  const accentOf = (page: import('@playwright/test').Page) =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
    );
  const q = 'accentLight=%231f4f9c&accentDark=%23ffd166';

  test('yearbook applies the light accent in light and the dark accent in dark', async ({
    page,
  }) => {
    await page.goto(`/?theme=yearbook&mode=light&${q}`);
    expect(await accentOf(page)).toBe('#1f4f9c');
    await page.goto(`/?theme=yearbook&mode=dark&${q}`);
    expect(await accentOf(page)).toBe('#ffd166');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`system mode follows a ${scheme} colour scheme without script`, async ({ browser }) => {
      const context = await browser.newContext({
        colorScheme: scheme,
        javaScriptEnabled: false,
      });
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:5173/?theme=yearbook&mode=system&${q}`);
        expect(await accentOf(page)).toBe(scheme === 'dark' ? '#ffd166' : '#1f4f9c');
      } finally {
        await context.close();
      }
    });
  }

  test('night applies its dark accent', async ({ page }) => {
    await page.goto('/?theme=night&accentDark=%23ffd166');
    expect(await accentOf(page)).toBe('#ffd166');
  });

  test('a low-contrast accent, a wrong-mode key and a CSS string are ignored', async ({ page }) => {
    for (const bad of [
      'accentDark=%23332244',
      'accentLight=%231f4f9c',
      `accentDark=${encodeURIComponent('red;background:url(x)')}`,
    ]) {
      await page.goto(`/?theme=night&${bad}`);
      expect(await accentOf(page)).toBe('#ff8a6b');
    }
  });
});
