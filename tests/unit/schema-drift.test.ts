import Database from 'better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as schema from '../../src/lib/server/db/schema';

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

interface IndexListRow {
  name: string;
  unique: number;
}

interface IndexInfoRow {
  seqno: number;
  name: string | null;
  desc: number;
  key: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
}

interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  primary: boolean;
  default: string | null;
}

interface ExpectedIndex {
  name: string;
  unique: boolean;
  columns: { name: string | null; desc: boolean }[];
}

interface ExpectedForeignKey {
  table: string;
  from: string[];
  to: string[];
  onDelete: string;
  onUpdate: string;
}

interface ExpectedTable {
  name: string;
  columns: ExpectedColumn[];
  indexes: ExpectedIndex[];
  foreignKeys: ExpectedForeignKey[];
  checks: { name: string; expression: string }[];
}

const MIGRATIONS = readdirSync('migrations')
  .filter((name) => name.endsWith('.sql'))
  .sort();

/** `sql` stands in for 0001_init.sql; the later migrations still apply on top of it. */
function applyMigrations(client: Database.Database, sql?: string): void {
  for (const [index, name] of MIGRATIONS.entries()) {
    client.exec(
      index === 0 && sql !== undefined ? sql : readFileSync(join('migrations', name), 'utf8'),
    );
  }
}

function migratedClient(sql?: string): Database.Database {
  const client = new Database(':memory:');
  applyMigrations(client, sql);
  return client;
}

/** Trailing SQL text of a Drizzle expression, e.g. ` desc` for a DESC index. */
function sqlText(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object') {
        const named = chunk as { name?: unknown; value?: unknown };
        if (typeof named.name === 'string') return named.name;
        if (Array.isArray(named.value)) return named.value.join('');
      }
      return String(chunk);
    })
    .join('');
}

function indexColumn(column: unknown): { name: string | null; desc: boolean } {
  if (typeof column === 'string') return { name: column, desc: false };
  const candidate = column as { name?: unknown; queryChunks?: unknown[] };
  if (typeof candidate.name === 'string') return { name: candidate.name, desc: false };

  const text = sqlText(candidate).toLowerCase();
  const named = (candidate.queryChunks ?? []).find(
    (chunk): chunk is { name: string } =>
      Boolean(chunk) &&
      typeof chunk === 'object' &&
      typeof (chunk as { name?: unknown }).name === 'string',
  );
  return { name: named?.name ?? null, desc: /\bdesc\b/.test(text) };
}

function columnDefault(column: { default?: unknown }): string | null {
  if (column.default === undefined) return null;
  if (typeof column.default === 'string') return `'${column.default}'`;
  if (typeof column.default === 'boolean') return column.default ? 'true' : 'false';
  if (typeof column.default === 'number') return String(column.default);
  return null;
}

