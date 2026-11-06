#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createRemoteDatabase } from '../src/lib/server/adapters/cloudflare/remote-database.ts';
import { runCf } from './lib/cf-child.mjs';
import { readEnvFile } from './lib/env-file.mjs';
import { runHousekeeping } from './lib/housekeeping.mjs';
import { createHousekeepingWrites } from './lib/housekeeping-writes.mjs';
import { createS3Client } from './lib/s3.mjs';
import { guardedTargets } from './lib/guarded-targets.mjs';

const envSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string(),
  R2_HOUSEKEEPING_ACCESS_KEY_ID: z.string().min(1),
  R2_HOUSEKEEPING_SECRET_ACCESS_KEY: z.string().min(1),
});

/** @param {string} root @param {typeof runCf} [run] */
export function housekeepingDependencies(root, run = runCf) {
  const env = envSchema.parse(readEnvFile(join(root, '.env.cloudflare')));
  const { account, databaseId, bucket } = guardedTargets(root, env.CLOUDFLARE_ACCOUNT_ID);
  /** @param {string[]} args @param {string} [input] */
  function guarded(args, input) {
    // cf.mjs takes one statement per process; a fixed pause keeps a long reconcile well under the API rate limit.
    if (args[0] === 'd1-query') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    const result = run(args, { input });
    if (result.status !== 0) throw new Error('Guarded Cloudflare request failed');
    return JSON.parse(result.stdout);
  }
  // The account/token guard must succeed before an S3 request can be made.
  guarded(['api', `/r2/buckets/${bucket}`]);
  const database = createRemoteDatabase(async (statement) =>
    guarded(['d1-query', databaseId], JSON.stringify(statement)),
  );
  const writes = createHousekeepingWrites(database);
  return {
    database,
    writes,
    repairUsage: writes.repairUsage,
    storage: createS3Client({
      account,
      bucket,
      accessKey: env.R2_HOUSEKEEPING_ACCESS_KEY_ID,
      secretKey: env.R2_HOUSEKEEPING_SECRET_ACCESS_KEY,
    }),
    out: (/** @type {string} */ line) => console.log(line),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const watchdog = setTimeout(() => {
    console.error('housekeeping: deadline exceeded');
    process.exit(1);
  }, 15 * 60_000);
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--reconcile')) {
      console.error('usage: npm run housekeeping -- [--reconcile]');
      process.exitCode = 1;
    } else {
      process.exitCode = await runHousekeeping(
        args,
        housekeepingDependencies(dirname(dirname(fileURLToPath(import.meta.url)))),
      );
    }
  } catch {
    // Driver errors can include SQL parameters; never send those to the terminal.
    console.error('housekeeping: failed (check configuration, credentials and bindings)');
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}
