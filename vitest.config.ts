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
