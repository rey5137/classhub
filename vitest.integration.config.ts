import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/fixtures/pool-worker.ts',
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA'],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.test.ts', 'tests/contract/run-workers.test.ts'],
  },
});
