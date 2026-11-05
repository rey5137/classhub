import type { AppContext } from '../../context';
import { createDevIdentity } from './dev-identity';
import { FsObjectStorage } from './fs-storage';
import { createLocalDatabase } from './sqlite-database';

export interface LocalContextOptions {
  dbFile?: string;
  objectsDir?: string;
  migrationsDir?: string;
  devMember?: string;
}

export function createLocalContext(options: LocalContextOptions = {}): AppContext {
  const database = createLocalDatabase(options.dbFile ?? 'data/dev.sqlite', {
    migrationsDir: options.migrationsDir ?? 'migrations',
  });
  return {
    database,
    storage: new FsObjectStorage(options.objectsDir ?? 'data/objects'),
    identity: createDevIdentity(options.devMember),
  };
}
