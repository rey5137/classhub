import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { ReservationInput, CompleteInput } from '../../contracts/media';
import { siteConfig } from '../../config';
import {
  albums,
  media,
  rateEvents,
  storageUsage,
  uploadReservations as reservations,
} from '../db/schema';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';

export type Reservation = typeof reservations.$inferSelect;
export type StoredMedia = typeof media.$inferSelect;
export const DAY = 86_400_000;
export const reservationKeys = (row: Reservation) => [row.objectKey, row.thumbKey].filter(Boolean);
export const mediaKeys = (row: StoredMedia) => [row.objectKey, row.thumbKey].filter(Boolean);

export function finalKeys(row: Reservation) {
  const extension = row.mimeType === 'image/webp' ? 'webp' : 'jpg';
  return row.purpose === 'avatar'
    ? { objectKey: `avatars/v1/${row.ownerId}/${row.mediaId}.${extension}`, thumbKey: '' }
    : {
        objectKey: `media/v1/${row.mediaId}/image.${extension}`,
        thumbKey: `media/v1/${row.mediaId}/thumb.${extension}`,
      };
}

export async function findReservation(database: Database, id: string) {
  return (await database.db.select().from(reservations).where(eq(reservations.id, id)).limit(1))[0];
}
export async function findMedia(database: Database, id: string) {
  return (await database.db.select().from(media).where(eq(media.id, id)).limit(1))[0];
}

function openCount(ownerId: string, now: number) {
  return sql`(select count(*) from ${reservations} where ${reservations.ownerId} = ${ownerId} and ${reservations.state} = 'open' and ${reservations.expiresAt} > ${now})`;
}
function dailyCount(ownerId: string, now: number) {
  return sql`(select count(*) from ${rateEvents} where ${rateEvents.bucket} = ${`upload:${ownerId}`} and ${rateEvents.at} > ${now - DAY})`;
}
export async function uploadLimited(
  database: Database,
  ownerId: string,
  purpose: ReservationInput['purpose'],
  now: number,
) {
  const [row] = await database.db
    .select({
      open: openCount(ownerId, now).mapWith(Number),
      daily: dailyCount(ownerId, now).mapWith(Number),
    })
    .from(storageUsage)
    .where(eq(storageUsage.singletonId, 1))
    .limit(1);
  return (
    !!row && (row.open >= 2 || (purpose === 'photo' && row.daily >= siteConfig.limits.photosPerDay))
  );
}

/** R-MEM-19: the insert takes quota and concurrent slots before the counter can move. */
export async function reserve(
  database: Database,
  ownerId: string,
  input: ReservationInput,
  now: number,
) {
  const id = uuidv7(now);
  const mediaId = uuidv7(now);
  const expiresAt = now + 15 * 60_000;
  const total = input.imageBytes + input.thumbBytes;
  const extension = input.mimeType === 'image/webp' ? 'webp' : 'jpg';
  const exists = sql`exists (select 1 from ${reservations} where ${reservations.id} = ${id})`;
  const [created] = await database.batch([
    database.db.insert(reservations).select(
      database.db
        .select({
          id: sql<string>`${id}`.as('id'),
          ownerId: sql<string>`${ownerId}`.as('ownerId'),
          mediaId: sql<string>`${mediaId}`.as('mediaId'),
          purpose: sql<ReservationInput['purpose']>`${input.purpose}`.as('purpose'),
          reservedBytes: sql<number>`${total}`.as('reservedBytes'),
          imageBytes: sql<number>`${input.imageBytes}`.as('imageBytes'),
          thumbBytes: sql<number>`${input.thumbBytes}`.as('thumbBytes'),
          sha256: sql<string>`${input.sha256}`,
          thumbSha256: sql<string>`${input.thumbSha256}`.as('thumbSha256'),
          mimeType: sql<string>`${input.mimeType}`.as('mimeType'),
          objectKey: sql<string>`${`staging/v1/${id}/image.${extension}`}`.as('objectKey'),
          thumbKey:
            sql<string>`${input.purpose === 'avatar' ? '' : `staging/v1/${id}/thumb.${extension}`}`.as(
              'thumbKey',
            ),
          state: sql<'open'>`'open'`.as('state'),
          stateRunId: sql<null>`null`.as('stateRunId'),
          createdAt: sql<number>`${now}`.as('createdAt'),
          expiresAt: sql<number>`${expiresAt}`.as('expiresAt'),
          width: sql<number>`${input.width}`.as('width'),
          height: sql<number>`${input.height}`.as('height'),
        })
        .from(storageUsage)
        .where(
          and(
            eq(storageUsage.singletonId, 1),
            sql`${storageUsage.committedBytes} + ${storageUsage.reservedBytes} + ${total} <= ${siteConfig.limits.mediaStopBytes}`,
            sql`${openCount(ownerId, now)} < 2`,
            input.purpose === 'photo'
              ? sql`${dailyCount(ownerId, now)} < ${siteConfig.limits.photosPerDay}`
              : undefined,
          ),
        )
        .getSQL(),
    ),
    database.db
      .update(storageUsage)
      .set({ reservedBytes: sql`${storageUsage.reservedBytes} + ${total}`, updatedAt: now })
      .where(and(eq(storageUsage.singletonId, 1), exists)),
    database.db
      .delete(rateEvents)
      .where(
        and(eq(rateEvents.bucket, `upload:${ownerId}`), sql`${rateEvents.at} <= ${now - DAY}`),
      ),
    database.db
      .insert(rateEvents)
      .select(
        sql`select ${`upload:${ownerId}`}, ${now} where ${exists} and ${input.purpose} = 'photo'`,
      ),
  ]);
  return created.changes ? { id, mediaId, expiresAt } : null;
}

