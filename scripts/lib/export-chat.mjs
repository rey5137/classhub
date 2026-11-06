// R-CHAT-13, 14: `npm run export-chat`. Archives the chat rows over retention into one
// age-encrypted NDJSON file per range, reads each written file back with the identity, checks
// it against the database, and only then records a verified `chat_archives` row.

import { spawn } from 'node:child_process';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  archiveRecordSchema,
  exportCandidates,
  ndjsonSha256,
  rangeRecords,
  recordVerifiedArchive,
  toNdjson,
} from '../../src/lib/server/repositories/chat-archive.ts';
import { acquireBackupLock, BACKUP_LOCK_PATH, LockHeldError } from './backup-lock.mjs';
import { AGE_RECIPIENT, ageOnPath } from './backup.mjs';
import { onSignalCleanup } from './verify-backup.mjs';

const AGE_TIMEOUT_MS = 10 * 60_000;

/** A failure whose message is safe to print: file names and counts, never bodies or SQL. */
class ExportChatError extends Error {}

/**
 * @typedef {import('../../src/lib/server/ports/database.ts').Database} Database
 * @typedef {import('../../src/lib/server/repositories/chat-archive.ts').RetentionPolicy} RetentionPolicy
 * @typedef {import('../../src/lib/server/repositories/chat-archive.ts').CandidateRange} CandidateRange
 * @typedef {{
 *   database: Database;
 *   policy: RetentionPolicy;
 *   recipient: string | undefined;
 *   identity: string | undefined;
 *   outDir: string;
 *   now?: () => number;
 *   ageAvailable?: () => boolean;
 *   encrypt?: (source: string, recipient: string, destination: string) => Promise<void>;
 *   decrypt?: (archive: string, identity: string, destination: string) => Promise<void>;
 *   link?: (existing: string, created: string) => void;
 *   lockPath?: string;
 *   tmpRoot?: string;
 *   out?: (line: string) => void;
 *   err?: (line: string) => void;
 * }} ExportChatDeps
 */

/**
 * Runs one command with no shell, a bounded time and only PATH in its environment.
 * @param {string[]} argv @returns {Promise<void>}
 */
function runCommand(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { PATH: process.env.PATH ?? '', LANG: 'C' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: AGE_TIMEOUT_MS,
    });
    const unregister = onSignalCleanup(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      unregister();
      reject(error);
    });
    child.on('close', (code) => {
      unregister();
      if (code === 0) resolve();
      else
        reject(
          new Error(`${argv[0]} failed (exit ${code}): ${stderr.trim().split('\n').at(-1) ?? ''}`),
        );
    });
  });
}

/** @param {string} source @param {string} recipient @param {string} destination */
export function encryptFileWithAge(source, recipient, destination) {
  return runCommand(['age', '-r', recipient, '-o', destination, source]);
}

/** @param {string} archive @param {string} identity @param {string} destination */
export function decryptFileWithAge(archive, identity, destination) {
  return runCommand(['age', '-d', '-i', identity, '-o', destination, archive]);
}

/**
 * R-CHAT-14: the decrypted content against what the export wrote. A truncated or altered file
 * fails on its hash, its record count or an unparsable line.
 * @param {Buffer} content @param {{ sha256: string; count: number }} expected
 * @returns {string[]} problems
 */
export function checkArchiveContent(content, expected) {
  const text = content.toString('utf8');
  /** @type {string[]} */
  const problems = [];
  const lines = text === '' ? [] : text.split('\n');
  if (lines.length > 0 && lines.at(-1) !== '') problems.push('the last record is cut off');
  const records = lines.filter((line) => line !== '');
  const unparsable = records.filter((line) => {
    try {
      return !archiveRecordSchema.safeParse(JSON.parse(line)).success;
    } catch {
      return true;
    }
  }).length;
  if (unparsable > 0) problems.push(`${unparsable} unreadable record(s)`);
  if (records.length !== expected.count)
    problems.push(`${records.length} records where ${expected.count} were written`);
  if (ndjsonSha256(text) !== expected.sha256) problems.push('the SHA-256 differs');
  return problems;
}

/**
 * Puts `partial` at `final` only if that name is free: a hard link fails on an existing name,
 * where a rename would replace it. exFAT, FAT and some network shares (a USB `--out`) have no
 * hard links, so an exclusive copy stands in; it also fails on an existing name.
 * @param {string} partial @param {string} final @param {(existing: string, created: string) => void} link
 */
function publishWithoutOverwrite(partial, final, link) {
  try {
    link(partial, final);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error;
    copyFileSync(partial, final, constants.COPYFILE_EXCL);
  }
}

