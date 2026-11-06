import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { cspDirectives } from './src/lib/server/headers.ts';

// The adapter writes SvelteKit's worker to the configured `main`, so builds use
// a Worker-mode template whose main is the adapter output. The deploy config
// (`wrangler.jsonc`) instead points at src/worker.ts, which re-exports ChatRoom.
// dev:offline reads no binding (context.ts), so its dev proxy loads the build template too: the
// deploy config's PUSH self-binding (entrypoint PushDelivery) stops the local runtime from starting.
const cloudflareAdapter = adapterCloudflare({
  config: 'wrangler.build.jsonc',
  ...(process.env.CLASSHUB_OFFLINE === '1' && {
    platformProxy: { configPath: 'wrangler.build.jsonc' },
  }),
});

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: cloudflareAdapter,
    // R-AUTH-17: the request hook checks Origin on every mutating request, forms
    // included, so SvelteKit's own check (a plain-text 403 without the §6.7
    // headers) is off; `['*']` is the non-deprecated way to turn it off.
    csrf: { trustedOrigins: ['*'] },
    // R-AUTH-20: SvelteKit nonces its inline scripts; hooks add the rest of the headers.
    csp: {
      mode: 'nonce',
      directives: /** @type {import('@sveltejs/kit').CspDirectives} */ (
        /** @type {unknown} */ (cspDirectives)
      ),
    },
  },
};

export default config;
