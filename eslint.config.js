import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// AC-PLAT-02 / INV-4: Cloudflare types and bindings live only in the Cloudflare
// adapters and the Worker entry.
const cloudflareTypes = [
  'D1Database',
  'D1PreparedStatement',
  'D1Result',
  'R2Bucket',
  'R2Object',
  'R2ObjectBody',
  'DurableObjectState',
  'DurableObjectStorage',
  'DurableObjectNamespace',
  'ExecutionContext',
  'ScheduledEvent',
  'Fetcher',
  'WebSocketPair',
];

const cloudflareSyntax = cloudflareTypes.flatMap((name) => [
  {
    selector: `TSTypeReference[typeName.name='${name}']`,
    message: `INV-4: ${name} belongs in src/lib/server/adapters/cloudflare/ or src/worker.ts`,
  },
  {
    selector: `TSClassImplements[expression.name='${name}']`,
    message: `INV-4: ${name} belongs in src/lib/server/adapters/cloudflare/ or src/worker.ts`,
  },
  {
    selector: `TSInterfaceHeritage[expression.name='${name}']`,
    message: `INV-4: ${name} belongs in src/lib/server/adapters/cloudflare/ or src/worker.ts`,
  },
]);

const cloudflareImports = {
  patterns: [
    {
      group: ['cloudflare:*', '@cloudflare/workers-types'],
      message: 'INV-4: Cloudflare imports belong in adapters/cloudflare/ or src/worker.ts',
    },
  ],
};

// R-PLAT-03: services and repositories depend on ports, never adapters or a driver.
const driverImports = {
  patterns: [
    {
      group: ['**/adapters/**'],
      message: 'R-PLAT-03: services and repositories import ports, not adapters',
    },
    {
      group: ['better-sqlite3', 'drizzle-orm/d1', 'drizzle-orm/better-sqlite3'],
      message: 'R-PLAT-03: services and repositories depend on the Database port',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '.claude-out/',
      '.svelte-kit/',
      '.wrangler/',
      'build/',
      'coverage/',
      'dist/',
      'node_modules/',
      'playwright-report/',
      'test-results/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': 'allow-with-description', minimumDescriptionLength: 10 },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,svelte}'],
    ignores: ['src/lib/server/adapters/cloudflare/**', 'src/worker.ts'],
    rules: {
      'no-restricted-imports': ['error', cloudflareImports],
      'no-restricted-syntax': ['error', ...cloudflareSyntax],
    },
  },
  {
    files: [
      'src/lib/server/services/**/*.{ts,svelte}',
      'src/lib/server/repositories/**/*.{ts,svelte}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...cloudflareImports.patterns, ...driverImports.patterns],
        },
      ],
      'no-restricted-syntax': ['error', ...cloudflareSyntax],
    },
  },
  prettier,
);
