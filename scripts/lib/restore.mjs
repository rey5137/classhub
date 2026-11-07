// R-BAK-06, 07: `npm run restore -- <archive|dir> --target new|local`. Side by side only
// (R-BAK-08): a new, empty D1 database and bucket named by flag, through the account guard
// (cf.mjs) and the one S3 client (s3.mjs), or `data/` for the local adapters. Order: verify,
// import the SQL (ending by emptying push_subscriptions, clearing access_sub and locking the
// site; `--target local` does not lock, R-BAK-07), copy, re-verify, read-only integrity checks.

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage.ts';
import {
  RESTORE_ACCESS_SUB_LEFT,
  RESTORE_FOREIGN_KEY_CHECK,
  RESTORE_IMPORT_GUARD,
  RESTORE_IMPORT_GUARD_DROP,
  RESTORE_IMPORT_TAIL,
  RESTORE_LOCK_SETUP,
  RESTORE_MEDIA_SELECT,
  RESTORE_SETUP_STATE_SELECT,
  RESTORE_TARGET_TABLES,
  restoreCountSelect,
} from './backup-sql.mjs';
import { d1Remote, reason } from './cf-child.mjs';
import { compareMigrations, localMigrations } from './migrations.mjs';
import {
  CHECKSUMS,
  DATABASE,
  describeDump,
  listFiles,
  loadDump,
  OBJECTS,
  onSignalCleanup,
  requiredObjects,
  sha256File,
  verifySnapshot,
  withVerifiedArchive,
} from './verify-backup.mjs';

/** A refusal or failure whose message is safe to print: names, counts and paths only. */
export class RestoreError extends Error {}

/**
 * @typedef {{
 *   list(prefix: string, cursor?: string): Promise<{ objects: { key: string; size: number }[]; cursor?: string }>;
 *   put(key: string, body: Buffer, contentType: string): Promise<void>;
 *   get(key: string, destination: string, expectedSize: number): Promise<{ size: number; sha256: string } | null>;
 * }} RestoreStorage
 * @typedef {{
 *   kind: 'new';
 *   run: import('./cf-child.mjs').CfRunner;
 *   database: string;
 *   bucket: string;
 *   live: { databaseId: string; databaseName?: string; bucket: string };
 *   storage: RestoreStorage;
 * }} NewTarget
 * @typedef {{ kind: 'local'; dbFile: string; objectsDir: string }} LocalTarget
 * @typedef {{
 *   source: string;
 *   identity?: string;
 *   target: NewTarget | LocalTarget;
 *   root: string;
 *   secrets?: import('./backup-scan.mjs').Secret[];
 *   decrypt?: import('./verify-backup.mjs').ArchiveOptions['decrypt'];
 *   tmpRoot?: string;
 *   out?: (line: string) => void;
 *   err?: (line: string) => void;
 * }} RestoreDeps
 * @typedef {{ key: string; path: string; size: number; sha256: string }} SnapshotObject
 */

const CONTENT_TYPES = /** @type {Record<string, string>} */ ({
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
});
/** The snapshot keeps bytes only; the type follows the key's extension (R-MEM-12). @param {string} key */
export const contentTypeOf = (key) =>
  CONTENT_TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * The schema this checkout creates (R-BAK-06, R-DB-12: the same version only): the
 * `schema_version` a fresh run of migrations/ records, the migration names, and its tables,
 * indexes, triggers and views.
 * @param {string} root
 */
export function appSchema(root) {
  const migrations = localMigrations(root);
  const db = new Database(':memory:');
  try {
    for (const name of migrations) db.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
    const row = /** @type {{ value?: string } | undefined} */ (
      db.prepare("select value from schema_meta where key = 'schema_version'").get()
    );
    return { schemaVersion: String(row?.value ?? ''), migrations, objects: schemaObjects(db) };
  } finally {
    db.close();
  }
}

/**
 * Each table, index, trigger and view as `<type> <name>` → its SQL, whitespace collapsed (SQLite
 * already normalises the CREATE keyword and drops IF NOT EXISTS). Not SQLite's, D1's
 * (`_cf_`, `d1_migrations`) or the local adapter's (`_local_migrations`) own.
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<string, string>}
 */
