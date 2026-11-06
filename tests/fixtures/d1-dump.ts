import type Database from 'better-sqlite3';

// The text `wrangler d1 export` produces, after miniflare's and D1's dumpSql: the header
// pragma, each table (`CREATE TABLE IF NOT EXISTS` for a quoted name) with its rows as
// `INSERT INTO … VALUES(…)`, newlines through replace(…, char(10)), then indexes, triggers
// and views. Tests load it to prove the verify-backup allowlist accepts a real export shape.

const escapeId = (name: string) => `"${name.replaceAll('"', '""')}"`;

function cell(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  let lf = false;
  let cr = false;
  let out = `'${String(value).replace(/'|(\n)|(\r)/g, (_, n, r) => {
    if (n) lf = true;
    if (r) cr = true;
    return n ? '\\n' : r ? '\\r' : "''";
  })}'`;
  if (cr) out = `replace(${out},'\\r',char(13))`;
  if (lf) out = `replace(${out},'\\n',char(10))`;
  return out;
}

export function dumpLikeD1(db: Database.Database): string {
  const lines = ['PRAGMA defer_foreign_keys=TRUE;'];
  const tables = db
    .prepare(
      "select name, sql from sqlite_schema where type = 'table' and sql not null order by tbl_name = 'sqlite_sequence', rowid",
    )
    .all() as { name: string; sql: string }[];
  for (const { name, sql } of tables) {
    if (name === 'sqlite_sequence') {
      lines.push('DELETE FROM sqlite_sequence;');
    } else {
      if (name.startsWith('_cf_') || name.startsWith('sqlite_')) continue;
      lines.push(
        /^CREATE TABLE ['"`]/.test(sql)
          ? `CREATE TABLE IF NOT EXISTS ${sql.substring(13)};`
          : `${sql};`,
      );
    }
    const columns = (
      db.prepare(`pragma table_info=${escapeId(name)}`).all() as { name: string }[]
    ).map((column) => escapeId(column.name));
    const rows = db
      .prepare(`select ${columns.join(', ')} from ${escapeId(name)}`)
      .raw()
      .all() as unknown[][];
    for (const row of rows)
      lines.push(
        `INSERT INTO ${escapeId(name)} (${columns.join(',')}) VALUES(${row.map(cell).join(',')});`,
      );
  }
  const rest = db
    .prepare(
      "select sql from sqlite_schema where sql not null and type in ('index', 'trigger', 'view') order by type collate nocase",
    )
    .pluck()
    .all() as string[];
  for (const sql of rest) lines.push(`${sql};`);
  return `${lines.join('\n')}\n`;
}
