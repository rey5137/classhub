// R-BAK-04: checks a backup snapshot directory, or an encrypted `.tar.age` decrypted into a
// private temporary directory. Shared with `backup`, which runs it on its own staging dir
// before encrypting. A list of errors, never an exit code alone, decides the result.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { scanForSecrets } from './backup-scan.mjs';

export const MANIFEST = 'manifest.json';
export const CHECKSUMS = 'checksums.sha256';
export const DATABASE = 'database.sql';
export const RESTORE_NOTES = 'RESTORE.md';
export const OBJECTS = 'objects';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative().safe();
// R-BAK-02; `liveCounts` are R-BAK-03's live COUNT(*) before the export, `portable` the
// §13.1 interchange files with their row counts, `skipped` is R-BAK-16: objects of photos
// deleted between the export and the copy.
export const manifestSchema = z
  .object({
    format: z.literal('classhub-backup'),
    formatVersion: z.literal(1),
    appVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    exportedAt: z.string().datetime(),
    database: z.object({ path: z.literal(DATABASE), sha256: hex64, bytes: count }),
    tables: z.record(z.string(), count),
    liveCounts: z.record(z.string(), count),
    portable: z.record(z.string(), count),
    objects: z.object({ count, totalBytes: count }),
    skipped: z.array(
      z.object({
        key: z.string().min(1),
        mediaId: z.string().min(1).optional(),
        reason: z.enum(['deleted-after-export', 'gone-before-copy']),
      }),
    ),
    completed: z.boolean(),
  })
  .strict();

/** @typedef {z.infer<typeof manifestSchema>} Manifest */

/** @param {string} path @returns {Promise<string>} */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => digest.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(digest.digest('hex')));
  });
}

/**
 * Every regular file under `dir`, as `/`-separated paths relative to `base`. Anything else
 * (a symlink, a device) is an error: a snapshot holds plain files only.
 * @param {string} dir @param {string} base @returns {string[]}
 */
export function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    if (!entry.isFile()) throw new Error(`not a regular file: ${relative(base, full)}`);
    return [relative(base, full).split(sep).join('/')];
  });
}

// The statement kinds a D1 export emits (miniflare's and D1's dumpSql): the header pragma,
// the sqlite_sequence reset, tables and their rows, then indexes, triggers and views. A
// `database.sql` comes from an archive anyone with the public recipient can make, so
// anything else (ATTACH, VACUUM INTO and every other statement that touches the disk) is
// refused before a single statement runs.
const EXPORT_STATEMENTS = [
  /^PRAGMA\s+(?:defer_foreign_keys|foreign_keys)\s*=\s*(?:TRUE|FALSE|ON|OFF|0|1)\s*;?$/i,
  /^(?:BEGIN(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?)\s*;?$/i,
  /^DELETE\s+FROM\s+sqlite_sequence\s*;?$/i,
  /^ANALYZE\s+sqlite_schema\s*;?$/i,
  /^CREATE\s+(?:UNIQUE\s+INDEX|INDEX|TABLE|TRIGGER|VIEW)\s/i,
  /^INSERT\s+INTO\s/i,
];

export class DumpRefusedError extends Error {}

/** The statement without leading whitespace and comments. @param {string} text */
function statementHead(text) {
  let rest = text;
  for (;;) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith('--')) {
      const end = trimmed.indexOf('\n');
      rest = end === -1 ? '' : trimmed.slice(end + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      rest = end === -1 ? '' : trimmed.slice(end + 2);
    } else return trimmed.trimEnd();
  }
}

/**
 * Splits SQL on `;` outside string literals, quoted identifiers and comments; a CREATE
 * TRIGGER runs on to its `END;`. An unterminated literal keeps the rest as one piece, which
 * SQLite then refuses as incomplete.
 * @param {string} sql @returns {string[]}
 */