function schemaObjects(db) {
  const rows = /** @type {{ type: string; name: string; sql: string }[]} */ (
    db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT IN ('d1_migrations', '_local_migrations')",
      )
      .all()
  );
  return new Map(
    rows.map((row) => [`${row.type} ${row.name}`, row.sql.replace(/\s+/g, ' ').trim()]),
  );
}

/**
 * R-BAK-06: the dump's schema against this checkout's, so a hand-made database.sql with the
 * right migration rows but an altered table or an extra trigger never reaches a new site.
 * @param {Map<string, string>} app @param {Map<string, string>} dumped
 */
function schemaDifferences(app, dumped) {
  const problems = [];
  for (const [object, sql] of dumped)
    if (!app.has(object)) problems.push(`${object} is not in this checkout`);
    else if (app.get(object) !== sql) problems.push(`${object} differs`);
  for (const object of app.keys()) if (!dumped.has(object)) problems.push(`${object} is missing`);
  return problems;
}

/** @param {RestoreDeps} deps @returns {Promise<number>} exit code */
export async function runRestore(deps) {
  const out = deps.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = deps.err ?? ((/** @type {string} */ line) => console.error(line));
  try {
    refuseLiveOrUsedTarget(deps.target);
    const source = deps.source;
    if (!existsSync(source)) throw new RestoreError(`${source} does not exist.`);
    if (statSync(source).isDirectory())
      return await restoreSnapshot(
        deps,
        source,
        await verifySnapshot(source, { secrets: deps.secrets }),
        out,
        err,
      );
    if (!source.endsWith('.tar.age'))
      throw new RestoreError('give a classhub-backup-*.tar.age archive or an extracted directory.');
    if (!deps.identity || !existsSync(deps.identity))
      throw new RestoreError(
        'an archive needs the age identity: --identity <key.txt> or AGE_IDENTITY_FILE.',
      );
    return await withVerifiedArchive(source, deps.identity, deps, (dir, result) =>
      restoreSnapshot(deps, dir, result, out, err),
    );
  } catch (error) {
    if (!(error instanceof RestoreError)) throw error;
    err(`restore: ${error.message}`);
    return 1;
  }
}

/** R-BAK-06: never the live binding, never a database or bucket that holds anything. @param {NewTarget | LocalTarget} target */
function refuseLiveOrUsedTarget(target) {
  if (target.kind === 'local') {
    for (const file of [target.dbFile, `${target.dbFile}-wal`])
      if (existsSync(file))
        throw new RestoreError(
          `${file} already exists; --target local restores into a new data/ only. Move it aside first.`,
        );
    if (existsSync(target.objectsDir) && readdirSync(target.objectsDir).length > 0)
      throw new RestoreError(
        `${target.objectsDir} is not empty; --target local restores into a new data/ only. Move it aside first.`,
      );
    return;
  }
  const names = [target.live.databaseId, target.live.databaseName, 'DB'].filter(Boolean);
  if (names.some((name) => name?.toLowerCase() === target.database.toLowerCase()))
    throw new RestoreError(
      `${target.database} is the live database in wrangler.jsonc; restore only into a new, empty one (R-BAK-08).`,
    );
  if (target.bucket.toLowerCase() === target.live.bucket.toLowerCase())
    throw new RestoreError(
      `${target.bucket} is the live bucket in wrangler.jsonc; restore only into a new, empty one (R-BAK-08).`,
    );
}

/**
 * @param {RestoreDeps} deps @param {string | null} dir
 * @param {import('./verify-backup.mjs').Verification} result
 * @param {(line: string) => void} out @param {(line: string) => void} err
 */
