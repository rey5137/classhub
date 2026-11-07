// R-BAK-11: `npm run backup -- --prune-old` keeps the last 12 weekly and 12 monthly local
// snapshots. Only `backup` calls it, after its new snapshot verified; it never touches R2
// (R-BAK-10) and never a file that is not a finished `classhub-backup-<ts>.tar.age`.

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_WEEKLY = 12;
export const KEEP_MONTHLY = 12;

// The name `backup` gives an archive, from D1's clock (R-BAK-02).
const SNAPSHOT = /^classhub-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.age$/;

/** @param {string} name @returns {number | null} the export time in ms, or null for any other file */
function snapshotTime(name) {
  const match = SNAPSHOT.exec(name);
  if (!match) return null;
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  // Date.UTC rolls 2026-13-40 over into a real date; only a name `backup` could write counts.
  const canonical = `classhub-backup-${new Date(time).toISOString().replace(/:|\.\d{3}/g, '')}.tar.age`;
  return canonical === name ? time : null;
}

/** ISO 8601 week (UTC), e.g. `2026-W45`. @param {number} time */
function isoWeek(time) {
  const date = new Date(time);
  const day = (date.getUTCDay() + 6) % 7; // Monday 0
  // The week's Thursday decides its year.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return `${year}-W${week}`;
}

/** @param {number} time */
function month(time) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
}

/**
 * The snapshots to delete. For each of the newest 12 weeks, and each of the newest 12 months,
 * that hold a snapshot, the newest snapshot in it is kept; everything else goes. Weeks and
 * months without a snapshot do not count, so a gap in backups never deletes the older ones
 * that cover it. Names that are not snapshots, and `protect`, are never returned.
 * @param {string[]} names @param {string} [protect] the archive this run just wrote
 * @returns {string[]}
 */
export function snapshotsToPrune(names, protect) {
  const dated = names
    .flatMap((name) => {
      const time = snapshotTime(name);
      return time === null ? [] : [{ name, time }];
    })
    .sort((a, b) => b.time - a.time);
  /** @type {Set<string>} */
  const keep = new Set(protect ? [protect] : []);
  for (const [period, limit] of /** @type {const} */ ([
    [isoWeek, KEEP_WEEKLY],
    [month, KEEP_MONTHLY],
  ])) {
    const periods = new Set();
    for (const snapshot of dated) {
      const key = period(snapshot.time);
      if (periods.has(key)) continue;
      if (periods.size === limit) break;
      periods.add(key);
      keep.add(snapshot.name);
    }
  }
  return dated.filter((snapshot) => !keep.has(snapshot.name)).map((snapshot) => snapshot.name);
}

/**
 * Deletes the old snapshots in `dir` (regular files only, never a link or a directory), never
 * `protect`. A file that cannot be deleted is reported and the rest still go: the new
 * snapshot is already written and recorded, so a failed delete must not fail the backup.
 * @param {string} dir
 * @param {{ protect?: string; remove?: (path: string) => void }} [options]
 * @returns {{ deleted: string[]; failed: { name: string; reason: string }[] }}
 */
export function pruneOldSnapshots(dir, { protect, remove = rmSync } = {}) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  /** @type {ReturnType<typeof pruneOldSnapshots>} */
  const result = { deleted: [], failed: [] };
  for (const name of snapshotsToPrune(files, protect)) {
    try {
      remove(join(dir, name));
      result.deleted.push(name);
    } catch (error) {
      const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
      result.failed.push({ name, reason: code ?? message });
    }
  }
  return result;
}
