import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

// Use the bundled Chromium when Playwright has installed it; fall back to the
// machine's Chrome when the pinned build is absent (development machines).
const bundledChromium = chromium.executablePath();
const channel =
  !existsSync(bundledChromium) && process.platform === 'darwin'
    ? ({ channel: 'chrome' } as const)
    : {};

// R-PLAT-11: e2e runs against dev:offline (local adapters), so no build step is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://127.0.0.1:5173' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', ...channel } },
    // Risk 4: Safari can't encode WebP and decodes differently, so the browser encoder
    // (AC-MEM-01, AC-MEM-02) and the avatar crop also run in WebKit.
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testMatch: /(memories-upload|avatar)\.spec\.ts$/,
    },
  ],
  // The dev identity lets nobody in by itself: seed the demo data and sign in as its admin.
  webServer: {
    command: 'npm run db:seed:demo && npm run dev:offline',
    env: { CLASSHUB_DEV_MEMBER: process.env.CLASSHUB_DEV_MEMBER ?? 'admin@example.com' },
    url: 'http://127.0.0.1:5173/health',
    reuseExistingServer: !process.env.CI,
  },
});
