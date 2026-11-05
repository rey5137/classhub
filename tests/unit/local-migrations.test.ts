import BetterSqlite3 from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';

let directory: string;
let migrationsDir: string;
let dbFile: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'classhub-local-migrations-'));
  migrationsDir = join(directory, 'migrations');
  dbFile = join(directory, 'dev.sqlite');
  mkdirSync(migrationsDir, { recursive: true });
  copyFileSync(join('migrations', '0001_init.sql'), join(migrationsDir, '0001_init.sql'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('local migrations', () => {
  it('R-DB-10 applies only migration files that have not run yet', () => {
    createLocalDatabase(dbFile, { migrationsDir }).close();

    writeFileSync(
      join(migrationsDir, '0002_probe.sql'),
      "CREATE TABLE `probe` (`id` text PRIMARY KEY NOT NULL);\nUPDATE `schema_meta` SET `value` = '2' WHERE `key` = 'schema_version';\n",
    );

    createLocalDatabase(dbFile, { migrationsDir }).close();
    createLocalDatabase(dbFile, { migrationsDir }).close();

    const client = new BetterSqlite3(dbFile);
    try {
      const tables = client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'")
        .all();
      expect(tables).toHaveLength(1);

      const version = client
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value: string };
      expect(version.value).toBe('2');

      const applied = client
        .prepare('SELECT name FROM `_local_migrations` ORDER BY name')
        .all() as { name: string }[];
      expect(applied.map((row) => row.name)).toEqual(['0001_init.sql', '0002_probe.sql']);
    } finally {
      client.close();
    }
  });
});
