import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface SchemaRow {
  type: string;
  name: string;
  table: string;
  sql: string;
}

const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_METADATA') AND type IN ('table', 'index') ORDER BY type, name";

describe('AC-DB-01 migrations', () => {
  it('AC-DB-01 applies from empty on local D1 and matches better-sqlite3', async () => {
    if (!env.EXPECTED_SCHEMA) {
      throw new Error('test-migrations: run this through `npm run test:migrations`');
    }
    const expected = JSON.parse(env.EXPECTED_SCHEMA) as {
      schema: SchemaRow[];
      schemaVersion: string;
    };

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const { results } = await env.DB.prepare(SCHEMA_SQL).all<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>();
    const schema = results.map(
      (row: { type: string; name: string; tbl_name: string; sql: string | null }) => ({
        type: row.type,
        name: row.name,
        table: row.tbl_name,
        sql: String(row.sql ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
      }),
    );

    expect(schema).toEqual(expected.schema);

    const version = await env.DB.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    expect(version?.value).toBe(expected.schemaVersion);

    expect(version?.value).toBe('1');
  });
});
