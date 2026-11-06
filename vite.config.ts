import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

const offline = process.env.CLASSHUB_OFFLINE === '1';

// R-PLAT-10: dev:offline opens data/dev.sqlite, applying any missing migration
// before the server starts, and routes chat upgrades through the app to the local
// hub (chat-upgrade.ts). Normal dev keeps the Cloudflare emulation.
function offlineDatabase(): Plugin {
  return {
    name: 'classhub-offline-database',
    apply: 'serve',
    async configureServer(server) {
      if (!offline) return;
      const { createLocalDatabase } =
        await import('./src/lib/server/adapters/local/sqlite-database');
      const database = createLocalDatabase(process.env.CLASSHUB_DB ?? 'data/dev.sqlite', {
        migrationsDir: 'migrations',
      });
      database.close();
      const { createChatUpgrade } = await import('./src/lib/server/adapters/local/chat-upgrade');
      server.httpServer?.on(
        'upgrade',
        createChatUpgrade((request, response) =>
          server.middlewares(request, response, () => {
            response.statusCode = 404;
            response.end();
          }),
        ),
      );
    },
  };
}

export default defineConfig({
  plugins: [sveltekit(), ...(offline ? [offlineDatabase()] : [])],
});
