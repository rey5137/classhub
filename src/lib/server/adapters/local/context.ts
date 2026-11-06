import type { AppContext } from '../../context';
import { offlineTurnstile } from '../../services/turnstile';
import { createDevIdentity } from './dev-identity';
import { FsObjectStorage } from './fs-storage';
import { createLocalPushTransport } from './push-transport';
import { createLocalHub } from './realtime-hub';
import { createLocalDatabase } from './sqlite-database';

const DEV_VAPID_PUBLIC_KEY =
  'BJjF8bAcLaDkgAeFdGacHPSlDDvEqiVDt3ZNM363neh_cfeMCbcsUXiS4ckrW2k5zRagEDcABMIyQbKFrf8LmfI';
const DEV_VAPID_PRIVATE_KEY =
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBKa8W3JdFqOmcfGOYAy9JaRqsmhhXV3L7rV6DAsztcGhRANCAASYxfGwHC2g5IAHhXRmnBz0pQw7xKolQ7d2TTN-t53of3H3jAm3LFF4kuHJK1tpOc0WoBA3AATCMkGyha3_C5ny';

export interface LocalContextOptions {
  dbFile?: string;
  objectsDir?: string;
  migrationsDir?: string;
  devMember?: string;
  /** Unset: Cloudflare's always-pass test keys, answered offline (R-AUTH-27). */
  turnstileSiteKey?: string;
  turnstileSecret?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
}

export function createLocalContext(options: LocalContextOptions = {}): AppContext {
  const database = createLocalDatabase(options.dbFile ?? 'data/dev.sqlite', {
    migrationsDir: options.migrationsDir ?? 'migrations',
  });
  const push = createLocalPushTransport();
  const vapidPublicKey = (
    options.vapidPublicKey ??
    process.env.VAPID_PUBLIC_KEY ??
    DEV_VAPID_PUBLIC_KEY
  ).trim();
  const vapidPrivateKey = (
    options.vapidPrivateKey ??
    process.env.VAPID_PRIVATE_KEY ??
    DEV_VAPID_PRIVATE_KEY
  ).trim();
  const vapid =
    vapidPublicKey && vapidPrivateKey
      ? { publicKey: vapidPublicKey, privateKey: vapidPrivateKey }
      : undefined;
  return {
    database,
    storage: new FsObjectStorage(options.objectsDir ?? 'data/objects'),
    identity: createDevIdentity(options.devMember),
    // The dev identity stands in for Access on loopback (R-PLAT-10).
    accessConfigured: true,
    realtime: createLocalHub({ database, push, vapid }),
    push,
    ...(vapid ? { vapid } : {}),
    turnstile: offlineTurnstile({
      siteKey: options.turnstileSiteKey,
      secret: options.turnstileSecret,
    }),
  };
}
