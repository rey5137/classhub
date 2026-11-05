#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiGet, root, runCf } from './lib/cf-child.mjs';
import { runSmokeTest } from './lib/smoke-test.mjs';
import { knownHostnames, readWorkerConfig, teamHost } from './lib/worker-config.mjs';

// `npm run smoke:test [-- --host <hostname> ...]` (R-OPS-09). Without --host the
// hostnames come from wrangler.jsonc and the account's workers.dev subdomain.

const argv = process.argv.slice(2);
/** @type {string[]} */
const flagged = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] !== '--host' || !argv[index + 1]) {
    console.error('usage: npm run smoke:test [-- --host <hostname> ...]');
    process.exit(1);
  }
  flagged.push(
    String(argv[++index])
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, ''),
  );
}

try {
  const config = readWorkerConfig(root);
  if (!config) throw new Error('wrangler.jsonc does not exist; run npm run setup.');
  const hosts =
    flagged.length > 0
      ? flagged
      : knownHostnames(
          config,
          /** @type {{ subdomain?: string } | null} */ (apiGet(runCf, '/workers/subdomain'))
            ?.subdomain ?? null,
        );
  process.exitCode = await runSmokeTest({
    fetch,
    hosts,
    team: teamHost(config.vars?.ACCESS_TEAM_DOMAIN),
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    out: (line) => console.log(line),
  });
} catch (error) {
  console.error(`smoke:test: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
