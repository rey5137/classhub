import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { media, storageUsage, uploadReservations } from '../db/schema';
import { finalKeys } from './media';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';

export async function expiredReservations(database: Database, now: number) {
  return database.db
    .select()
    .from(uploadReservations)
    .where(and(eq(uploadReservations.state, 'open'), lte(uploadReservations.expiresAt, now)))
    .orderBy(asc(uploadReservations.expiresAt), asc(uploadReservations.id))
    .limit(20);
}

/** R-MEM-21: a concurrent complete or release cannot contribute to this run's sum. */
export async function releaseExpired(database: Database, ids: string[], now: number) {
  if (!ids.length) return;
  const runId = uuidv7(now);
  await database.batch([
    database.db
      .update(uploadReservations)
      .set({ state: 'released', stateRunId: runId })
      .where(
        and(
          inArray(uploadReservations.id, ids),
          eq(uploadReservations.state, 'open'),
          lte(uploadReservations.expiresAt, now),
        ),
      ),
    database.db
      .update(storageUsage)
      .set({
        reservedBytes: sql`${storageUsage.reservedBytes} - (select coalesce(sum(${uploadReservations.reservedBytes}), 0) from ${uploadReservations} where ${uploadReservations.stateRunId} = ${runId} and ${uploadReservations.state} = 'released')`,
        updatedAt: now,
      })
      .where(eq(storageUsage.singletonId, 1)),
  ]);
}

export async function protectedStagingKeys(database: Database, keys: string[]) {
  if (!keys.length) return new Set<string>();
  const rows = await database.db
    .select({ objectKey: uploadReservations.objectKey, thumbKey: uploadReservations.thumbKey })
    .from(uploadReservations)
    .where(
      and(
        eq(uploadReservations.state, 'open'),
        or(inArray(uploadReservations.objectKey, keys), inArray(uploadReservations.thumbKey, keys)),
      ),
    )
    .limit(50);
  return new Set(rows.flatMap((row) => [row.objectKey, row.thumbKey]));
}

export async function purgeableMedia(database: Database, cutoff: number) {
  return database.db
    .select()
    .from(media)
    .where(and(isNull(media.purgedAt), lte(media.deletedAt, cutoff)))
    .orderBy(asc(media.deletedAt), asc(media.id))
    .limit(20);
}

/** R-MEM-20: object deletion succeeds first; one batch subtracts still-unpurged rows once. */
export async function markPurged(database: Database, ids: string[], cutoff: number, now: number) {
  if (!ids.length) return;
  const eligible = and(
    inArray(media.id, ids),
    isNull(media.purgedAt),
    lte(media.deletedAt, cutoff),
  );
  await database.batch([
    database.db
      .update(storageUsage)
      .set({
        committedBytes: sql`${storageUsage.committedBytes} - (select coalesce(sum(${media.sizeBytes} + ${media.thumbSizeBytes}), 0) from ${media} where ${eligible})`,
        updatedAt: now,
      })
      .where(eq(storageUsage.singletonId, 1)),
    database.db.update(media).set({ purgedAt: now }).where(eligible),
  ]);
}

export async function retainedObjectKeys(database: Database, keys: string[], cutoff: number) {
  const keep = await protectedStagingKeys(database, keys);
  if (!keys.length) return keep;
  // A pending complete can already have copied immutable final objects (R-MEM-12).
  const finalIds = keys.flatMap((key) => {
    const match = /^(?:media\/v1\/([^/]+)\/|avatars\/v1\/[^/]+\/([^/.]+)\.)/.exec(key);
    return match ? [match[1] ?? match[2]!] : [];
  });
  if (finalIds.length) {
    const pending = await database.db
      .select()
      .from(uploadReservations)
      .where(
        and(eq(uploadReservations.state, 'open'), inArray(uploadReservations.mediaId, finalIds)),
      )
      .limit(50);
    for (const row of pending) {
      const keys = finalKeys(row);
      keep.add(keys.objectKey);
      if (keys.thumbKey) keep.add(keys.thumbKey);
    }
  }
  const rows = await database.db
    .select({ objectKey: media.objectKey, thumbKey: media.thumbKey })
    .from(media)
    .where(
      and(
        isNull(media.purgedAt),
        or(isNull(media.deletedAt), gt(media.deletedAt, cutoff)),
        or(inArray(media.objectKey, keys), inArray(media.thumbKey, keys)),
      ),
    )
    .limit(50);
  for (const row of rows) {
    keep.add(row.objectKey);
    keep.add(row.thumbKey);
  }
  return keep;
}

export async function reconcileUsage(database: Database, total: number, now: number) {
  const rows = await database.db
    .update(storageUsage)
    .set({ committedBytes: total, lastReconciledAt: now, updatedAt: now })
    .where(eq(storageUsage.singletonId, 1))
    .returning({ id: storageUsage.singletonId });
  if (rows.length !== 1) throw new Error('Missing storage usage ledger');
}
