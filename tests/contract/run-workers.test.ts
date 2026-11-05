import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import { databaseContract, type DatabaseHarness } from './database';
import { objectStorageContract, type ObjectStorageHarness } from './object-storage';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

databaseContract('D1', async (): Promise<DatabaseHarness> => {
  return {
    database: createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]),
    dispose: async () => undefined,
  };
});

objectStorageContract('R2', async (): Promise<ObjectStorageHarness> => {
  return {
    storage: new R2ObjectStorage(
      env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
      2,
    ),
    dispose: async () => undefined,
  };
});
