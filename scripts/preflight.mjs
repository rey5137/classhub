#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { githubRepo, report, runPreflight } from './lib/preflight.mjs';

// `npm run preflight` (R-OPS-10): exits nonzero when any item fails.

try {
  const checks = await runPreflight({
    run: runCf,
    fetch,
    root,
    env: readEnvFile(join(root, '.env.cloudflare')) ?? {},
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    repo: githubRepo(root),
  });
  process.exitCode = report(checks, (line) => console.log(line));
} catch (error) {
  console.error(`preflight: ${error instanceof Error ? error.message : 'failed'}`);
  process.exitCode = 1;
}
