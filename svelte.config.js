import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import adapterNode from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const nodeTarget = process.env.CLASSHUB_TARGET === 'node';

// The adapter writes SvelteKit's worker to the configured `main`, so builds use
// a Worker-mode template whose main is the adapter output. The deploy config
// (`wrangler.jsonc`) instead points at src/worker.ts, which re-exports ChatRoom.
const cloudflareAdapter = adapterCloudflare({ config: 'wrangler.build.jsonc' });

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: nodeTarget ? adapterNode() : cloudflareAdapter,
  },
};

export default config;