/** R-MEM-21: only statements stamped by this call may move bytes or create media. */
export async function completeReservation(
  database: Database,
  row: Reservation,
  input: CompleteInput,
  now: number,
) {
  const runId = uuidv7(now);
  const guard = and(
    eq(reservations.id, row.id),
    eq(reservations.state, 'completed'),
    eq(reservations.stateRunId, runId),
  );
  const exists = sql`exists (select 1 from ${reservations} where ${guard})`;
  const keys = finalKeys(row);
  const effectiveYear = input.albumId
    ? sql<
        number | null
      >`coalesce((select ${albums.yearTag} from ${albums} where ${albums.id} = ${input.albumId}), ${input.takenYear ?? null})`
    : sql<number | null>`${input.takenYear ?? null}`;
  const [changed] = await database.batch([
    database.db
      .update(reservations)
      .set({ state: 'completed', stateRunId: runId })
      .where(
        and(
          eq(reservations.id, row.id),
          eq(reservations.ownerId, row.ownerId),
          eq(reservations.state, 'open'),
          gt(reservations.expiresAt, now),
        ),
      ),
    database.db.insert(media).select(
      database.db
        .select({
          id: sql<string>`${row.mediaId}`.as('id'),
          ownerId: reservations.ownerId,
          albumId: sql<string | null>`${input.albumId ?? null}`.as('albumId'),
          mediaType: reservations.purpose,
          objectKey: sql<string>`${keys.objectKey}`.as('objectKey'),
          thumbKey: sql<string>`${keys.thumbKey}`.as('thumbKey'),
          mimeType: reservations.mimeType,
          width: reservations.width,
          height: reservations.height,
          sizeBytes: reservations.imageBytes,
          thumbSizeBytes: reservations.thumbBytes,
          sha256: reservations.sha256,
          thumbSha256: reservations.thumbSha256,
          caption: sql<string | null>`${input.caption ?? null}`.as('caption'),
          takenYear: sql<number | null>`${input.takenYear ?? null}`,
          effectiveYear,
          createdAt: sql<number>`${now}`.as('createdAt'),
          deletedAt: sql<null>`null`.as('deletedAt'),
          purgedAt: sql<null>`null`.as('purgedAt'),
        })
        .from(reservations)
        .where(guard)
        .getSQL(),
    ),
    database.db
      .update(storageUsage)
      .set({
        reservedBytes: sql`${storageUsage.reservedBytes} - ${row.reservedBytes}`,
        committedBytes: sql`${storageUsage.committedBytes} + ${row.reservedBytes}`,
        updatedAt: now,
      })
      .where(and(eq(storageUsage.singletonId, 1), exists)),
  ]);
  return changed.changes > 0;
}

export async function releaseReservation(database: Database, row: Reservation, now: number) {
  const runId = uuidv7(now);
  await database.batch([
    database.db
      .update(reservations)
      .set({ state: 'released', stateRunId: runId })
      .where(
        and(
          eq(reservations.id, row.id),
          eq(reservations.ownerId, row.ownerId),
          eq(reservations.state, 'open'),
        ),
      ),
    database.db
      .update(storageUsage)
      .set({
        reservedBytes: sql`${storageUsage.reservedBytes} - (select coalesce(sum(${reservations.reservedBytes}), 0) from ${reservations} where ${reservations.stateRunId} = ${runId} and ${reservations.state} = 'released')`,
        updatedAt: now,
      })
      .where(eq(storageUsage.singletonId, 1)),
  ]);
}

/** Bounded: the upload sheet's album select lists at most this many, by name. */
export const ALBUM_CHOICES = 200;

export async function listAlbumChoices(database: Database) {
  return database.db
    .select({ id: albums.id, name: albums.name, yearTag: albums.yearTag })
    .from(albums)
    .orderBy(asc(albums.name), asc(albums.id))
    .limit(ALBUM_CHOICES);
}

export async function findAlbum(database: Database, id: string) {
  return (await database.db.select().from(albums).where(eq(albums.id, id)).limit(1))[0];
}

export async function findLiveMedia(database: Database, id: string) {
  return (
    await database.db
      .select()
      .from(media)
      .where(and(eq(media.id, id), isNull(media.deletedAt)))
      .limit(1)
  )[0];
}
