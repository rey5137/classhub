// Renders the install icons in static/icons/ from static/favicon.svg with Playwright's Chromium
// (R-NAV-07). A forker who changes favicon.svg runs `node scripts/render-icons.mjs` and commits
// the PNGs, or drops their own PNGs of the same names and sizes into static/icons/.
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../static/', import.meta.url);
const svg = readFileSync(new URL('favicon.svg', root), 'utf8');
const out = new URL('icons/', root);
mkdirSync(out, { recursive: true });

// `scale` < 1 keeps the mark inside the maskable safe zone (the inner 80%); the page behind it
// is the favicon's own background colour so the mask never shows transparency.
const icons = [
  { file: 'icon-192.png', size: 192, scale: 1 },
  { file: 'icon-512.png', size: 512, scale: 1 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.7, fill: '#f0f9fd' },
  { file: 'apple-touch-icon.png', size: 180, scale: 1, fill: '#f0f9fd' },
];

const browser = await chromium.launch();
try {
  for (const { file, size, scale, fill } of icons) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const inner = Math.round(size * scale);
    const markup = `<body style="margin:0;background:${fill ?? 'transparent'};display:grid;place-items:center;width:${size}px;height:${size}px"><div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body>`;
    await page.setContent(markup);
    await page.screenshot({ path: new URL(file, out).pathname, omitBackground: !fill });
    await page.close();
  }
} finally {
  await browser.close();
}
