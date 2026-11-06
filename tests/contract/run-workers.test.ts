import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import { createDurableObjectHub } from '../../src/lib/server/adapters/cloudflare/realtime-hub';
import { seedMembership } from '../fixtures/membership';
import { databaseContract, type DatabaseHarness } from './database';
import { objectStorageContract, type ObjectStorageHarness } from './object-storage';
import { realtimeContract, type ClientSocket, type RealtimeHarness } from './realtime';

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

realtimeContract('Durable Object', async (): Promise<RealtimeHarness> => {
  const database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
  // A room of its own per test, so no socket of an earlier test is counted.
  const hub = createDurableObjectHub(
    env.CHAT_ROOM as unknown as Parameters<typeof createDurableObjectHub>[0],
    env.INTERNAL_CONTEXT_KEY,
    { roomName: crypto.randomUUID() },
  );
  return {
    hub,
    database,
    async open(member) {
      const response = await hub.connect(
        new Request('https://classhub.example.test/api/v1/chat/ws', {
          headers: { upgrade: 'websocket' },
        }),
        member,
      );
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) throw new Error(`upgrade ${response.status}`);
      socket.accept();
      return socket as unknown as ClientSocket;
    },
    dispose: async () => undefined,
  };
});
