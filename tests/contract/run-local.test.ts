import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';
import { databaseContract, type DatabaseHarness } from './database';
import { objectStorageContract, type ObjectStorageHarness } from './object-storage';

databaseContract('better-sqlite3', async (): Promise<DatabaseHarness> => {
  const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
  return {
    database,
    dispose: async () => {
      database.close();
    },
  };
});

objectStorageContract('filesystem', async (): Promise<ObjectStorageHarness> => {
  const directory = mkdtempSync(join(tmpdir(), 'classhub-objects-'));
  return {
    storage: new FsObjectStorage(directory, 2),
    dispose: async () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
});
