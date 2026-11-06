import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { media, storageUsage, uploadReservations } from '../../src/lib/server/db/schema.ts';
import { uuidv7 } from '../../src/lib/server/ids.ts';

/**
 * REST has no atomic multi-statement batch. `reserved_bytes` is rebuilt from the open
 * reservations. `committed_bytes` is rebuilt from the rows only until the first reconcile;
 * after that the bucket total is authoritative (R-MEM-11) and a purge subtracts exactly the
 * rows it flipped, so a retry never subtracts the same bytes twice and a crash between the two
 * statements leaves an overcount (fails safe) until the next reconcile. Traffic still uses
 * atomic D1 batches.
 * @param {import('../../src/lib/server/ports/database.ts').Database} database
 */
export function createHousekeepingWrites(database) {
  /** @param {number} now */
  async function repairUsage(now) {
    await database.db
      .update(storageUsage)
      .set({
        reservedBytes: sql`(select coalesce(sum(reserved_bytes), 0) from upload_reservations where state = 'open')`,
        committedBytes: sql`case when last_reconciled_at is null then (select coalesce(sum(size_bytes + thumb_size_bytes), 0) from media where purged_at is null) else committed_bytes end`,
        updatedAt: now,
      })
      .where(eq(storageUsage.singletonId, 1));
  }
  return {
    repairUsage,
    /** @type {import('../../src/lib/server/services/job-runner.ts').HousekeepingWrites['releaseExpired']} */
    async releaseExpired(db, ids, now) {
      if (ids.length)
        await db.db
          .update(uploadReservations)
          .set({ state: 'released', stateRunId: uuidv7(now) })
          .where(
            and(
              inArray(uploadReservations.id, ids),
              eq(uploadReservations.state, 'open'),
              lte(uploadReservations.expiresAt, now),
            ),
          );
      await repairUsage(now);
    },
    /** @type {import('../../src/lib/server/services/job-runner.ts').HousekeepingWrites['markPurged']} */
    async markPurged(db, ids, cutoff, now) {
      if (!ids.length) return;
      const flipped = await db.db
        .update(media)
        .set({ purgedAt: now })
        .where(and(inArray(media.id, ids), isNull(media.purgedAt), lte(media.deletedAt, cutoff)))
        .returning({ size: media.sizeBytes, thumb: media.thumbSizeBytes });
      const bytes = flipped.reduce((sum, row) => sum + row.size + row.thumb, 0);
      await db.db
        .update(storageUsage)
        .set({
          committedBytes: sql`max(0, ${storageUsage.committedBytes} - ${bytes})`,
          updatedAt: now,
        })
        .where(eq(storageUsage.singletonId, 1));
      await repairUsage(now);
    },
  };
}
