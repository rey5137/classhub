import type { D1Database, DurableObjectNamespace, R2Bucket } from '@cloudflare/workers-types';
import type { AppContext } from '../../context';
import { AccessIdentityProvider } from './access-identity';
import { createD1Database } from './d1-database';
import { createR2Storage } from './r2-storage';
import { createDurableObjectHub } from './realtime-hub';
import type { ChatRoom } from './chat-room';

function stringVar(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The Cloudflare bindings are named only here and in src/worker.ts (INV-4). */
export function createCloudflareContext(env: Record<string, unknown>): AppContext {
  const database = env.DB as D1Database | undefined;
  const media = env.MEDIA as R2Bucket | undefined;
  if (!database) throw new Error('missing D1 binding: DB');
  if (!media) throw new Error('missing R2 binding: MEDIA');
  const teamDomain = stringVar(env.ACCESS_TEAM_DOMAIN);
  const audience = stringVar(env.ACCESS_AUD);
  return {
    database: createD1Database(database),
    storage: createR2Storage(media),
    // R-AUTH-05: account-specific vars, written into wrangler.jsonc by setup; missing means nobody is verified.
    identity: new AccessIdentityProvider({ teamDomain, audience }),
    accessConfigured: Boolean(teamDomain?.trim() && audience?.trim()),
    realtime: createDurableObjectHub(
      env.CHAT_ROOM as DurableObjectNamespace<ChatRoom> | undefined,
      stringVar(env.INTERNAL_CONTEXT_KEY),
    ),
    logHashSalt: stringVar(env.LOG_HASH_SALT),
  };
}
