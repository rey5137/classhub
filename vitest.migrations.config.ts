import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('migrations');
// test-migrations.mjs applies the same files on better-sqlite3 and passes that
// normalised schema in; without it the D1 test refuses to pass.
const expected = process.env.CLASSHUB_SCHEMA_LOCAL
  ? readFileSync(process.env.CLASSHUB_SCHEMA_LOCAL, 'utf8')
  : '';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './tests/fixtures/pool-worker.ts',
      miniflare: {
        compatibilityDate: '2025-01-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        bindings: { TEST_MIGRATIONS: migrations, EXPECTED_SCHEMA: expected },
      },
    }),
  ],
  test: {
    name: 'migrations',
    include: ['tests/migrations/**/*.test.ts'],
  },
});
