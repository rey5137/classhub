import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** A Vitest project on the Workers pool: real D1, R2 and the ChatRoom Durable Object. */
export async function workersProject(name: string, include: string[]) {
  const migrations = await readD1Migrations('migrations');
  return defineConfig({
    // Route modules import `$lib/…` as SvelteKit resolves it.
    resolve: { alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) } },
    plugins: [
      cloudflareTest({
        main: './tests/fixtures/pool-worker.ts',
        miniflare: {
          compatibilityDate: '2025-01-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['MEDIA'],
          durableObjects: { CHAT_ROOM: 'ChatRoom' },
          // R-CHAT-04: the Worker and the room share this secret, as `setup` creates it in production.
          bindings: {
            TEST_MIGRATIONS: migrations,
            INTERNAL_CONTEXT_KEY: 'test-internal-context-key',
          },
        },
      }),
    ],
    test: { name, include },
  });
}
