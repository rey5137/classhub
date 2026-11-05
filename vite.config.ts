import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

const offline = process.env.CLASSHUB_OFFLINE === '1';

// R-PLAT-10: dev:offline opens data/dev.sqlite, applying any missing migration
// before the server starts. Normal dev keeps the Cloudflare emulation.
function offlineDatabase(): Plugin {
  return {
    name: 'classhub-offline-database',
    apply: 'serve',
    async configureServer() {
      if (!offline) return;
      const { createLocalDatabase } =
        await import('./src/lib/server/adapters/local/sqlite-database');
      const database = createLocalDatabase(process.env.CLASSHUB_DB ?? 'data/dev.sqlite', {
        migrationsDir: 'migrations',
      });
      database.close();
    },
  };
}

export default defineConfig({
  plugins: [sveltekit(), ...(offline ? [offlineDatabase()] : [])],
});
