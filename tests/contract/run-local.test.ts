import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';
import { createChatUpgrade } from '../../src/lib/server/adapters/local/chat-upgrade';
import { createLocalHub } from '../../src/lib/server/adapters/local/realtime-hub';
import type { RealtimeMember } from '../../src/lib/server/ports/realtime';
import { seedMembership } from '../fixtures/membership';
import { databaseContract, type DatabaseHarness } from './database';
import { objectStorageContract, type ObjectStorageHarness } from './object-storage';
import { realtimeContract, type ClientSocket, type RealtimeHarness } from './realtime';

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

realtimeContract('local ws', async (): Promise<RealtimeHarness> => {
  const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
  await seedMembership(database);
  const hub = createLocalHub({ database });
  // The dev server's upgrade path with the pipeline replaced by a direct `connect`:
  // the test names the member in the query, where the app would verify Access.
  const server = createServer();
  server.on(
    'upgrade',
    createChatUpgrade((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const member = JSON.parse(url.searchParams.get('member') ?? 'null') as RealtimeMember;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      void hub.connect(new Request(url, { headers }), member).then((answer) => {
        response.writeHead(answer.status);
        response.end();
      });
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    hub,
    database,
    open: (member) =>
      new Promise((resolve, reject) => {
        const query = encodeURIComponent(JSON.stringify(member));
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/chat/ws?member=${query}`);
        socket.addEventListener('open', () => resolve(socket as unknown as ClientSocket));
        socket.addEventListener('error', () => reject(new Error('upgrade refused')));
      }),
    dispose: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      database.close();
    },
  };
});
