#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { uuidv7 } from './lib/ids.mjs';
import { githubRepo } from './lib/preflight.mjs';
import { runLock, runUnlock } from './lib/unlock.mjs';

// `npm run unlock` / `npm run lock` (`--lock`), R-OPS-11.

const argv = process.argv.slice(2);
if (argv.length > 1 || (argv[0] !== undefined && argv[0] !== '--lock')) {
  console.error('usage: node scripts/unlock.mjs [--lock]');
  process.exit(1);
}
const out = (/** @type {string} */ line) => console.log(line);

try {
  process.exitCode =
    argv[0] === '--lock'
      ? await runLock({ run: runCf, out, uuid: uuidv7 })
      : await runUnlock({
          run: runCf,
          fetch,
          root,
          env: readEnvFile(join(root, '.env.cloudflare')) ?? {},
          version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
          repo: githubRepo(root),
          out,
          uuid: uuidv7,
        });
} catch (error) {
  console.error(`unlock: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
