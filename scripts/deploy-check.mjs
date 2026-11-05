#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { checkDeploy } from './lib/deploy-check.mjs';

// The step of `npm run deploy` after the account guard: the Access vars into
// wrangler.jsonc (R-AUTH-05) and the schema guard (R-OPS-08).

try {
  process.exitCode = await checkDeploy({
    run: runCf,
    root,
    env: readEnvFile(join(root, '.env.cloudflare')) ?? {},
    write: (path, text) => writeFileSync(path, text),
    out: (line) => console.log(line),
  });
} catch (error) {
  console.error(`deploy: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
