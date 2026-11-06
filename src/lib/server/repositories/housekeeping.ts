import { and, asc, eq, gt, inArray, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { media, storageUsage, uploadReservations, users } from '../db/schema';
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
    .limit(keys.length);
  return new Set(rows.flatMap((row) => [row.objectKey, row.thumbKey]));
}

/**
 * R-MEM-13: soft-delete up to 20 live avatar rows older than an hour that are no member's
 * current `avatar_media_id` (a `complete` whose `PATCH /me` never followed); R-MEM-20 purges them.
 * One statement, so a `PATCH /me` that lands meanwhile keeps its row.
 */
export async function retireOrphanAvatars(database: Database, now: number) {
  const orphan = and(
    isNull(media.deletedAt),
    notExists(
      database.db
        .select({ one: sql`1` })
        .from(users)
        .where(eq(users.avatarMediaId, media.id)),
    ),
  );
  await database.db
    .update(media)
    .set({ deletedAt: now })
    .where(
      and(
        orphan,
        inArray(
          media.id,
          database.db
            .select({ id: media.id })
            .from(media)
            .where(
              and(eq(media.mediaType, 'avatar'), orphan, lte(media.createdAt, now - 3_600_000)),
            )
            .orderBy(asc(media.createdAt))
            .limit(20),
        ),
      ),
    );
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

/**
 * R-MEM-11: which of up to 90 listed keys the reconcile keeps (D1 allows 100 bound parameters).
 * Staging keys are looked up in the open reservations; final keys encode the media id (R-MEM-12),
 * so rows are read by primary key and the keys compared here. A key under `media/` or `avatars/` that is no final key is kept and returned as `unrecognised`.
 * `pending` is the subset held only by an
 * open reservation whose `complete` already copied it: kept, but its bytes are still in `reserved_bytes`.
 */
export async function retainedObjectKeys(database: Database, keys: string[], cutoff: number) {
  const keep = new Set<string>();
  const pending = new Set<string>();
  const unrecognised = new Set<string>();
  const staging = keys.filter((key) => key.startsWith('staging/'));
  // protectedStagingKeys binds each key twice, so 49 keys + 'open' + the limit is 100 parameters.
  for (let start = 0; start < staging.length; start += 49)
    for (const key of await protectedStagingKeys(database, staging.slice(start, start + 49)))
      keep.add(key);
  const finalIds = new Set<string>();
  for (const key of keys) {
    const match = /^(?:media\/v1\/([^/]+)\/|avatars\/v1\/[^/]+\/([^/.]+)\.)/.exec(key);
    if (match) finalIds.add(match[1] ?? match[2]!);
    else if (!key.startsWith('staging/')) {
      // Never deleted: this build did not write it, so the operator decides.
      keep.add(key);
      unrecognised.add(key);
    }
  }
  if (!finalIds.size) return { keep, pending, unrecognised };
  const ids = [...finalIds];
  const listed = new Set(keys);
  const reservations = await database.db
    .select()
    .from(uploadReservations)
    .where(and(eq(uploadReservations.state, 'open'), inArray(uploadReservations.mediaId, ids)))
    .limit(ids.length);
  for (const row of reservations) {
    const final = finalKeys(row);
    for (const key of [final.objectKey, final.thumbKey]) {
      if (key && listed.has(key)) {
        keep.add(key);
        pending.add(key);
      }
    }
  }
  const rows = await database.db
    .select({ objectKey: media.objectKey, thumbKey: media.thumbKey })
    .from(media)
    .where(
      and(
        inArray(media.id, ids),
        isNull(media.purgedAt),
        or(isNull(media.deletedAt), gt(media.deletedAt, cutoff)),
      ),
    )
    .limit(ids.length);
  for (const row of rows) {
    for (const key of [row.objectKey, row.thumbKey]) {
      if (listed.has(key)) {
        keep.add(key);
        pending.delete(key);
      }
    }
  }
  return { keep, pending, unrecognised };
}

export async function reconcileUsage(database: Database, total: number, now: number) {
  const rows = await database.db
    .update(storageUsage)
    .set({ committedBytes: total, lastReconciledAt: now, updatedAt: now })
    .where(eq(storageUsage.singletonId, 1))
    .returning({ id: storageUsage.singletonId });
  if (rows.length !== 1) throw new Error('Missing storage usage ledger');
}
