import { createCloudflareContext } from './adapters/cloudflare/context';
import type { Database } from './ports/database';
import type { IdentityProvider } from './ports/identity';
import type { ObjectStorage } from './ports/object-storage';

export interface AppContext {
  database: Database;
  storage: ObjectStorage;
  /** Required (INV-1): a caller cannot skip the check by testing for its presence. */
  identity: IdentityProvider;
  /** R-AUTH-23: the `LOG_HASH_SALT` secret; unset in dev and tests (see log.ts). */
  logHashSalt?: string;
}

let localContext: Promise<AppContext> | undefined;

/** R-PLAT-10/R-AUTH-13: local adapters and the dev identity exist only in a dev build. */
function getLocalContext(): Promise<AppContext> {
  localContext ??= import('./adapters/local/context').then(({ createLocalContext }) =>
    createLocalContext({
      dbFile: process.env.CLASSHUB_DB,
      objectsDir: process.env.CLASSHUB_OBJECTS,
      devMember: process.env.CLASSHUB_DEV_MEMBER,
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
export async function createContext(platform: App.Platform | undefined): Promise<AppContext> {
  const env = platform?.env;
  if (import.meta.env.DEV && process.env.CLASSHUB_OFFLINE === '1') return getLocalContext();
  if (env?.DB) return createCloudflareContext(env);
  if (import.meta.env.DEV) return getLocalContext();

  throw new Error('Class Hub: no platform database binding and local adapters are disabled');
}
