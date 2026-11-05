import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as schema from '../../db/schema';
import {
  normalizeBatchResults,
  type BatchResult,
  type Database as DatabasePort,
  type DatabaseBatch,
} from '../../ports/database';

export interface LocalDatabase extends DatabasePort {
  close(): void;
}

interface MigrationOptions {
  /** Directory of numbered `*.sql` files; each unapplied file runs once, in order. */
  migrationsDir?: string;
}

export function createLocalDatabase(file: string, options: MigrationOptions = {}): LocalDatabase {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  const client = new BetterSqlite3(file);
  // R-DB-03: the local adapter turns foreign keys on; D1 enforces them itself.
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');

  if (options.migrationsDir) applyMigrations(client, options.migrationsDir);

  const db = drizzle(client, { schema });

  return {
    db,
    async batch<T extends DatabaseBatch>(queries: T): Promise<BatchResult[]> {
      // better-sqlite3 has no batch API and no async driver. Each builder is
      // executed synchronously inside one `client.transaction`, so no other
      // request can interleave a `BEGIN` mid-batch (R-DB-08).
      const run = client.transaction(() => queries.map(executeSync));
      return normalizeBatchResults(run());
    },
    close() {
      client.close();
    },
  };
}

/** better-sqlite3 has no async driver: run each builder's prepared query inline. */
function executeSync(query: unknown): unknown {
  const prepared = (
    query as {
      _prepare(): {
        executeMethod: 'run' | 'all' | 'get' | 'values';
        run(): unknown;
        all(): unknown;
        get(): unknown;
        values(): unknown;
      };
    }
  )._prepare();
  switch (prepared.executeMethod) {
    case 'all':
      return prepared.all();
    case 'get':
      return prepared.get();
    case 'values':
      return prepared.values();
    default:
      return prepared.run();
  }
}

function migrationVersion(name: string): number {
  const match = /^(\d+)/.exec(name);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function applyMigrations(client: BetterSqlite3.Database, directory: string): void {
  // R-DB-10: the local adapter tracks each filename, so a new migration runs on
  // the next start instead of only when the database is empty.
  client.exec(
    'CREATE TABLE IF NOT EXISTS `_local_migrations` (`name` text PRIMARY KEY NOT NULL, `applied_at` integer NOT NULL)',
  );
  const applied = new Set(
    (client.prepare('SELECT name FROM `_local_migrations`').all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  // Adopt a database created before tracking existed: everything at or below
  // its recorded schema_version is already applied.
  const schemaMeta = client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  let currentVersion = 0;
  if (schemaMeta) {
    const row = client
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value?: string } | undefined;
    currentVersion = Number(row?.value ?? 0);
  }

  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const record = client.prepare(
    'INSERT OR IGNORE INTO `_local_migrations` (`name`, `applied_at`) VALUES (?, ?)',
  );

  for (const name of files) {
    if (applied.has(name)) continue;
    if (schemaMeta && migrationVersion(name) <= currentVersion) {
      record.run(name, Date.now());
      continue;
    }

    const apply = client.transaction(() => {
      client.exec(readFileSync(join(directory, name), 'utf8'));
      record.run(name, Date.now());
    });
    apply();
  }
}
