import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { AppContext } from '../../context';
import { createD1Database } from './d1-database';
import { createR2Storage } from './r2-storage';

/** The Cloudflare bindings are named only here and in src/worker.ts (INV-4). */
export function createCloudflareContext(env: Record<string, unknown>): AppContext {
  const database = env.DB as D1Database | undefined;
  const media = env.MEDIA as R2Bucket | undefined;
  if (!database) throw new Error('missing D1 binding: DB');
  if (!media) throw new Error('missing R2 binding: MEDIA');
  return {
    database: createD1Database(database),
    storage: createR2Storage(media),
  };
}
