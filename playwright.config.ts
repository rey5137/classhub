import { defineConfig } from '@playwright/test';

// R-PLAT-11: e2e runs against dev:offline (local adapters), so no build step is needed.
export default defineConfig({
  testDir: 'tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: {
    command: 'npm run dev:offline',
    url: 'http://127.0.0.1:5173/health',
    reuseExistingServer: !process.env.CI,
  },
});
