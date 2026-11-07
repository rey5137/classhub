import { createCloudflareContext } from './adapters/cloudflare/context';
import type { AccessEvaluator } from './ports/access-evaluator';
import type { Database } from './ports/database';
import type { IdentityProvider } from './ports/identity';
import type { Mailer } from './ports/mailer';
import type { ObjectStorage } from './ports/object-storage';
import type { PushTransport } from './ports/push-transport';
import type { RealtimeHub } from './ports/realtime';
import type { VapidKeys } from './push';
import type { TurnstileVerifier } from './services/turnstile';

export interface AppContext {
  database: Database;
  storage: ObjectStorage;
  /** Required (INV-1): a caller cannot skip the check by testing for its presence. */
  identity: IdentityProvider;
  /** R-AUTH-12: false while `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` is missing, which keeps the site locked. */
  accessConfigured: boolean;
  realtime: RealtimeHub;
  /** R-NTF-05: Web Push transport port; absent only in harnesses that do not exercise push. */
  push?: PushTransport;
  /** R-NTF-01: VAPID key pair; absent when `VAPID_PUBLIC_KEY` or `VAPID_PRIVATE_KEY` is unset. */
  vapid?: VapidKeys;
  /** R-AUTH-23: the `LOG_HASH_SALT` secret; unset in dev and tests (see log.ts). */
  logHashSalt?: string;
  /** R-NTF-04: the request's `ctx.waitUntil`, when the runtime offers one; push work runs under it. */
  waitUntil?: (work: Promise<unknown>) => void;
  /** R-NTF-01: the request's `https://` origin, the VAPID `sub` of web-route pushes. */
  siteOrigin?: string;
  /** R-AUTH-27: absent while the Turnstile keys are unset, and then no `/join` submission passes. */
  turnstile?: TurnstileVerifier;
  /** R-AUTH-31: absent while `GMAIL_USER`/`GMAIL_APP_PASSWORD` is unset; then no invite email is sent. */
  mailer?: Mailer;
  /** R-AUTH-33: absent while `ACCESS_EVAL_KEY` or the team domain is unset; then the evaluation paths answer 404. */
  accessEvaluator?: AccessEvaluator;
}

let localContext: Promise<AppContext> | undefined;

/** R-PLAT-10/R-AUTH-13: local adapters and the dev identity exist only in a dev build. */
function getLocalContext(): Promise<AppContext> {
  localContext ??= import('./adapters/local/context').then(({ createLocalContext }) =>
    createLocalContext({
      dbFile: process.env.CLASSHUB_DB,
      objectsDir: process.env.CLASSHUB_OBJECTS,
      devMember: process.env.CLASSHUB_DEV_MEMBER,
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY,
      turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
    }),
  );
  return localContext;
}

/**
 * R-PLAT-03: adapters are chosen once here. Production and `npm run dev` use the
 * Cloudflare bindings. `dev:offline` (CLASSHUB_OFFLINE=1) wins over a binding in a
 * dev build, because adapter-cloudflare's dev proxy supplies `env.DB` in every
 * `vite dev` (R-PLAT-10); a dev build with no binding also uses the local adapters.
 * The context is memoised so one process keeps one SQLite connection.
 */
export async function createContext(
  platform: App.Platform | undefined,
  origin?: string,
): Promise<AppContext> {
  const base = await baseContext(platform);
  const ctx = platform?.ctx as { waitUntil?: unknown } | undefined;
  const hasWaitUntil = typeof ctx?.waitUntil === 'function';
  if (!hasWaitUntil && !origin) return base;
  const waitUntil = (work: Promise<unknown>) =>
    (ctx!.waitUntil as (work: Promise<unknown>) => void).call(ctx, work);
  return {
    ...base,
    ...(hasWaitUntil ? { waitUntil } : {}),
    // The push `sub` must be https (R-NTF-01); a plain-http dev origin keeps the default.
    ...(origin?.startsWith('https://') ? { siteOrigin: origin } : {}),
  };
}

async function baseContext(platform: App.Platform | undefined): Promise<AppContext> {
  const env = platform?.env;
  if (import.meta.env.DEV && process.env.CLASSHUB_OFFLINE === '1') return getLocalContext();
  if (env?.DB) return createCloudflareContext(env);
  if (import.meta.env.DEV) return getLocalContext();

  throw new Error('Class Hub: no platform database binding and local adapters are disabled');
}
