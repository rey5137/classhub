// R-BAK-03/04/05/09/16/17: `npm run backup`. D1 through the account guard (cf.mjs), R2 through
// the one S3 client (s3.mjs) with the read-only pair. The snapshot is staged in a private
// temporary directory, verified, then encrypted with `age`; the `.tar.age` is the only output.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { acquireBackupLock, BACKUP_LOCK_PATH, LockHeldError } from './backup-lock.mjs';
import { pruneOldSnapshots } from './backup-retention.mjs';
import { secretsFrom } from './backup-scan.mjs';
import { BACKUP_RUNS_INSERT, D1_CLOCK_SELECT } from './backup-sql.mjs';
import { d1Remote, reason } from './cf-child.mjs';
import { readEnvFile } from './env-file.mjs';
import { uuidv7 } from './ids.mjs';
import { createS3Client, validObjectKey } from './s3.mjs';
import {
  CHECKSUMS,
  DATABASE,
  describeDump,
  listFiles,
  loadDump,
  MANIFEST,
  OBJECTS,
  onSignalCleanup,
  pipeCommands,
  PORTABLE,
  portableFiles,
  requiredObjects,
  runPendingCleanups,
  RESTORE_NOTES,
  sha256File,
  verifySnapshot,
} from './verify-backup.mjs';
import { guardedTargets } from './guarded-targets.mjs';

// Any age-style recipient (X25519, post-quantum `age1pq1…`, plugins such as `age1yubikey1…`);
// `age` itself rejects a malformed one before anything is written.
export const AGE_RECIPIENT = /^age1[0-9a-z]+$/;
// Only final keys; `staging/` is never read, copied or counted (R-BAK-04, R-MEM-12).
const PREFIXES = ['media/', 'avatars/'];

const envSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});
const rawResultSchema = z.array(
  z.object({
    results: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) }),
  }),
);

/**
 * @typedef {{
 *   list(prefix: string, cursor?: string): Promise<{ objects: { key: string; size: number }[]; cursor?: string }>;
 *   get(key: string, destination: string, expectedSize: number): Promise<{ size: number; sha256: string } | null>;
 * }} BackupStorage
 * @typedef {{
 *   run: import('./cf-child.mjs').CfRunner;
 *   storage: BackupStorage;
 *   databaseId: string;
 *   bucket: string;
 *   appVersion: string;
 *   recipient: string | undefined;
 *   outDir: string;
 *   ageAvailable?: () => boolean;
 *   encrypt?: (stage: string, name: string, recipient: string, destination: string) => Promise<void>;
 *   secrets?: import('./backup-scan.mjs').Secret[];
 *   pruneOld?: boolean;
 *   removeFile?: (path: string) => void;
 *   lockPath?: string;
 *   tmpRoot?: string;
 *   out?: (line: string) => void;
 *   err?: (line: string) => void;
 * }} BackupDeps
 */

/**
 * The guarded configuration: wrangler.jsonc and .env.cloudflare agree on the account (INV-9),
 * the S3 endpoint comes from that account id and the read-only R2 pair (R-BAK-17, AC-BAK-11).
 * Makes no remote call. Throws on anything missing.
 * @param {string} root @param {{ fetch?: typeof fetch }} [options]
 */
export function backupDependencies(root, options = {}) {
  const file = readEnvFile(join(root, '.env.cloudflare'));
  const env = envSchema.parse(file);
  const { databaseId, bucket } = guardedTargets(root, env.CLOUDFLARE_ACCOUNT_ID);
  return {
    databaseId,
    bucket,
    recipient: file?.AGE_RECIPIENT,
    // AC-BAK-08: the staged snapshot is scanned for these before it is encrypted.
    secrets: secretsFrom(file),
    storage: createS3Client(
      {
        account: env.CLOUDFLARE_ACCOUNT_ID,
        bucket,
        accessKey: env.R2_ACCESS_KEY_ID,
        secretKey: env.R2_SECRET_ACCESS_KEY,
      },
      options,
    ),
  };
}

