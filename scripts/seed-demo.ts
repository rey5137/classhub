import { createLocalDatabase } from '../src/lib/server/adapters/local/sqlite-database';
import { FsObjectStorage } from '../src/lib/server/adapters/local/fs-storage';
import { seedDemo } from '../src/lib/server/db/seed-demo';

const dbFile = process.env.CLASSHUB_DB ?? 'data/dev.sqlite';
const objectsDir = process.env.CLASSHUB_OBJECTS ?? 'data/objects';

const database = createLocalDatabase(dbFile, { migrationsDir: 'migrations' });
const storage = new FsObjectStorage(objectsDir);

try {
  const result = await seedDemo(database, storage);
  console.log(
    `db:seed:demo: ${result.members} demo members and ${result.invites} invites in ${dbFile}`,
  );
} finally {
  database.close();
}
