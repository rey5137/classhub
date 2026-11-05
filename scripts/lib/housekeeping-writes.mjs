import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { media, storageUsage, uploadReservations } from '../../src/lib/server/db/schema.ts';
import { uuidv7 } from '../../src/lib/server/ids.ts';

/**
 * REST has no atomic multi-statement batch. Mark rows first, then rebuild the ledger
 * from durable state. A crash between statements is repaired at the next CLI start;
 * retries never subtract the same bytes twice. Traffic still uses atomic D1 batches.
 * @param {import('../../src/lib/server/ports/database.ts').Database} database
 */
export function createHousekeepingWrites(database) {
  /** @param {number} now */
  async function repairUsage(now) {
    await database.db
      .update(storageUsage)
      .set({
        reservedBytes: sql`(select coalesce(sum(reserved_bytes), 0) from upload_reservations where state = 'open')`,
        committedBytes: sql`(select coalesce(sum(size_bytes + thumb_size_bytes), 0) from media where purged_at is null)`,
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
      if (ids.length)
        await db.db
          .update(media)
          .set({ purgedAt: now })
          .where(and(inArray(media.id, ids), isNull(media.purgedAt), lte(media.deletedAt, cutoff)));
      await repairUsage(now);
    },
  };
}
