import { desc, isNotNull } from 'drizzle-orm';
import { backupRuns } from '../db/schema';
import type { Database } from '../ports/database';

/**
 * R-BAK-09: the newest verified backup the CLI recorded, for the `/admin` status card. A row
 * holds no content, only when it was exported and how big it is; `backup_runs` stays small
 * (one row per run), so the ordered read is cheap without an index.
 */
export async function lastVerifiedBackup(
  database: Database,
): Promise<{ verifiedAt: number; totalBytes: number; objectCount: number } | null> {
  const [row] = await database.db
    .select({
      verifiedAt: backupRuns.verifiedAt,
      totalBytes: backupRuns.totalBytes,
      objectCount: backupRuns.objectCount,
    })
    .from(backupRuns)
    .where(isNotNull(backupRuns.verifiedAt))
    .orderBy(desc(backupRuns.verifiedAt))
    .limit(1);
  return row?.verifiedAt == null ? null : { ...row, verifiedAt: row.verifiedAt };
}