/** `age` on PATH, run with no environment beyond PATH. */
export function ageOnPath() {
  const result = spawnSync('age', ['--version'], {
    env: { PATH: process.env.PATH ?? '' },
    stdio: 'ignore',
    timeout: 10_000,
  });
  return result.status === 0;
}

/** @param {string} stage @param {string} name @param {string} recipient @param {string} destination */
export function encryptWithAge(stage, name, recipient, destination) {
  return pipeCommands(
    ['tar', '-C', stage, '-cf', '-', name],
    ['age', '-r', recipient, '-o', destination],
    30 * 60_000,
    // macOS bsdtar would add `._name` AppleDouble members for xattrs, which verify on Linux rejects.
    { COPYFILE_DISABLE: '1' },
  );
}

/** @param {{ appVersion: string; schemaVersion: string; exportedAt: string }} facts */
export function restoreNotes({ appVersion, schemaVersion, exportedAt }) {
  return `# Restoring this Class Hub backup

Exported ${exportedAt} by Class Hub ${appVersion} (schema version ${schemaVersion}).

A backup restores only into the same app version (R-BAK-06), and only side by side: into a new,
empty database and bucket, never over a live site.

1. Check out the release this backup came from and install it:

       git checkout v${appVersion}
       npm ci

2. Verify the archive with your \`age\` identity (keep that key off the machine that holds the
   archive):

       npm run verify-backup -- <classhub-backup-….tar.age> --identity <key.txt>

3. Restore into a new database and bucket:

       npm run restore -- <classhub-backup-….tar.age> --target new

   The restored site starts locked; run \`npm run preflight\` and \`npm run unlock\` on it.

Contents: \`${MANIFEST}\` (counts, sizes, hashes), \`${DATABASE}\` (the authoritative SQL
export), \`${OBJECTS}/\` (every photo and avatar, byte for byte) and \`${CHECKSUMS}\`.
`;
}

export { runPendingCleanups };