/** @param {ExportChatDeps} deps @returns {Promise<number>} exit code */
export async function runExportChat(deps) {
  const out = deps.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = deps.err ?? ((/** @type {string} */ line) => console.error(line));
  const clock = deps.now ?? Date.now;

  // R-CHAT-14, R-BAK-05: encryption is mandatory; refuse before the lock, a file or a read.
  const recipient = deps.recipient?.trim() ?? '';
  if (!recipient) {
    err(
      'export-chat: no age recipient; set AGE_RECIPIENT in .env.cloudflare or pass --recipient age1…',
    );
    return 1;
  }
  if (!AGE_RECIPIENT.test(recipient)) {
    err(
      'export-chat: the age recipient must be a public key starting with age1 (age-keygen -y key.txt)',
    );
    return 1;
  }
  // The written file is verified by decrypting it, so the identity is needed up front.
  if (!deps.identity || !existsSync(deps.identity)) {
    err(
      'export-chat: needs the age identity to read each archive back: --identity <key.txt> or AGE_IDENTITY_FILE. It is used for this run only; keep it away from the archives, never stored next to them (R-BAK-05).',
    );
    return 1;
  }
  if (!(deps.ageAvailable ?? ageOnPath)()) {
    err('export-chat: age is not on PATH; install it (docs/DEPLOY_CLOUDFLARE.md, prerequisites)');
    return 1;
  }
  const identity = deps.identity;

  let release;
  try {
    release = acquireBackupLock('export-chat', deps.lockPath ?? BACKUP_LOCK_PATH);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    err(`export-chat: ${error.message}`);
    return 1;
  }
  /** @type {string | undefined} */
  let stage;
  /** @type {string | undefined} */
  let partial;
  // A written file not yet recorded: removed on failure so the next run can write the range again.
  /** @type {string | undefined} */
  let unrecorded;
  const cleanup = () => {
    if (stage) rmSync(stage, { recursive: true, force: true });
    if (partial) rmSync(partial, { force: true });
    if (unrecorded) rmSync(unrecorded, { force: true });
    release();
  };
  const unregister = onSignalCleanup(cleanup);
  try {
    // mkdtemp creates the directory 0700: plaintext messages stay private to this user.
    stage = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'classhub-chat-'));
    const exportedAt = clock();
    const ranges = await exportCandidates(deps.database, deps.policy, exportedAt);
    if (ranges.length === 0) {
      out('export-chat: no messages over retention; nothing to archive.');
      return 0;
    }
    // Never overwrite (R-CHAT-14): any collision aborts before a file is written.
    const taken = ranges.filter((range) => existsSync(join(deps.outDir, range.fileName)));
    if (taken.length > 0) {
      for (const range of taken)
        err(
          `export-chat: ${join(deps.outDir, range.fileName)} already exists; nothing written. If no chat_archives row names it (an earlier run stopped before recording it), move it out of ${deps.outDir} and run again.`,
        );
      return 1;
    }
    for (const range of ranges) {
      const final = join(deps.outDir, range.fileName);
      const text = toNdjson(range.records);
      const expected = { sha256: ndjsonSha256(text), count: range.records.length };
      const plain = join(stage, 'archive.ndjson');
      writeFileSync(plain, text, { mode: 0o600 });

      mkdirSync(dirname(final), { recursive: true });
      partial = join(dirname(final), `.${range.from.id}_${range.to.id}.partial`);
      rmSync(partial, { force: true });
      try {
        await (deps.encrypt ?? encryptFileWithAge)(plain, recipient, partial);
      } catch (error) {
        throw new ExportChatError(`cannot encrypt: ${/** @type {Error} */ (error).message}`);
      }
      rmSync(plain, { force: true });
      if (!existsSync(partial) || statSync(partial).size === 0)
        throw new ExportChatError('age wrote no archive');
      chmodSync(partial, 0o600);
      try {
        publishWithoutOverwrite(partial, final, deps.link ?? linkSync);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST')
          throw new ExportChatError(`${final} appeared during the run; nothing overwritten`);
        throw new ExportChatError(
          `cannot create ${final} (${/** @type {NodeJS.ErrnoException} */ (error).code ?? 'file error'})`,
        );
      }
      unrecorded = final;
      rmSync(partial, { force: true });
      partial = undefined;

      // Read back the file on disk itself, decrypted, then the same range from the database.
      const decrypted = join(stage, 'check.ndjson');
      /** @type {string[]} */
      let problems;
      try {
        await (deps.decrypt ?? decryptFileWithAge)(final, identity, decrypted);
        problems = checkArchiveContent(readFileSync(decrypted), expected);
      } catch (error) {
        problems = [`cannot decrypt it: ${/** @type {Error} */ (error).message}`];
      } finally {
        rmSync(decrypted, { force: true });
      }
      const live = toNdjson(await rangeRecords(deps.database, range.from, range.to));
      if (ndjsonSha256(live) !== expected.sha256)
        problems.push('the database no longer holds the same messages in this range');
      if (problems.length > 0)
        throw new ExportChatError(
          `${range.fileName} failed verification (${problems.join('; ')}); nothing recorded`,
        );

      // From here the row may be written even if the call fails, so the file must stay.
      unrecorded = undefined;
      try {
        await recordVerifiedArchive(deps.database, {
          range,
          sha256: expected.sha256,
          exportedAt,
          verifiedAt: clock(),
        });
      } catch {
        err(
          `export-chat: ${final} is written and verified, but recording it in chat_archives failed; prune-chat will not use it. If no chat_archives row names ${range.fileName}, move the file aside and run export-chat again.`,
        );
        return 1;
      }
      out(
        `export-chat: ${final} (${expected.count} messages, ${new Date(range.from.createdAt).toISOString()} to ${new Date(range.to.createdAt).toISOString()})`,
      );
    }
    out('export-chat: verified; copy the files off this machine and keep the age identity apart.');
    return 0;
  } catch (error) {
    // Driver errors can carry SQL parameters; print only the export's own messages.
    err(
      error instanceof ExportChatError
        ? `export-chat: failed: ${error.message}`
        : `export-chat: failed (${/** @type {NodeJS.ErrnoException} */ (error).code ?? 'database or file error'}); nothing recorded for the range in progress.`,
    );
    return 1;
  } finally {
    unregister();
    cleanup();
  }
}
