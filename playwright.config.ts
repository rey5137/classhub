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
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...channel,
  },
  webServer: {
    command: 'npm run dev:offline',
    url: 'http://127.0.0.1:5173/health',
    reuseExistingServer: !process.env.CI,
  },
});