export function splitStatements(sql) {
  /** @type {string[]} */
  const pieces = [];
  let start = 0;
  let index = 0;
  const skipTo = (/** @type {string} */ token, /** @type {number} */ from) => {
    const end = sql.indexOf(token, from);
    return end === -1 ? sql.length : end + token.length;
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    // A doubled quote ('') closes and reopens, so it needs no special case.
    if (char === "'" || char === '"' || char === '`') index = skipTo(char, index + 1);
    else if (char === '[') index = skipTo(']', index + 1);
    else if (char === '-' && next === '-') index = skipTo('\n', index + 2);
    else if (char === '/' && next === '*') index = skipTo('*/', index + 2);
    else if (char === ';') {
      const piece = sql.slice(start, index + 1);
      index += 1;
      if (/^CREATE\s+TRIGGER\s/i.test(statementHead(piece)) && !/\bEND\s*;$/i.test(piece)) continue;
      pieces.push(piece);
      start = index;
    } else index += 1;
  }
  if (statementHead(sql.slice(start))) pieces.push(sql.slice(start));
  return pieces;
}

/**
 * Loads the D1 SQL export (`cf.mjs d1 export`) into a fresh in-memory SQLite database. Throws
 * DumpRefusedError for a statement no export contains, before running any; throws when the
 * file does not parse fully (a dump truncated inside a statement).
 * @param {string} path
 */
