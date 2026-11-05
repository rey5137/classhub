import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// AC-DB-01: apply every migration from empty on better-sqlite3, then on local
// D1 in the Workers pool, and compare the two sqlite_master schemas.
const migrationsDir = 'migrations';
const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort();
if (files.length === 0) {
  console.error('test-migrations: no migration files found');
  process.exit(1);
}

/** @param {import('better-sqlite3').Database} client */
function applyMigrations(client) {
  client.pragma('foreign_keys = ON');
  for (const name of files) {
    client.exec(readFileSync(join(migrationsDir, name), 'utf8'));
  }
}

/** @param {import('better-sqlite3').Database} client */
function readSchema(client) {
  /** @type {Array<{type: string, name: string, tbl_name: string, sql: string | null}>} */
  const rows =
    /** @type {Array<{type: string, name: string, tbl_name: string, sql: string | null}>} */ (
      client
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index') ORDER BY type, name",
        )
        .all()
    );
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: String(row.sql ?? '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

function readLocalSchema() {
  const client = new Database(':memory:');
  try {
    applyMigrations(client);
    /** @type {{value?: unknown} | undefined} */
    const versionRow = /** @type {{value?: unknown} | undefined} */ (
      client.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
    );
    return { schema: readSchema(client), version: versionRow?.value };
  } finally {
    client.close();
  }
}

const { schema: localSchema, version: localVersion } = readLocalSchema();

if (localVersion !== '1') {
  console.error(
    `test-migrations: better-sqlite3 schema_version is ${String(localVersion)}, expected 1`,
  );
  process.exit(1);
}

const directory = mkdtempSync(join(tmpdir(), 'classhub-migrations-'));
const expectedFile = join(directory, 'local.json');
writeFileSync(expectedFile, JSON.stringify({ schema: localSchema, schemaVersion: localVersion }));

try {
  const result = spawnSync('npx', ['vitest', 'run', '--project', 'migrations'], {
    stdio: 'inherit',
    env: { ...process.env, CLASSHUB_SCHEMA_LOCAL: expectedFile },
  });
  if (result.error) {
    console.error(`test-migrations: cannot run the D1 check: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(
  `test-migrations: ${localSchema.length} schema objects and schema_version 1 match on better-sqlite3 and local D1`,
);
