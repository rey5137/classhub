import { z } from 'zod';
import { readWorkerConfig } from './worker-config.mjs';

const targetsSchema = z.object({
  account_id: z.string().regex(/^[0-9a-f]{32}$/),
  d1_databases: z.array(
    z.object({
      binding: z.string(),
      database_id: z.string().uuid(),
      database_name: z.string().optional(),
    }),
  ),
  r2_buckets: z.array(
    z.object({ binding: z.string(), bucket_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/) }),
  ),
});

/**
 * The guarded D1 database and R2 bucket for the remote scripts (INV-9): wrangler.jsonc must
 * name the same account as .env.cloudflare. Makes no remote call. Throws on anything missing.
 * @param {string} root @param {string} envAccountId
 * @returns {{ account: string; databaseId: string; databaseName?: string; bucket: string }}
 */
export function guardedTargets(root, envAccountId) {
  const config = targetsSchema.parse(readWorkerConfig(root));
  if (config.account_id !== envAccountId) throw new Error('Cloudflare account mismatch');
  const bound = config.d1_databases.find((entry) => entry.binding === 'DB');
  const databaseId = bound?.database_id;
  const bucket = config.r2_buckets.find((entry) => entry.binding === 'MEDIA')?.bucket_name;
  if (!databaseId || !bucket) throw new Error('Missing DB or MEDIA binding');
  return { account: config.account_id, databaseId, databaseName: bound?.database_name, bucket };
}
