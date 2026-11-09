// R-CHAT-15: `npm run restore -- --chat <file>`. Puts the messages of one verified chat archive
// back, insert-only (never an update or delete, so it cannot contradict R-BAK-08), skipping
// those of completed deletion requests (R-PROF-11). Runs only after a verified backup of the
// current database (the backupGate of `db:migrate:remote`) and under the backup lock.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { and, eq, or, sql } from 'drizzle-orm';
import { chatArchives, chatMessages } from '../../src/lib/server/db/schema.ts';
import { archiveRecordSchema } from '../../src/lib/server/repositories/chat-archive.ts';
import { tombstoneEmail } from '../../src/lib/server/services/members.ts';
import { backupGate } from './backup-gate.mjs';
import { acquireBackupLock, BACKUP_LOCK_PATH, LockHeldError } from './backup-lock.mjs';
import { RESTORE_CHAT_INSERT } from './backup-sql.mjs';
import { checkArchiveContent, decryptFileWithAge } from './export-chat.mjs';
import { onSignalCleanup } from './verify-backup.mjs';

/** A refusal whose message is safe to print: file names and counts, never bodies. */
class RestoreChatError extends Error {}

/**
 * @typedef {import('../../src/lib/server/ports/database.ts').Database} Database
 * @typedef {import('../../src/lib/server/repositories/chat-archive.ts').ArchiveRecord} ArchiveRecord
 * @typedef {{
 *   database: Database;
 *   run: import('./cf-child.mjs').CfRunner;
 *   file: string;
 *   identity: string | undefined;
 *   decrypt?: (archive: string, identity: string, destination: string) => Promise<void>;
 *   lockPath?: string;
 *   tmpRoot?: string;
 *   out?: (line: string) => void;
 *   err?: (line: string) => void;
 * }} RestoreChatDeps
 */

/**
 * RESTORE_CHAT_INSERT with its parameters bound, rendering exactly the pinned text cf.mjs takes.
 * @param {ArchiveRecord} record
 */
export function chatInsert(record) {
  const params = [
    record.id,
    record.roomId,
    record.senderId,
    record.clientNonce,
    record.body,
    record.createdAt,
    record.editedAt,
    record.senderId,
    tombstoneEmail(record.senderId),
  ];
  const pieces = RESTORE_CHAT_INSERT.split('?');
  return sql.join(
    pieces.flatMap((piece, index) =>
      index === 0 ? [sql.raw(piece)] : [sql`${params[index - 1]}`, sql.raw(piece)],
    ),
  );
}

/** @param {RestoreChatDeps} deps @returns {Promise<number>} exit code */
export async function runRestoreChat(deps) {
  const out = deps.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = deps.err ?? ((/** @type {string} */ line) => console.error(line));
  let release;
  try {
    release = acquireBackupLock('restore --chat', deps.lockPath ?? BACKUP_LOCK_PATH);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    err(`restore --chat: ${error.message}`);
    return 1;
  }
  const scratch = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), 'classhub-restore-chat-'));
  const cleanup = () => {
    rmSync(scratch, { recursive: true, force: true });
    release();
  };
  const unregister = onSignalCleanup(cleanup);
  try {
    // R-CHAT-15: a verified backup of the current database first, so this run can be undone.
    const gate = await backupGate(deps.run);
    if (!gate.ok) throw new RestoreChatError(`nothing restored: ${gate.detail} Fix: ${gate.fix}`);
    if (!deps.identity)
      throw new RestoreChatError(
        'an archive needs the age identity: --identity <key.txt> or AGE_IDENTITY_FILE.',
      );
    // export-chat writes `<out>/chat/<from>_<to>.ndjson.age` and records it by that name.
    const fileName = `chat/${basename(deps.file)}`;
    // The archive must be one export-chat verified and recorded (R-CHAT-14): its hash and
    // count are the check that the decrypted file is that archive, whole.
    const [archive] = await deps.database.db
      .select({ sha256: chatArchives.sha256, count: chatArchives.recordCount })
      .from(chatArchives)
      .where(eq(chatArchives.fileName, fileName))
      .limit(1);
    if (!archive)
      throw new RestoreChatError(
        `no verified chat archive is recorded as ${fileName}; restore --chat takes a file export-chat wrote, under its own name.`,
      );
    const plain = join(scratch, 'archive.ndjson');
    try {
      await (deps.decrypt ?? decryptFileWithAge)(deps.file, deps.identity, plain);
    } catch {
      throw new RestoreChatError(`cannot decrypt ${deps.file} with that identity.`);
    }
    const content = readFileSync(plain);
    const problems = checkArchiveContent(content, archive);
    if (problems.length)
      throw new RestoreChatError(
        `${fileName} does not match its recorded archive (${problems.join(', ')}); nothing restored.`,
      );
    const records = content
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => archiveRecordSchema.parse(JSON.parse(line)));
    let inserted = 0;
    let present = 0;
    let skipped = 0;
    for (const record of records) {
      const rows = /** @type {unknown[]} */ (await deps.database.db.all(chatInsert(record)));
      if (rows.length) {
        inserted += 1;
        continue;
      }
      const [existing] = await deps.database.db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          or(
            eq(chatMessages.id, record.id),
            and(
              eq(chatMessages.senderId, record.senderId),
              eq(chatMessages.clientNonce, record.clientNonce),
            ),
          ),
        )
        .limit(1);
      if (existing) present += 1;
      else skipped += 1;
    }
    out(
      `restore --chat: ${fileName}: ${inserted} messages added, ${present} already there, ${skipped} skipped (a deleted, suspended or unknown member, R-PROF-11).`,
    );
    return 0;
  } catch (error) {
    if (error instanceof RestoreChatError) err(`restore --chat: ${error.message}`);
    // Driver errors can carry message bodies. Every insert is idempotent, so a rerun resumes.
    else err('restore --chat: failed (database error); run it again to resume.');
    return 1;
  } finally {
    unregister();
    cleanup();
  }
}
