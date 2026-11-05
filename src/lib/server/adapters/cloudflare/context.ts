import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { AppContext } from '../../context';
import { IdentityError, type IdentityProvider } from '../../ports/identity';
import { createD1Database } from './d1-database';
import { createR2Storage } from './r2-storage';

/** Until the Access verifier lands (1a) nobody is identified, so every call fails closed (INV-1). */
const unavailableIdentity: IdentityProvider = {
  async requireIdentity() {
    throw new IdentityError('identity verification is not available yet');
  },
};

/** The Cloudflare bindings are named only here and in src/worker.ts (INV-4). */
export function createCloudflareContext(env: Record<string, unknown>): AppContext {
  const database = env.DB as D1Database | undefined;
  const media = env.MEDIA as R2Bucket | undefined;
  if (!database) throw new Error('missing D1 binding: DB');
  if (!media) throw new Error('missing R2 binding: MEDIA');
  return {
    database: createD1Database(database),
    storage: createR2Storage(media),
    identity: unavailableIdentity,
  };
}