async function restoreSnapshot(deps, dir, result, out, err) {
  // 1. Verify (R-BAK-04): nothing is written anywhere unless the snapshot passes.
  for (const warning of result.warnings) err(`restore: WARN ${warning}`);
  if (result.errors.length > 0 || !dir || !result.manifest) {
    for (const error of result.errors) err(`restore: FAIL ${error}`);
    err('restore: nothing restored: the backup did not verify.');
    return 1;
  }
  const manifest = result.manifest;
  const app = appSchema(deps.root);
  if (manifest.schemaVersion !== app.schemaVersion)
    throw new RestoreError(
      `the backup has schema version ${manifest.schemaVersion}, this checkout ${app.schemaVersion}; check out Class Hub ${manifest.appVersion} (RESTORE.md) and restore with it.`,
    );
  const dump = loadDump(join(dir, DATABASE));
  /** @type {{ media: import('./verify-backup.mjs').MediaRow[]; skipped: Set<string> }} */
  let plan;
  /** @type {Record<string, number>} */
  let expectedRows;
  try {
    const migrations = dump
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'd1_migrations'")
      .get()
      ? /** @type {{ name: string }[]} */ (
          dump.prepare('select name from d1_migrations order by id').all()
        ).map((row) => row.name)
      : null;
    if (!migrations)
      throw new RestoreError('database.sql has no d1_migrations table; its schema is unknown.');
    const { pending, ahead } = compareMigrations(app.migrations, migrations);
    if (pending.length || ahead.length)
      throw new RestoreError(
        `the backup's migrations differ from this checkout's (${pending.length} missing, ${ahead.length} unknown); check out Class Hub ${manifest.appVersion} (RESTORE.md) and restore with it.`,
      );
    const differences = schemaDifferences(app.objects, schemaObjects(dump));
    if (differences.length)
      throw new RestoreError(
        `database.sql's schema is not the one its migrations create (${differences.slice(0, 10).join('; ')}); nothing restored.`,
      );
    // Integrity (R-BAK-06), on the verified dump before anything is written.
    const dangling = /** @type {{ table: string; parent: string }[]} */ (
      dump.prepare(RESTORE_FOREIGN_KEY_CHECK).all()
    );
    if (dangling.length) throw new RestoreError(danglingMessage(dangling));
    plan = {
      media: describeDump(dump).media,
      skipped: new Set(manifest.skipped.map((s) => s.key)),
    };
    for (const object of requiredObjects(plan.media))
      if (plan.skipped.has(object.key))
        // R-BAK-16: deleted after the export; the backup kept the row but not the bytes.
        err(
          `restore: WARN media ${object.mediaId} was deleted on the old site after the export; ${object.key} is not in the backup.`,
        );
    // What the target must hold afterwards, decided before any write: the dump with the
    // import's clears and, for `--target new`, the lock (R-BAK-07: local keeps setup_state).
    const locked = deps.target.kind === 'new';
    for (const statement of RESTORE_IMPORT_TAIL)
      if (locked || statement !== RESTORE_LOCK_SETUP) dump.exec(statement);
    expectedRows = Object.fromEntries(
      Object.keys(manifest.tables).map((table) => [
        table,
        Number(
          /** @type {{ n: number }} */ (dump.prepare(restoreCountSelect(identifier(table))).get())
            .n,
        ),
      ]),
    );
    checkRestored(
      expectedRows,
      (sql) => /** @type {Record<string, unknown>[]} */ (dump.prepare(sql).all()),
      locked,
    );
    if (deps.target.kind === 'local')
      return await restoreLocal(deps, deps.target, dir, dump, manifest, expectedRows, out);
  } finally {
    dump.close();
  }
  return await restoreNew(deps.target, dir, manifest, plan, expectedRows, deps.tmpRoot, out, err);
}

/** @param {{ table: string; parent: string }[]} rows */
function danglingMessage(rows) {
  const pairs = [...new Set(rows.map((row) => `${row.table} → ${row.parent}`))].slice(0, 10);
  return `${rows.length} foreign keys in database.sql do not resolve (${pairs.join(', ')}); nothing restored.`;
}

