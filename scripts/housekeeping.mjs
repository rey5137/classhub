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
import { readWorkerConfig } from './lib/worker-config.mjs';

const configSchema = z.object({
  account_id: z.string().regex(/^[0-9a-f]{32}$/),
  d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string().uuid() })),
  r2_buckets: z.array(
    z.object({ binding: z.string(), bucket_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) }),
  ),
});
const envSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string(),
  R2_HOUSEKEEPING_ACCESS_KEY_ID: z.string().min(1),
  R2_HOUSEKEEPING_SECRET_ACCESS_KEY: z.string().min(1),
});

/** @param {string} root @param {typeof runCf} [run] */
export function housekeepingDependencies(root, run = runCf) {
  const config = configSchema.parse(readWorkerConfig(root));
  const env = envSchema.parse(readEnvFile(join(root, '.env.cloudflare')));
  if (config.account_id !== env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error('Cloudflare account mismatch');
  const databaseId = config.d1_databases.find((entry) => entry.binding === 'DB')?.database_id;
  const bucket = config.r2_buckets.find((entry) => entry.binding === 'MEDIA')?.bucket_name;
  if (!databaseId || !bucket) throw new Error('Missing housekeeping bindings');
  /** @param {string[]} args @param {string} [input] */
  function guarded(args, input) {
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
      account: config.account_id,
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
