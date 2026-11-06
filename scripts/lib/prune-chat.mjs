// R-CHAT-14, 18: `npm run prune-chat`. Deletes chat rows only inside verified, un-purged
// archive ranges (INV-7), in paced chunks, holding the backup lock for the whole run.

import { pruneArchived } from '../../src/lib/server/repositories/chat-archive.ts';
import { acquireBackupLock, BACKUP_LOCK_PATH, LockHeldError } from './backup-lock.mjs';
import { onSignalCleanup } from './verify-backup.mjs';

/**
 * @typedef {{
 *   database: import('../../src/lib/server/ports/database.ts').Database;
 *   now?: () => number;
 *   pause?: () => Promise<void>;
 *   chunk?: number;
 *   maxRows?: number;
 *   lockPath?: string;
 *   out?: (line: string) => void;
 *   err?: (line: string) => void;
 * }} PruneChatDeps
 */

/** @param {PruneChatDeps} deps @returns {Promise<number>} exit code */
export async function runPruneChat(deps) {
  const out = deps.out ?? ((/** @type {string} */ line) => console.log(line));
  const err = deps.err ?? ((/** @type {string} */ line) => console.error(line));
  let release;
  try {
    release = acquireBackupLock('prune-chat', deps.lockPath ?? BACKUP_LOCK_PATH);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    err(`prune-chat: ${error.message}`);
    return 1;
  }
  // A Ctrl-C between chunks must not leave the lock behind; the next run resumes.
  const unregister = onSignalCleanup(release);
  try {
    const result = await pruneArchived(deps.database, {
      now: deps.now ?? Date.now,
      // Paced between chunks, so a long prune stays gentle on D1 (R-CHAT-18).
      pause: deps.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 500))),
      chunk: deps.chunk,
      maxRows: deps.maxRows,
    });
    if (result.status === 'no-archive') {
      err(
        'prune-chat: nothing deleted: there is no verified, un-purged chat archive. Run npm run export-chat first (R-CHAT-14).',
      );
      return 1;
    }
    for (const fileName of result.purged) out(`prune-chat: ${fileName} purged`);
    if (result.status === 'grown') {
      err(
        `prune-chat: stopped after ${result.deleted} messages: the range of ${result.fileName} now holds more messages than its archive, so none of them were deleted. Nothing outside an archive is ever pruned; report this to the maintainer.`,
      );
      return 1;
    }
    out(`prune-chat: deleted ${result.deleted} archived messages.`);
    if (result.remaining)
      out(
        'prune-chat: archived messages remain (one run is capped); run npm run prune-chat again.',
      );
    return 0;
  } catch {
    // Driver errors can carry SQL parameters. Every step is idempotent, so a rerun resumes.
    err('prune-chat: failed (database error); run npm run prune-chat again to resume.');
    return 1;
  } finally {
    unregister();
    release();
  }
}