/** Every file under objects/ with its checksum line. @param {string} dir @returns {SnapshotObject[]} */
function snapshotObjects(dir) {
  /** @type {Map<string, string>} */
  const sums = new Map();
  for (const line of readFileSync(join(dir, CHECKSUMS), 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (match) sums.set(/** @type {string} */ (match[2]), /** @type {string} */ (match[1]));
  }
  return listFiles(dir)
    .filter((file) => file.startsWith(`${OBJECTS}/`))
    .map((file) => ({
      key: file.slice(OBJECTS.length + 1),
      path: join(dir, file),
      size: statSync(join(dir, file)).size,
      sha256: /** @type {string} */ (sums.get(file)),
    }));
}

/**
 * R-BAK-07: the database file and objects directory `dev:offline` opens, written whole under
 * temporary names beside them and renamed into place only once re-verified.
 * @param {RestoreDeps} deps @param {LocalTarget} target @param {string} dir
 * @param {import('better-sqlite3').Database} dump @param {import('./verify-backup.mjs').Manifest} manifest
 * @param {Record<string, number>} expectedRows
 * @param {(line: string) => void} out
 */
async function restoreLocal(deps, target, dir, dump, manifest, expectedRows, out) {
  const stamp = `${process.pid}-${Date.now()}`;
  const dbTemp = join(dirname(target.dbFile), `.${basename(target.dbFile)}.restoring-${stamp}`);
  const objectsTemp = join(
    dirname(target.objectsDir),
    `.${basename(target.objectsDir)}.restoring-${stamp}`,
  );
  // A failed or interrupted run leaves neither in place, so the next run is not refused.
  let dbPlaced = false;
  let placed = false;
  const cleanup = () => {
    rmSync(dbTemp, { force: true });
    rmSync(objectsTemp, { recursive: true, force: true });
    if (dbPlaced && !placed) rmSync(target.dbFile, { force: true });
  };
  const unregister = onSignalCleanup(cleanup);
  try {
    // The dump already holds the clears (restoreSnapshot); add the local adapter's own
    // migration record, so it sees every migration as applied (createLocalDatabase).
    dump.exec(
      'CREATE TABLE IF NOT EXISTS `_local_migrations` (`name` text PRIMARY KEY NOT NULL, `applied_at` integer NOT NULL)',
    );
    const record = dump.prepare(
      'INSERT OR IGNORE INTO `_local_migrations` (name, applied_at) VALUES (?, ?)',
    );
    for (const name of localMigrations(deps.root)) record.run(name, Date.now());
    // mkdir happens in FsObjectStorage; the database file's directory too.
    const storage = new FsObjectStorage(objectsTemp);
    writeFileSync(dbTemp, dump.serialize(), { flag: 'wx', mode: 0o600 });
    const objects = snapshotObjects(dir);
    for (const object of objects)
      await storage.put(
        object.key,
        /** @type {ReadableStream<Uint8Array>} */ (
          Readable.toWeb(Readable.from(readFileSync(object.path)))
        ),
        { contentType: contentTypeOf(object.key), maxBytes: Math.max(object.size, 1) },
      );
    // Re-verify what was written, not what was meant to be.
    for (const object of objects) {
      const head = await storage.head(object.key);
      const sha = await sha256File(join(objectsTemp, ...object.key.split('/')));
      if (head?.size !== object.size || sha !== object.sha256)
        throw new RestoreError(
          `${object.key} differs from the backup after the copy; nothing restored.`,
        );
    }
    const written = new Database(dbTemp, { readonly: true });
    try {
      checkRestored(
        expectedRows,
        (sql) => /** @type {Record<string, unknown>[]} */ (written.prepare(sql).all()),
        false,
      );
    } finally {
      written.close();
    }
    // The database first: if the objects cannot follow, cleanup removes it again.
    renameSync(dbTemp, target.dbFile);
    dbPlaced = true;
    renameSync(objectsTemp, target.objectsDir);
    placed = true;
    out(
      `restore: OK ${manifest.exportedAt} into ${target.dbFile} and ${target.objectsDir}: ${Object.values(manifest.tables).reduce((a, b) => a + b, 0)} rows, ${objects.length} objects. Push subscriptions were emptied and Access subjects cleared; setup_state is as backed up (R-BAK-07).`,
    );
    out('restore: open it with npm run dev:offline (no Cloudflare credentials needed).');
    return 0;
  } finally {
    unregister();
    cleanup();
  }
}

/**
 * A database against what the restore must leave (R-BAK-06): every table's rows as the dump
 * holds them after the import's clears and lock (push subscriptions none; a `setup_state` row
 * the lock adds), every foreign key resolving, no Access subject left, the site locked unless
 * `--target local` (R-BAK-07). Read-only, the pinned statements cf.mjs allows.
 * @param {Record<string, number>} expected rows per manifest table
 * @param {(sql: string) => Record<string, unknown>[]} query
 * @param {boolean} locked
 */
function checkRestored(expected, query, locked) {
  const problems = [];
  for (const [table, rows] of Object.entries(expected)) {
    const actual = Number(query(restoreCountSelect(identifier(table)))[0]?.n);
    if (actual !== rows) problems.push(`${table} holds ${actual} rows, the backup ${rows}`);
  }
  if (query(RESTORE_FOREIGN_KEY_CHECK).length) problems.push('a foreign key does not resolve');
  if (Number(query(RESTORE_ACCESS_SUB_LEFT)[0]?.n) !== 0)
    problems.push('an Access subject is still set');
  if (locked && query(RESTORE_SETUP_STATE_SELECT)[0]?.v !== '"locked"')
    problems.push('setup_state is not locked');
  if (problems.length)
    throw new RestoreError(
      `the restored database does not match the backup: ${problems.join('; ')}.`,
    );
}

/** A table name from the manifest, as a bare SQL identifier (cf.mjs refuses double quotes). @param {string} name */
function identifier(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new RestoreError(`unexpected table name ${name.slice(0, 40)}.`);
  return name;
}

/**
 * R-BAK-06 into a new D1 database and bucket in the guarded account.
 * @param {NewTarget} target @param {string} dir
 * @param {import('./verify-backup.mjs').Manifest} manifest
 * @param {{ media: import('./verify-backup.mjs').MediaRow[]; skipped: Set<string> }} plan
 * @param {Record<string, number>} expectedRows
 * @param {string | undefined} tmpRoot
 * @param {(line: string) => void} out @param {(line: string) => void} err
 */
async function restoreNew(target, dir, manifest, plan, expectedRows, tmpRoot, out, err) {
  const { run, database, storage } = target;
  // The id behind the name, never the live one (AC-BAK-04).
  const info = run(['d1', 'info', database, '--json']);
  /** @type {unknown} */
  let uuid;
  try {
    if (info.status !== 0) throw new Error(reason(info));
    uuid = JSON.parse(info.stdout)?.uuid;
  } catch {
    throw new RestoreError(
      `cannot read D1 database ${database}; create it first: node scripts/cf.mjs d1 create ${database}`,
    );
  }
  if (typeof uuid !== 'string' || uuid.toLowerCase() === target.live.databaseId.toLowerCase())
    throw new RestoreError(
      `${database} is the live database in wrangler.jsonc; restore only into a new, empty one (R-BAK-08).`,
    );
  const [tables = []] = await d1Remote(run, [RESTORE_TARGET_TABLES], database).catch(() => {
    throw new RestoreError(`cannot read the tables of ${database}; nothing restored.`);
  });
  if (tables.length)
    throw new RestoreError(
      `${database} is not empty (${tables.length} tables); restore only into a new, empty database.`,
    );
  const listed = await storage.list('').catch(() => {
    throw new RestoreError(
      `cannot list bucket ${target.bucket} with the R2_RESTORE_* pair; nothing restored.`,
    );
  });
  if (listed.objects.length)
    throw new RestoreError(
      `bucket ${target.bucket} is not empty; restore only into a new, empty bucket.`,
    );

  const partial = `The new database and bucket may be partly written; nothing touched the live site. Delete ${database} and ${target.bucket} (or make new ones) and run restore again.`;
  const scratch = mkdtempSync(join(tmpRoot ?? tmpdir(), 'classhub-restore-'));
  const unregister = onSignalCleanup(() => rmSync(scratch, { recursive: true, force: true }));
  try {
    // 2. Import the SQL, ending with the clears and the lock: the only write cf.mjs lets reach a
    // database wrangler.jsonc does not bind, and only while it holds no table. The guard makes
    // a second import racing past that check fail instead of merging.
    const importFile = join(scratch, DATABASE);
    const statements = (/** @type {string[]} */ list) =>
      list.map((statement) => `${statement};`).join('\n');
    writeFileSync(
      importFile,
      `${statements([RESTORE_IMPORT_GUARD])}\n${readFileSync(join(dir, DATABASE), 'utf8').trimEnd()}\n${statements([...RESTORE_IMPORT_TAIL, RESTORE_IMPORT_GUARD_DROP])}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    out(`restore: importing database.sql into ${database}…`);
    const imported = run(['d1', 'execute', database, '--remote', '--file', importFile]);
    rmSync(importFile, { force: true });
    if (imported.status !== 0)
      throw new RestoreError(`importing database.sql failed (${reason(imported)}).`);
    // 3. Copy the objects.
    const objects = snapshotObjects(dir);
    out(`restore: copying ${objects.length} objects into ${target.bucket}…`);
    for (const object of objects)
      await storage.put(object.key, readFileSync(object.path), contentTypeOf(object.key));
    // 4. Re-verify: the bucket holds exactly these objects, byte for byte.
    const remote = await listAll(storage);
    const expected = new Map(objects.map((object) => [object.key, object]));
    if (
      remote.size !== expected.size ||
      [...remote].some(([key, size]) => expected.get(key)?.size !== size)
    )
      throw new RestoreError(
        `bucket ${target.bucket} does not hold exactly the backup's objects after the copy.`,
      );
    for (const [index, object] of objects.entries()) {
      const back = await storage.get(object.key, join(scratch, String(index)), object.size);
      rmSync(join(scratch, String(index)), { force: true });
      if (back?.sha256 !== object.sha256)
        throw new RestoreError(`${object.key} differs from the backup after the copy.`);
    }
    // 5. Integrity, read-only: every live media row in the new database has its objects, then
    // counts, foreign keys, subjects and the lock as the new database holds them.
    const [rows = []] = await d1Remote(run, [RESTORE_MEDIA_SELECT], database);
    for (const object of requiredObjects(
      /** @type {import('./verify-backup.mjs').MediaRow[]} */ (/** @type {unknown} */ (rows)),
    )) {
      if (plan.skipped.has(object.key)) continue;
      const copied = expected.get(object.key);
      if (copied?.size !== object.size || copied.sha256 !== object.sha256)
        throw new RestoreError(
          `media ${object.mediaId} has no matching ${object.key} in ${target.bucket}.`,
        );
    }
    /** @type {Map<string, Record<string, unknown>[]>} */
    const answers = new Map();
    const reads = [
      ...Object.keys(manifest.tables).map((table) => restoreCountSelect(identifier(table))),
      RESTORE_FOREIGN_KEY_CHECK,
      RESTORE_ACCESS_SUB_LEFT,
      RESTORE_SETUP_STATE_SELECT,
    ];
    // One statement per call: cf.mjs matches each against the pinned text whole.
    for (const sql of reads) answers.set(sql, (await d1Remote(run, [sql], database))[0] ?? []);
    checkRestored(expectedRows, (sql) => answers.get(sql) ?? [], true);
    out(
      `restore: OK ${manifest.exportedAt} into ${database} and ${target.bucket}: ${objects.length} objects re-verified. It starts locked (R-BAK-06).`,
    );
    out(
      'restore: next, bind them in wrangler.jsonc, deploy, run npm run preflight and npm run unlock; members re-link by email on first login and turn push on again.',
    );
    return 0;
  } catch (error) {
    err(`restore: ${partial}`);
    if (error instanceof RestoreError) throw error;
    // Driver and S3 errors can carry values; say which step to check instead.
    throw new RestoreError('a remote step failed (D1 or R2).');
  } finally {
    unregister();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** @param {RestoreStorage} storage @returns {Promise<Map<string, number>>} key → size */
async function listAll(storage) {
  /** @type {Map<string, number>} */
  const keys = new Map();
  /** @type {string | undefined} */
  let cursor;
  do {
    const page = await storage.list('', cursor);
    for (const object of page.objects) keys.set(object.key, object.size);
    cursor = page.cursor;
  } while (cursor);
  return keys;
}
