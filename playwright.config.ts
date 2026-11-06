import { existsSync } from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

// Use the bundled Chromium when Playwright has installed it; fall back to the
// machine's Chrome when the pinned build is absent (development machines).
const bundledChromium = chromium.executablePath();
const channel =
  !existsSync(bundledChromium) && process.platform === 'darwin'
    ? ({ channel: 'chrome' } as const)
    : {};

const uploadSpecs = /(memories-upload|avatar|memories)\.spec\.ts$/;
// R-UI-01: these change the site's own settings (theme, feature flags), which every
// other spec sees, so they run alone after the others and restore what they change.
const settingsSpecs = /site-settings\.spec\.ts$/;
// board.spec.ts starts its own two dev servers over a scratch database (ports 5174, 5175).
const boardSpecs = /board\.spec\.ts$/;
// chat.spec.ts starts its own dev server (the local hub) over a scratch database (port 5176).
const chatSpecs = /chat\.spec\.ts$/;

// R-PLAT-11: e2e runs against dev:offline (local adapters), so no build step is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://127.0.0.1:5173' },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', ...channel },
      testIgnore: [uploadSpecs, settingsSpecs, boardSpecs, chatSpecs],
    },
    // Every worker signs in as the one demo admin, who may hold 2 open uploads (AC-MEM-01),
    // so the specs that upload run in a project limited to one worker.
    {
      name: 'chromium-uploads',
      use: { browserName: 'chromium', ...channel },
      testMatch: uploadSpecs,
      workers: 1,
    },
    {
      name: 'chromium-settings',
      use: { browserName: 'chromium', ...channel },
      testMatch: settingsSpecs,
      workers: 1,
      dependencies: ['chromium', 'chromium-uploads'],
    },
    {
      name: 'chromium-board',
      use: { browserName: 'chromium', ...channel },
      testMatch: boardSpecs,
      workers: 1,
      // A hard ceiling per test (and for beforeAll's server start), so a stuck server
      // fails the run instead of hanging it.
      timeout: 360_000,
    },
    {
      name: 'chromium-chat',
      use: { browserName: 'chromium', ...channel },
      testMatch: chatSpecs,
      workers: 1,
      // A stuck socket or server fails the run instead of hanging it.
      timeout: 120_000,
    },
    // Risk 4: Safari can't encode WebP and decodes differently, so the browser encoder
    // (AC-MEM-01, AC-MEM-02) and the avatar crop also run in WebKit.
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testMatch: /(memories-upload|avatar)\.spec\.ts$/,
      workers: 1,
      dependencies: ['chromium-uploads'],
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