/** @param {BackupDeps} deps @returns {Promise<number>} exit code */
export async function runBackup(deps) {
  const out = deps.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = deps.err ?? ((/** @type {string} */ line) => console.error(line));

  // R-BAK-05 / AC-BAK-09: refuse before any lock, file or remote read.
  const recipient = deps.recipient?.trim() ?? '';
  if (!recipient) {
    err('backup: no age recipient; set AGE_RECIPIENT in .env.cloudflare or pass --recipient age1…');
    return 1;
  }
  if (!AGE_RECIPIENT.test(recipient)) {
    err(
      'backup: the age recipient must be a public key starting with age1 (age-keygen -y key.txt)',
    );
    return 1;
  }
  if (!(deps.ageAvailable ?? ageOnPath)()) {
    err('backup: age is not on PATH; install it (docs/DEPLOY_CLOUDFLARE.md, prerequisites)');
    return 1;
  }

  let release;
  try {
    release = acquireBackupLock('backup', deps.lockPath ?? BACKUP_LOCK_PATH);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    err(`backup: ${error.message}`);
    return 1;
  }
  // Named once the D1 clock is read (below); the cleanup tolerates a failure before that.
  /** @type {string} */
  let name;
  /** @type {string} */
  let archive;
  /** @type {string | undefined} */
  let partial;
  /** @type {string | undefined} */
  let stage;
  const cleanup = () => {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (partial) rmSync(partial, { force: true });
    release();
  };
  const unregister = onSignalCleanup(cleanup);
  try {
    // mkdtemp creates the directory 0700: plaintext member data stays private to this user.
    // Inside the try, so a full or missing TMPDIR still releases the lock.
    stage = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'classhub-backup-'));
    const run = deps.run;
    // The account/token guard succeeds before any S3 request (R-BAK-17).
    const guard = run(['api', `/r2/buckets/${deps.bucket}`]);
    if (guard.status !== 0) throw new Error(`the account guard refused (${reason(guard)})`);

    // R-BAK-03: live row counts before the export; verification fails a dump holding fewer
    // rows of a never-hard-deleted table (R-BAK-04, R-DB-13).
    const liveCounts = await readLiveCounts(run);

    // The export time comes from D1's clock, read right before the export: INV-7 compares it
    // with Cloudflare's deploy time, and this machine's clock may be wrong (R-BAK-09).
    const clock = run(['d1-query', deps.databaseId], {
      input: JSON.stringify({ sql: D1_CLOCK_SELECT, params: [] }),
    });
    if (clock.status !== 0) throw new Error(`cannot read the D1 clock (${reason(clock)})`);
    const exportedAtMs = rawResultSchema.parse(JSON.parse(clock.stdout))[0]?.results.rows[0]?.[0];
    if (typeof exportedAtMs !== 'number' || !Number.isFinite(exportedAtMs))
      throw new Error('the D1 clock returned no time');
    // The manifest, RESTORE.md and the snapshot name all carry this one value, so they agree
    // with the `verified_at` recorded in backup_runs.
    const exportedAt = new Date(exportedAtMs).toISOString();
    name = `classhub-backup-${exportedAt.replace(/:|\.\d{3}/g, '')}`;
    archive = join(deps.outDir, `${name}.tar.age`);
    partial = join(deps.outDir, `.${name}.tar.age.partial`);
    const snapshot = join(stage, name);
    mkdirSync(snapshot, { mode: 0o700 });

    // 1. D1: the SQL export is the authoritative artifact (R-BAK-01).
    const sqlPath = join(snapshot, DATABASE);
    const exported = run(['d1', 'export', 'DB', '--remote', '--output', sqlPath]);
    if (exported.status !== 0) throw new Error(`d1 export failed (${reason(exported)})`);
    if (!existsSync(sqlPath)) throw new Error('d1 export wrote no file');
    let dump;
    /** @type {ReturnType<typeof portableFiles>} */
    let portable;
    let db;
    try {
      db = loadDump(sqlPath);
    } catch {
      throw new Error('the exported database.sql does not parse');
    }
    try {
      dump = describeDump(db);
      // §13.1: the NDJSON interchange, from the dump in a local SQLite, no extra remote read.
      portable = portableFiles(db, dump.tables);
    } finally {
      db.close();
    }
    if (dump.schemaVersion === null) throw new Error('the export has no schema_version');
    mkdirSync(join(snapshot, PORTABLE), { mode: 0o700 });
    for (const [path, { text }] of portable)
      writeFileSync(join(snapshot, ...path.split('/')), text, { mode: 0o600, flag: 'wx' });

    // 2. R2: every final object, in full.
    /** @type {{ key: string; size: number }[]} */
    const listed = [];
    for (const prefix of PREFIXES) {
      /** @type {string | undefined} */
      let cursor;
      const seen = new Set();
      do {
        const page = await deps.storage.list(prefix, cursor);
        listed.push(...page.objects.filter((object) => object.key.startsWith(prefix)));
        cursor = page.cursor;
        if (cursor && seen.has(cursor)) throw new Error('S3 listing repeated a cursor');
        seen.add(cursor);
      } while (cursor);
    }
    /** @type {Set<string>} */
    const copied = new Set();
    // A listed key becomes a path: check it before any directory is made (no `..`, no
    // empty segment, final prefixes only).
    const invalid = listed.find((object) => !validObjectKey(object.key));
    if (invalid) throw new Error('R2 lists an object key outside media/ and avatars/');
    for (const object of listed) {
      const destination = join(snapshot, OBJECTS, ...object.key.split('/'));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const result = await deps.storage.get(object.key, destination, object.size);
      if (result) copied.add(object.key);
    }

    // 3. R-BAK-16: a needed object that is gone is fine only when its photo was deleted after
    // the export (the row is soft-deleted or gone now); anything else fails the backup.
    const listedKeys = new Set(listed.map((object) => object.key));
    /** @type {{ key: string; mediaId?: string; reason: 'deleted-after-export' | 'gone-before-copy' }[]} */
    const skipped = [];
    const required = requiredObjects(dump.media);
    const requiredKeys = new Set(required.map((object) => object.key));
    for (const object of required) {
      if (copied.has(object.key)) continue;
      if (!deletedSinceExport(deps, object.mediaId))
        throw new Error(`object ${object.key} (media ${object.mediaId}) is missing from R2`);
      skipped.push({ key: object.key, mediaId: object.mediaId, reason: 'deleted-after-export' });
    }
    // Listed, then gone before the GET, and no live row of the export needs it: recorded only.
    for (const key of listedKeys)
      if (!copied.has(key) && !requiredKeys.has(key))
        skipped.push({ key, reason: 'gone-before-copy' });

    // 4. RESTORE.md, checksums and the manifest; `completed: true` last (R-BAK-02).
    const schemaVersion = dump.schemaVersion;
    writeFileSync(
      join(snapshot, RESTORE_NOTES),
      restoreNotes({
        appVersion: deps.appVersion,
        schemaVersion,
        exportedAt,
      }),
      { mode: 0o600 },
    );
    const files = listFiles(snapshot).sort();
    const lines = [];
    let totalBytes = 0;
    let objectCount = 0;
    for (const file of files) {
      lines.push(`${await sha256File(join(snapshot, file))}  ${file}`);
      if (file.startsWith(`${OBJECTS}/`)) {
        objectCount += 1;
        totalBytes += lstatSync(join(snapshot, file)).size;
      }
    }
    writeFileSync(join(snapshot, CHECKSUMS), `${lines.join('\n')}\n`, { mode: 0o600 });
    const manifest = {
      format: 'classhub-backup',
      formatVersion: 1,
      appVersion: deps.appVersion,
      schemaVersion,
      exportedAt,
      database: {
        path: DATABASE,
        sha256: await sha256File(sqlPath),
        bytes: statSync(sqlPath).size,
      },
      tables: dump.tables,
      liveCounts,
      portable: Object.fromEntries([...portable].map(([path, { rows }]) => [path, rows])),
      objects: { count: objectCount, totalBytes },
      skipped,
      completed: false,
    };
    const manifestPath = join(snapshot, MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const { errors, warnings } = await verifySnapshot(snapshot, {
      requireCompleted: false,
      secrets: deps.secrets ?? [],
    });
    if (errors.length > 0) throw new Error(`verification failed: ${errors.join(' ')}`);
    // AC-BAK-08: a provider host members or admins wrote is theirs to keep; the owner is told.
    for (const warning of warnings) err(`backup: warning: ${warning}`);
    const final = `${JSON.stringify({ ...manifest, completed: true }, null, 2)}\n`;
    writeFileSync(manifestPath, final, { mode: 0o600 });

    // 5. Encrypt to a temporary name; the archive appears only when complete (R-BAK-05).
    mkdirSync(deps.outDir, { recursive: true });
    if (existsSync(archive)) throw new Error(`${archive} already exists`);
    await (deps.encrypt ?? encryptWithAge)(stage, name, recipient, partial);
    if (!existsSync(partial) || statSync(partial).size === 0)
      throw new Error('age wrote no archive');
    chmodSync(partial, 0o600);
    renameSync(partial, archive);

    // 6. R-BAK-09: the content-free record /admin, preflight and db:migrate:remote read.
    const manifestSha = await sha256File(manifestPath);
    const recorded = run(['d1-query', deps.databaseId], {
      input: JSON.stringify({
        sql: BACKUP_RUNS_INSERT,
        // verified_at is the D1 export time (D1's clock), not the end of the run: INV-7 compares
        // it with the last deploy, and a deploy during a long copy must not pass with an older snapshot.
        params: [uuidv7(), 'full', manifestSha, objectCount, totalBytes, exportedAtMs],
      }),
    });
    if (recorded.status !== 0) {
      err(
        `backup: ${archive} is written and verified, but recording it in backup_runs failed (${reason(recorded)}); db:migrate:remote will not count it. Run npm run backup again.`,
      );
      return 1;
    }
    out(`backup: ${archive}`);
    out(
      `backup: verified ${Object.values(dump.tables).reduce((sum, n) => sum + n, 0)} rows, ${objectCount} objects (${totalBytes} bytes)${skipped.length ? `, ${skipped.length} skipped as deleted` : ''}.`,
    );
    out('backup: copy it off this machine; keep the age identity key somewhere else.');
    // R-BAK-11: only now, after the newest snapshot verified, and still under the lock.
    // The new snapshot is written and recorded, so nothing here fails the run.
    if (deps.pruneOld) {
      try {
        const pruned = pruneOldSnapshots(deps.outDir, {
          protect: `${name}.tar.age`,
          remove: deps.removeFile,
        });
        for (const deleted of pruned.deleted) out(`backup: deleted old ${deleted}`);
        for (const { name: kept, reason: why } of pruned.failed)
          err(`backup: backup verified; could not delete ${kept}: ${why}`);
      } catch (error) {
        err(
          `backup: backup verified; could not prune old snapshots: ${/** @type {Error} */ (error).message}`,
        );
      }
    }
    return 0;
  } catch (error) {
    // Messages name keys and counts, never SQL parameters or credentials.
    err(`backup: failed: ${/** @type {Error} */ (error).message}`);
    return 1;
  } finally {
    unregister();
    cleanup();
  }
}

