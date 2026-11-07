import type { D1Database, DurableObjectNamespace, R2Bucket } from '@cloudflare/workers-types';
import type { AppContext } from '../../context';
import { logLine } from '../../log';
import { AccessIdentityProvider } from './access-identity';
import { createD1Database } from './d1-database';
import { createGmailMailer } from './gmail-mailer';
import { resolvePushTransport, type PushServiceBinding } from './push-transport';
import { createR2Storage } from './r2-storage';
import { createDurableObjectHub } from './realtime-hub';
import type { ChatRoom } from './chat-room';
import { siteverifyTurnstile } from '../../services/turnstile';

function stringVar(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

let loggedMissingVapid = false;

/** The Cloudflare bindings are named only here and in src/worker.ts (INV-4). */
export function createCloudflareContext(env: Record<string, unknown>): AppContext {
  const database = env.DB as D1Database | undefined;
  const media = env.MEDIA as R2Bucket | undefined;
  if (!database) throw new Error('missing D1 binding: DB');
  if (!media) throw new Error('missing R2 binding: MEDIA');
  const teamDomain = stringVar(env.ACCESS_TEAM_DOMAIN);
  const audience = stringVar(env.ACCESS_AUD);
  const turnstileSiteKey = stringVar(env.TURNSTILE_SITE_KEY)?.trim();
  const turnstileSecret = stringVar(env.TURNSTILE_SECRET_KEY)?.trim();
  const vapidPublicKey = stringVar(env.VAPID_PUBLIC_KEY)?.trim();
  const vapidPrivateKey = stringVar(env.VAPID_PRIVATE_KEY)?.trim();
  const gmailUser = stringVar(env.GMAIL_USER)?.trim();
  // Google shows app passwords in groups of four; the spaces are not part of it.
  const gmailPassword = stringVar(env.GMAIL_APP_PASSWORD)?.replace(/\s+/g, '');
  const hasVapid = Boolean(vapidPublicKey && vapidPrivateKey);
  if (!hasVapid && !import.meta.env.DEV && !loggedMissingVapid) {
    loggedMissingVapid = true;
    // R-NTF-01: log one config warning without any value when VAPID keys are absent in production.
    logLine({ config: 'vapid_unavailable' });
  }
  const pushTransport = resolvePushTransport(
    env.PUSH as PushServiceBinding | undefined,
    import.meta.env.DEV,
  );
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
    ...(pushTransport ? { push: pushTransport } : {}),
    ...(hasVapid && vapidPublicKey && vapidPrivateKey
      ? { vapid: { publicKey: vapidPublicKey, privateKey: vapidPrivateKey } }
      : {}),
    logHashSalt: stringVar(env.LOG_HASH_SALT),
    // R-AUTH-27: the site key is a var, the secret a Worker secret; both or no /join submission passes.
    ...(turnstileSiteKey && turnstileSecret
      ? { turnstile: siteverifyTurnstile({ siteKey: turnstileSiteKey, secret: turnstileSecret }) }
      : {}),
    // R-AUTH-31: both Worker secrets, or no invite email.
    ...(gmailUser && gmailPassword
      ? { mailer: createGmailMailer({ user: gmailUser, appPassword: gmailPassword }) }
      : {}),
  };
}
