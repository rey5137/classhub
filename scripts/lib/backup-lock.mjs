import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { root } from './cf-child.mjs';

// R-BAK-03: one lock file for backup, export-chat and prune-chat (R-CHAT-14, 18), so none of
// them overlaps another or itself. Gitignored with the rest of `.wrangler/`.
export const BACKUP_LOCK_PATH = join(root, '.wrangler', 'backup.lock');

export class LockHeldError extends Error {}

/**
 * Takes the lock with an exclusive create, or throws LockHeldError naming the file. A lock
 * left by a crashed run is never broken automatically: the owner checks no run is going and
 * removes the file.
 * @param {string} command @param {string} [path] @returns {() => void} release
 */
export function acquireBackupLock(command, path = BACKUP_LOCK_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const stamp = JSON.stringify({ command, pid: process.pid, startedAt: new Date().toISOString() });
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
    let holder = 'unknown';
    try {
      holder = readFileSync(path, 'utf8').slice(0, 200);
    } catch {
      // Released between the create and the read; still refuse rather than retry.
    }
    throw new LockHeldError(
      `another backup, export-chat, prune-chat or restore --chat holds ${path} (${holder}). If no such run is going, remove that file and try again.`,
    );
  }
  try {
    writeSync(fd, stamp);
  } finally {
    closeSync(fd);
  }
  return () => {
    // Remove only our own lock, never one another run took after a manual removal.
    try {
      if (readFileSync(path, 'utf8') === stamp) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  };
}
