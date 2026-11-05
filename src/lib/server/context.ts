import { createCloudflareContext } from './adapters/cloudflare/context';
import type { Database } from './ports/database';
import type { IdentityProvider } from './ports/identity';
import type { ObjectStorage } from './ports/object-storage';

export interface AppContext {
  database: Database;
  storage: ObjectStorage;
  /** Present in local/dev; the Access verifier arrives with the identity phase. */
  identity?: IdentityProvider;
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
 * Cloudflare bindings; a dev build without a binding uses the local adapters.
 * The context is memoised so one process keeps one SQLite connection.
 */
export async function createContext(platform: App.Platform | undefined): Promise<AppContext> {
  const env = platform?.env;
  if (env?.DB) return createCloudflareContext(env);
  if (import.meta.env.DEV) return getLocalContext();

  throw new Error('Class Hub: no platform database binding and local adapters are disabled');
}
