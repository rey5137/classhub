import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { seedDemo } from '../../src/lib/server/db/seed-demo';
import { invites, users } from '../../src/lib/server/db/schema';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'classhub-seed-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('seedDemo', () => {
  it('R-PLAT-10 seeds synthetic members and invites idempotently', async () => {
    const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
    const storage = new FsObjectStorage(join(directory, 'objects'));
    try {
      await seedDemo(database, storage);
      await seedDemo(database, storage);

      const members = await database.db.select().from(users);
      const rows = await database.db.select().from(invites);

      expect(members).toHaveLength(12);
      expect(rows).toHaveLength(12);
      expect(members.filter((member) => member.role === 'admin')).toHaveLength(1);
      expect(members.every((member) => member.status === 'active')).toBe(true);
      expect(members.every((member) => member.authEmail.endsWith('@example.com'))).toBe(true);
      expect(rows.every((row) => row.email.endsWith('@example.com'))).toBe(true);
    } finally {
      database.close();
    }
  });
});