// Same filter as describeDump: D1's internal `_cf_` tables and SQLite's own are not data.
const LIVE_TABLES_SELECT =
  "select name from sqlite_master where type = 'table' and name not like 'sqlite\\_%' escape '\\' and name not like '\\_cf\\_%' escape '\\' order by name";

/**
 * R-BAK-03: COUNT(*) of every table, live. Through `d1 execute` (cf.mjs), since `d1-query`
 * never reads `users` or content tables; counts only, no row leaves D1 here.
 * @param {import('./cf-child.mjs').CfRunner} run @returns {Promise<Record<string, number>>}
 */
async function readLiveCounts(run) {
  let names;
  /** @type {Record<string, unknown>[][]} */
  let counts;
  try {
    const [rows = []] = await d1Remote(run, [LIVE_TABLES_SELECT]);
    names = rows.map((row) => row.name);
    if (
      !names.length ||
      names.some((name) => typeof name !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(name))
    )
      throw new Error('unexpected table names');
    counts = await d1Remote(
      run,
      names.map((name) => `select count(*) as n from ${name}`),
    );
  } catch (error) {
    throw new Error(`cannot read the live row counts (${/** @type {Error} */ (error).message})`, {
      cause: error,
    });
  }
  /** @type {Record<string, number>} */
  const live = {};
  names.forEach((name, index) => {
    const n = counts[index]?.[0]?.n;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      throw new Error(`cannot read the live row count of ${name}`);
    live[/** @type {string} */ (name)] = n;
  });
  return live;
}

/**
 * Live D1, now: is the media row soft-deleted or gone? (R-BAK-16)
 * @param {BackupDeps} deps @param {string} mediaId
 */
function deletedSinceExport(deps, mediaId) {
  const result = deps.run(['d1-query', deps.databaseId], {
    input: JSON.stringify({ sql: 'SELECT deleted_at FROM media WHERE id = ?', params: [mediaId] }),
  });
  if (result.status !== 0) throw new Error(`cannot read media from D1 (${reason(result)})`);
  const rows = rawResultSchema.parse(JSON.parse(result.stdout))[0]?.results.rows ?? [];
  return rows.length === 0 || rows[0]?.[0] !== null;
}

/** package.json's version, for the manifest and RESTORE.md. @param {string} root */
export function appVersionOf(root) {
  return z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).version;
}