export function loadDump(path) {
  const sql = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  const pieces = splitStatements(sql).filter((piece) => statementHead(piece));
  for (const piece of pieces) {
    const head = statementHead(piece);
    if (!EXPORT_STATEMENTS.some((pattern) => pattern.test(head)))
      // The keyword only: the rest may be member data.
      throw new DumpRefusedError(head.split(/\s/, 1)[0]?.slice(0, 20).toUpperCase() ?? '');
  }
  const db = new Database(':memory:');
  try {
    // Parsing is the check here; foreign keys are restore's integrity step (R-BAK-06).
    db.pragma('foreign_keys = OFF');
    // One prepare per piece: SQLite refuses a piece that is really two statements, so
    // nothing the split missed can run unchecked.
    for (const piece of pieces) {
      const statement = db.prepare(piece);
      if (statement.reader) statement.all();
      else statement.run();
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Per-table row counts, the schema version and the media rows a restore needs.
 * @param {import('better-sqlite3').Database} db
 */
export function describeDump(db) {
  const names = /** @type {{ name: string }[]} */ (
    db
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' and name not like '\\_cf\\_%' escape '\\' order by name",
      )
      .all()
  ).map((row) => row.name);
  /** @type {Record<string, number>} */
  const tables = {};
  for (const name of names) {
    const row = /** @type {{ n: number }} */ (
      db.prepare(`select count(*) as n from "${name.replaceAll('"', '""')}"`).get()
    );
    tables[name] = row.n;
  }
  const version = names.includes('schema_meta')
    ? /** @type {{ value?: string } | undefined} */ (
        db.prepare("select value from schema_meta where key = 'schema_version'").get()
      )?.value
    : undefined;
  const media = names.includes('media')
    ? /** @type {MediaRow[]} */ (
        db
          .prepare(
            'select id, object_key, thumb_key, size_bytes, thumb_size_bytes, sha256, thumb_sha256 from media where deleted_at is null order by id',
          )
          .all()
      )
    : [];
  return { tables, schemaVersion: version === undefined ? null : String(version), media };
}

// R-DB-13: the tables never hard-deleted, so a row read live before the export must be in it.
export const NEVER_HARD_DELETED = [
  'media',
  'invites',
  'chat_archives',
  'backup_runs',
  'audit_events',
];

/**
 * R-BAK-04 / AC-BAK-10: every never-hard-deleted table holds at least the rows read live before
 * the export, so a dump cut at a statement boundary fails even though it parses.
 * @param {Record<string, number>} live @param {Record<string, number>} dumped
 * @returns {string[]}
 */
export function liveCountErrors(live, dumped) {
  return NEVER_HARD_DELETED.flatMap((name) =>
    (live[name] ?? 0) > (dumped[name] ?? 0)
      ? [
          `database.sql holds ${dumped[name] ?? 0} ${name} rows, fewer than the ${live[name]} read live before the export (truncated?).`,
        ]
      : [],
  );
}

export const PORTABLE = 'portable';
// §13.1: the cross-database interchange (R-BAK-01), one NDJSON file per table plus settings.
const PORTABLE_TABLES = /** @type {const} */ ([
  ['users', 'users.ndjson'],
  ['profile_contacts', 'profile_contacts.ndjson'],
  ['invites', 'invites.ndjson'],
  ['info_pages', 'info_pages.ndjson'],
  ['posts', 'posts.ndjson'],
  ['comments', 'comments.ndjson'],
  ['albums', 'albums.ndjson'],
  ['media', 'media.ndjson'],
  ['chat_messages', 'chat-messages.ndjson'],
]);

/**
 * The `portable/` files written from the loaded dump, as path → text. Deterministic (rowid
 * order, the dump's column order), so `verify-backup` rebuilds them from database.sql and
 * compares byte for byte. A table the dump lacks has no file. Rows count per path.
 * @param {import('better-sqlite3').Database} db @param {Record<string, number>} tables
 * @returns {Map<string, { text: string; rows: number }>}
 */
export function portableFiles(db, tables) {
  /** @type {Map<string, { text: string; rows: number }>} */
  const files = new Map();
  for (const [table, file] of PORTABLE_TABLES) {
    if (!(table in tables)) continue;
    const rows = db.prepare(`select * from "${table}" order by rowid`).all();
    files.set(`${PORTABLE}/${file}`, {
      text: rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
      rows: rows.length,
    });
  }
  if ('site_settings' in tables) {
    const rows =
      /** @type {{ key: string; value_json: string; updated_by: string | null; updated_at: number }[]} */ (
        db
          .prepare('select key, value_json, updated_by, updated_at from site_settings order by key')
          .all()
      );
    // The stored JSON as JSON. The app writes only validated JSON there, so a value that does not
    // parse fails the export rather than leaving a lossy or ambiguous copy (key named, no value).
    const settings = rows.map(({ key, value_json, updated_by, updated_at }) => {
      /** @type {unknown} */
      let value;
      try {
        value = JSON.parse(value_json);
      } catch {
        throw new Error(`site_settings ${key.slice(0, 40)} is not JSON`);
      }
      return { key, value, updated_by, updated_at };
    });
    files.set(`${PORTABLE}/settings.json`, {
      text: `${JSON.stringify(settings, null, 2)}\n`,
      rows: rows.length,
    });
  }
  return files;
}

/**
 * @typedef {{
 *   id: string; object_key: string; thumb_key: string; size_bytes: number;
 *   thumb_size_bytes: number; sha256: string; thumb_sha256: string;
 * }} MediaRow
 */

/**
 * The objects each non-deleted media row needs (R-BAK-04); an avatar has no thumbnail.
 * @param {MediaRow[]} rows
 * @returns {{ key: string; mediaId: string; size: number; sha256: string }[]}
 */
export function requiredObjects(rows) {
  return rows.flatMap((row) => [
    { key: row.object_key, mediaId: row.id, size: row.size_bytes, sha256: row.sha256 },
    ...(row.thumb_key
      ? [
          {
            key: row.thumb_key,
            mediaId: row.id,
            size: row.thumb_size_bytes,
            sha256: row.thumb_sha256,
          },
        ]
      : []),
  ]);
}

/**
 * @param {string} dir a snapshot directory (manifest.json at its top)
 * @param {{ requireCompleted?: boolean; secrets?: import('./backup-scan.mjs').Secret[] }} [options]
 *   `backup` checks its own staging before it writes `completed: true`; everyone else requires
 *   it (AC-BAK-03). `secrets`: the account id and tokens no file may contain (AC-BAK-08).
 * @returns {Promise<{ errors: string[]; warnings: string[]; manifest: Manifest | null }>}
 */
export async function verifySnapshot(dir, { requireCompleted = true, secrets = [] } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Manifest | null} */
  let manifest = null;
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')));
    if (parsed.success) manifest = parsed.data;
    else errors.push('manifest.json does not match the classhub-backup format.');
  } catch {
    errors.push('manifest.json is missing or not JSON.');
  }
  if (!manifest) return { errors, warnings, manifest };
  if (requireCompleted && manifest.completed !== true)
    return {
      errors: ['manifest.json lacks completed: true; this directory is not a backup.'],
      warnings,
      manifest,
    };

  // 1. checksums.sha256 lists every other file, and every line matches.
  /** @type {string[]} */
  let files = [];
  try {
    files = listFiles(dir).filter((file) => file !== MANIFEST && file !== CHECKSUMS);
  } catch (error) {
    errors.push(/** @type {Error} */ (error).message);
  }
  /** @type {Map<string, string>} */
  const listed = new Map();
  try {
    for (const line of readFileSync(join(dir, CHECKSUMS), 'utf8').split('\n')) {
      if (!line) continue;
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      const path = match?.[2] ?? '';
      if (
        !match ||
        path.startsWith('/') ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        listed.has(path)
      ) {
        errors.push('checksums.sha256 has a malformed line.');
        break;
      }
      listed.set(path, match[1]);
    }
  } catch {
    errors.push('checksums.sha256 is missing.');
  }
  const present = new Set(files);
  for (const file of files)
    if (!listed.has(file)) errors.push(`${file} is not in checksums.sha256.`);
  /** @type {Map<string, string>} */
  const hashes = new Map();
  for (const [path, expected] of listed) {
    if (!present.has(path)) {
      errors.push(`${path} is listed in checksums.sha256 but missing.`);
      continue;
    }
    const actual = await sha256File(join(dir, path));
    hashes.set(path, actual);
    if (actual !== expected) errors.push(`checksum mismatch: ${path}.`);
  }

  // 2. database.sql: the manifest's hash and size, parses fully, row counts agree.
  const sqlPath = join(dir, DATABASE);
  let dump = null;
  /** @type {Map<string, { text: string; rows: number }> | null} */
  let portable = null;
  try {
    const bytes = lstatSync(sqlPath).size;
    const sha = hashes.get(DATABASE) ?? (await sha256File(sqlPath));
    if (sha !== manifest.database.sha256 || bytes !== manifest.database.bytes)
      errors.push('database.sql differs from the manifest (hash or size).');
    const db = loadDump(sqlPath);
    try {
      dump = describeDump(db);
      portable = portableFiles(db, dump.tables);
    } finally {
      db.close();
    }
  } catch (error) {
    errors.push(
      dump
        ? `portable/ cannot be rebuilt from database.sql (${/** @type {Error} */ (error).message}).`
        : error instanceof DumpRefusedError
          ? `database.sql holds a statement no D1 export contains (${error.message}); nothing in it was run.`
          : /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
            ? 'database.sql is missing.'
            : 'database.sql does not parse into SQLite (truncated or corrupt).',
    );
  }
  if (dump) {
    const names = new Set([...Object.keys(dump.tables), ...Object.keys(manifest.tables)]);
    for (const name of names)
      if (dump.tables[name] !== manifest.tables[name])
        errors.push(
          `row count for ${name}: database.sql has ${dump.tables[name] ?? 'no table'}, the manifest ${manifest.tables[name] ?? 'none'}.`,
        );
    if (dump.schemaVersion !== manifest.schemaVersion)
      errors.push('schema version differs between database.sql and the manifest.');
    errors.push(...liveCountErrors(manifest.liveCounts, dump.tables));
  }

  // portable/: exactly the files database.sql rebuilds, byte for byte, listed in the manifest.
  if (portable) {
    const onDisk = files.filter((file) => file.startsWith(`${PORTABLE}/`));
    const paths = new Set([...portable.keys(), ...onDisk, ...Object.keys(manifest.portable)]);
    for (const path of [...paths].sort()) {
      const expected = portable.get(path);
      if (!expected) errors.push(`${path} is not a portable export of database.sql.`);
      else if (!present.has(path)) errors.push(`${path} is missing.`);
      else if (readFileSync(join(dir, path), 'utf8') !== expected.text)
        errors.push(`${path} differs from database.sql.`);
      else if (manifest.portable[path] !== expected.rows)
        errors.push(`${path}: the manifest's row count differs.`);
    }
  }

  // AC-BAK-08: no account id or token anywhere; a provider URL only as a warning, in content.
  const scanned = [MANIFEST, ...(existsSync(join(dir, CHECKSUMS)) ? [CHECKSUMS] : []), ...files];
  /** @type {Map<string, string | null>} */
  const content = new Map([[DATABASE, null]]);
  for (const [table, file] of PORTABLE_TABLES) content.set(`${PORTABLE}/${file}`, table);
  const scan = scanForSecrets(dir, scanned, secrets, content);
  errors.push(...scan.errors);
  warnings.push(...scan.warnings);

  // 3. Objects: every non-deleted media row's objects with their recorded size and hash;
  // count and bytes equal the manifest. Objects with no row are allowed (R-BAK-04).
  const objectFiles = files.filter((file) => file.startsWith(`${OBJECTS}/`));
  let totalBytes = 0;
  for (const file of objectFiles) totalBytes += lstatSync(join(dir, file)).size;
  if (objectFiles.length !== manifest.objects.count || totalBytes !== manifest.objects.totalBytes)
    errors.push(
      `objects: ${objectFiles.length} files / ${totalBytes} bytes, the manifest says ${manifest.objects.count} / ${manifest.objects.totalBytes}.`,
    );
  const skipped = new Set(manifest.skipped.map((entry) => entry.key));
  for (const object of requiredObjects(dump?.media ?? [])) {
    const path = `${OBJECTS}/${object.key}`;
    if (skipped.has(object.key)) {
      if (present.has(path)) errors.push(`${object.key} is both copied and skipped.`);
      continue;
    }
    if (!present.has(path)) {
      errors.push(`missing object ${object.key} (media ${object.mediaId}).`);
      continue;
    }
    const size = lstatSync(join(dir, path)).size;
    const sha = hashes.get(path) ?? (await sha256File(join(dir, path)));
    if (size !== object.size || sha !== object.sha256)
      errors.push(`object ${object.key} differs from its media row (size or hash).`);
  }
  return { errors, warnings, manifest };
}