function expectedSchema(tables: SQLiteTable[] = Object.values(schema) as SQLiteTable[]) {
  return tables
    .map((table): ExpectedTable => {
      const config = getTableConfig(table);
      return {
        name: config.name,
        columns: config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType().toLowerCase(),
          notNull: column.notNull,
          primary: column.primary,
          default: columnDefault(column),
        })),
        indexes: config.indexes
          .map((index) => ({
            name: index.config.name,
            unique: Boolean(index.config.unique),
            columns: index.config.columns.map(indexColumn),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
        foreignKeys: config.foreignKeys
          .map((foreignKey) => {
            const reference = foreignKey.reference();
            return {
              table: getTableConfig(reference.foreignTable as SQLiteTable).name,
              from: reference.columns.map((column) => column.name),
              to: reference.foreignColumns.map((column) => column.name),
              onDelete: (foreignKey.onDelete ?? 'no action').toLowerCase(),
              onUpdate: (foreignKey.onUpdate ?? 'no action').toLowerCase(),
            };
          })
          .sort((left, right) => left.from.join().localeCompare(right.from.join())),
        checks: config.checks
          .map((check) => ({
            name: check.name,
            expression: normalizeExpression(sqlText(check.value)),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeExpression(expression: string): string {
  return expression
    .replace(/"/g, '')
    .replace(/\b[a-z_][\w]*\./gi, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function actualSchema(client: Database.Database): ExpectedTable[] {
  const names = client
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' AND name <> '_local_migrations' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);

  return names.map((name): ExpectedTable => {
    const tableSql = (
      client
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { sql: string } | undefined
    )?.sql;

    const columns = (client.prepare(`PRAGMA table_info('${name}')`).all() as TableInfoRow[]).map(
      (column) => ({
        name: column.name,
        type: column.type.toLowerCase(),
        notNull: column.notnull === 1,
        primary: column.pk > 0,
        default: column.dflt_value === null ? null : column.dflt_value.trim(),
      }),
    );

    const indexes = (client.prepare(`PRAGMA index_list('${name}')`).all() as IndexListRow[])
      .filter((index) => !index.name.startsWith('sqlite_autoindex_'))
      .map((index) => ({
        name: index.name,
        unique: index.unique === 1,
        columns: (client.prepare(`PRAGMA index_xinfo('${index.name}')`).all() as IndexInfoRow[])
          .filter((column) => column.key === 1)
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => ({ name: column.name, desc: column.desc === 1 })),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const foreignKeys = groupForeignKeys(
      client.prepare(`PRAGMA foreign_key_list('${name}')`).all() as ForeignKeyRow[],
    );

    const checks = [
      ...(tableSql ?? '').matchAll(
        /CONSTRAINT\s+"?([\w]+)"?\s+CHECK\s*\(((?:[^()]|\([^)]*\))*)\)/g,
      ),
    ]
      .map((match) => ({
        name: match[1]!,
        expression: normalizeExpression(match[2]!),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    return { name, columns, indexes, foreignKeys, checks };
  });
}

function groupForeignKeys(rows: ForeignKeyRow[]): ExpectedForeignKey[] {
  const grouped = new Map<
    number,
    { table: string; from: string[]; to: string[]; onDelete: string; onUpdate: string }
  >();
  for (const row of rows) {
    const entry = grouped.get(row.id) ?? {
      table: row.table,
      from: [],
      to: [],
      onDelete: row.on_delete.toLowerCase(),
      onUpdate: row.on_update.toLowerCase(),
    };
    entry.from[row.seq] = row.from;
    entry.to[row.seq] = row.to;
    grouped.set(row.id, entry);
  }
  return [...grouped.values()]
    .map((entry) => ({ ...entry, from: entry.from.filter(Boolean), to: entry.to.filter(Boolean) }))
    .sort((left, right) => left.from.join().localeCompare(right.from.join()));
}

function diffSchema(expected: ExpectedTable[], actual: ExpectedTable[]): string[] {
  const differences: string[] = [];
  const expectedNames = expected.map((table) => table.name);
  const actualNames = actual.map((table) => table.name);
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    differences.push(`tables: expected ${expectedNames.join()}, got ${actualNames.join()}`);
    return differences;
  }

  for (const [index, expectedTable] of expected.entries()) {
    const actualTable = actual[index]!;
    const table = expectedTable.name;
    if (JSON.stringify(expectedTable.columns) !== JSON.stringify(actualTable.columns)) {
      differences.push(`columns on ${table}`);
    }
    if (JSON.stringify(expectedTable.indexes) !== JSON.stringify(actualTable.indexes)) {
      differences.push(`index on ${table}`);
    }
    if (JSON.stringify(expectedTable.foreignKeys) !== JSON.stringify(actualTable.foreignKeys)) {
      differences.push(`foreign key on ${table}`);
    }
    if (JSON.stringify(expectedTable.checks) !== JSON.stringify(actualTable.checks)) {
      differences.push(`check on ${table}`);
    }
  }
  return differences;
}

describe('AC-DB-01 schema drift', () => {
  it('AC-DB-01 the Drizzle schema and 0001_init.sql describe the same tables, columns, defaults, indexes, FKs and checks', () => {
    const client = migratedClient();
    try {
      expect(diffSchema(expectedSchema(), actualSchema(client))).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('AC-DB-01 detects a changed CHECK', () => {
    const original = readFileSync(join('migrations', '0001_init.sql'), 'utf8');
    const sql = original.replace("('photo', 'avatar', 'site')", "('photo', 'avatar')");
    expect(sql).not.toBe(original);
    const client = migratedClient(sql);
    try {
      expect(diffSchema(expectedSchema(), actualSchema(client))).toContain('check on media');
    } finally {
      client.close();
    }
  });

  it('AC-DB-01 detects a changed foreign-key action', () => {
    const sql = readFileSync(join('migrations', '0001_init.sql'), 'utf8').replace(
      'FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict',
      'FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade',
    );
    const client = migratedClient(sql);
    try {
      const differences = diffSchema(expectedSchema(), actualSchema(client));
      expect(differences.some((difference) => difference.startsWith('foreign key on'))).toBe(true);
    } finally {
      client.close();
    }
  });

  it('AC-DB-01 detects an index column order change', () => {
    const client = migratedClient();
    try {
      client.exec('DROP INDEX `posts_pinned_activity_idx`;');
      client.exec(
        'CREATE INDEX `posts_pinned_activity_idx` ON `posts` ("last_activity_at" desc,"is_pinned" desc,"id" desc);',
      );
      const differences = diffSchema(expectedSchema(), actualSchema(client));
      expect(differences).toContain('index on posts');
    } finally {
      client.close();
    }
  });
});
