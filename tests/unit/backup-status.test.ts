import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLocalDatabase,
  type LocalDatabase,
} from '../../src/lib/server/adapters/local/sqlite-database';
import { backupRuns } from '../../src/lib/server/db/schema';
import { lastVerifiedBackup } from '../../src/lib/server/repositories/backups';

let database: LocalDatabase;
beforeEach(() => {
  database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
});
afterEach(() => database.close());

const run = (id: string, verifiedAt: number | null, totalBytes: number) => ({
  id,
  kind: 'full',
  manifestSha256: 'a'.repeat(64),
  objectCount: 3,
  totalBytes,
  verifiedAt,
});

describe('/admin backup status (R-BAK-09)', () => {
  it('R-BAK-09 reports no backup when none is verified', async () => {
    expect(await lastVerifiedBackup(database)).toBeNull();
    await database.db.insert(backupRuns).values(run('r0', null, 10));
    expect(await lastVerifiedBackup(database)).toBeNull();
  });

  it("R-BAK-09 shows the newest verified run's date and size", async () => {
    await database.db
      .insert(backupRuns)
      .values([
        run('r1', 1_800_000_000_000, 100),
        run('r2', 1_800_600_000_000, 250),
        run('r3', null, 999),
      ]);
    expect(await lastVerifiedBackup(database)).toEqual({
      verifiedAt: 1_800_600_000_000,
      totalBytes: 250,
      objectCount: 3,
    });
  });
});