// Plaintext directories and running children a signal must not leave behind (R-BAK-05):
// Node's default signal action skips every `finally`.
/** @type {Set<() => void>} */
const cleanups = new Set();
/** @param {() => void} cleanup @returns {() => void} unregister */
export function onSignalCleanup(cleanup) {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}
/** Runs every registered cleanup, newest first (children before the directory they write). */
export function runPendingCleanups() {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup();
    } catch {
      // Keep going: the remaining cleanups matter more than one failure.
    }
  }
  cleanups.clear();
}
/** For a CLI: on SIGINT, SIGTERM or SIGHUP, clean up and exit. @param {string} command */
export function cleanUpOnSignals(command) {
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP']))
    process.once(signal, () => {
      runPendingCleanups();
      console.error(`${command}: stopped by ${signal}; temporary files removed.`);
      process.exit(128 + constants.signals[signal]);
    });
}

/**
 * Runs `first | second` with no shell, a bounded time and a minimal environment (never the
 * caller's secrets). Rejects unless both exit 0.
 * @param {string[]} first @param {string[]} second @param {number} timeoutMs
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<void>}
 */
export function pipeCommands(first, second, timeoutMs, extraEnv = {}) {
  const env = { PATH: process.env.PATH ?? '', LANG: 'C', ...extraEnv };
  return new Promise((resolve, reject) => {
    const producer = spawn(first[0], first.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    const consumer = spawn(second[0], second.slice(1), {
      env,
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: timeoutMs,
    });
    let stderr = '';
    const keep = (/** @type {Buffer} */ chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    };
    producer.stderr.on('data', keep);
    consumer.stderr.on('data', keep);
    consumer.stdin.on('error', () => {
      // EPIPE when the consumer stops early; its exit status reports the failure.
    });
    producer.stdout.pipe(consumer.stdin);
    /** @type {(number | null)[]} */
    const codes = [];
    let closed = 0;
    let failed = false;
    const fail = (/** @type {Error} */ error) => {
      if (failed) return;
      failed = true;
      producer.kill();
      consumer.kill();
      reject(error);
    };
    producer.on('error', fail);
    consumer.on('error', fail);
    const close = (/** @type {number} */ index) => (/** @type {number | null} */ code) => {
      codes[index] = code;
      closed += 1;
      if (closed === 2) unregister();
      if (closed < 2 || failed) return;
      if (codes[0] === 0 && codes[1] === 0) resolve();
      else
        fail(
          new Error(
            `${first[0]} | ${second[0]} failed (exit ${codes.join(', ')}): ${stderr.trim().split('\n').at(-1) ?? ''}`,
          ),
        );
    };
    const unregister = onSignalCleanup(() => {
      producer.kill('SIGKILL');
      consumer.kill('SIGKILL');
    });
    producer.on('close', close(0));
    consumer.on('close', close(1));
  });
}

/**
 * @typedef {{ tmpRoot?: string; secrets?: import('./backup-scan.mjs').Secret[]; decrypt?: (archive: string, identity: string, into: string) => Promise<void> }} ArchiveOptions
 * @typedef {{ errors: string[]; warnings: string[]; manifest: Manifest | null }} Verification
 */

/**
 * Decrypts `archive` with the `age` identity into a private temporary directory, verifies
 * the one snapshot inside it, and removes the directory on every path.
 * @param {string} archive @param {string} identity @param {ArchiveOptions} [options]
 * @returns {Promise<Verification>}
 */
export function verifyArchive(archive, identity, options = {}) {
  return withVerifiedArchive(archive, identity, options, async (_dir, result) => result);
}

/**
 * verifyArchive that hands the snapshot directory to `use` while it still exists (`dir` is
 * null when the archive did not unpack); `restore` reads it there (R-BAK-06).
 * @template T
 * @param {string} archive @param {string} identity @param {ArchiveOptions} options
 * @param {(dir: string | null, result: Verification) => Promise<T>} use
 * @returns {Promise<T>}
 */
export async function withVerifiedArchive(archive, identity, options, use) {
  const decrypt =
    options.decrypt ??
    ((/** @type {string} */ file, /** @type {string} */ key, /** @type {string} */ into) =>
      pipeCommands(
        ['age', '-d', '-i', key, file],
        ['tar', '-x', '-f', '-', '-C', into],
        30 * 60_000,
      ));
  const scratch = mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'classhub-verify-'));
  const unregister = onSignalCleanup(() => rmSync(scratch, { recursive: true, force: true }));
  try {
    try {
      await decrypt(archive, identity, scratch);
    } catch (error) {
      return await use(null, {
        errors: [`cannot decrypt and unpack the archive: ${/** @type {Error} */ (error).message}`],
        warnings: [],
        manifest: null,
      });
    }
    const entries = readdirSync(scratch, { withFileTypes: true });
    const top = entries[0];
    if (entries.length !== 1 || !top?.isDirectory() || !top.name.startsWith('classhub-backup-'))
      return await use(null, {
        errors: ['the archive does not hold one classhub-backup-* directory.'],
        warnings: [],
        manifest: null,
      });
    const dir = join(scratch, top.name);
    return await use(dir, await verifySnapshot(dir, { secrets: options.secrets }));
  } finally {
    unregister();
    rmSync(scratch, { recursive: true, force: true });
  }
}
