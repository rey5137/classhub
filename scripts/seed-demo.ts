import { createLocalDatabase } from '../src/lib/server/adapters/local/sqlite-database';
import { FsObjectStorage } from '../src/lib/server/adapters/local/fs-storage';
import { seedChatVolume, seedDemo } from '../src/lib/server/db/seed-demo';

const dbFile = process.env.CLASSHUB_DB ?? 'data/dev.sqlite';
const objectsDir = process.env.CLASSHUB_OBJECTS ?? 'data/objects';

// `-- --chat-volume 31000`: slice 4c's checklist room, synthetic messages only (local).
const [flag, value] = process.argv.slice(2);
const chatVolume = flag === '--chat-volume' ? Number(value) : 0;
if (
  flag !== undefined &&
  !(Number.isInteger(chatVolume) && chatVolume > 0 && chatVolume <= 100_000)
) {
  console.error('usage: npm run db:seed:demo -- [--chat-volume <1..100000>]');
  process.exit(1);
}

const database = createLocalDatabase(dbFile, { migrationsDir: 'migrations' });
const storage = new FsObjectStorage(objectsDir);

try {
  const result = await seedDemo(database, storage);
  console.log(
    `db:seed:demo: ${result.members} demo members and ${result.invites} invites in ${dbFile}`,
  );
  if (chatVolume)
    console.log(
      `db:seed:demo: ${await seedChatVolume(database, chatVolume)} synthetic chat messages added (room target ${chatVolume})`,
    );
} finally {
  database.close();
}
