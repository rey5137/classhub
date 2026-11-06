import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'tests/contract/run-local.test.ts'],
          environment: 'node',
        },
      },
      {
        // AC-MEM-07 drives real route modules, which import `$lib/…` as SvelteKit resolves it.
        resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
        test: {
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/security/setup-log-capture.ts'],
        },
      },
      './vitest.integration.config.ts',
      './vitest.migrations.config.ts',
    ],
  },
});
