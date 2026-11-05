import { eq } from 'drizzle-orm';
import { media, storageUsage, uploadReservations } from '../../src/lib/server/db/schema';
import { uuidv7 } from '../../src/lib/server/ids';
import type { Database } from '../../src/lib/server/ports/database';
import { PEOPLE } from './membership';

export const HOUSEKEEPING_NOW = 1_800_000_000_000;
export async function seedReservation(
  database: Database,
  overrides: Partial<typeof uploadReservations.$inferInsert> = {},
) {
  const id = uuidv7();
  const row = {
    id,
    ownerId: PEOPLE.active.id,
    mediaId: uuidv7(),
    purpose: 'photo' as const,
    reservedBytes: 20,
    imageBytes: 12,
    thumbBytes: 8,
    sha256: 'a'.repeat(64),
    thumbSha256: 'b'.repeat(64),
    mimeType: 'image/webp',
    objectKey: `staging/v1/${id}/image.webp`,
    thumbKey: `staging/v1/${id}/thumb.webp`,
    state: 'open' as const,
    createdAt: HOUSEKEEPING_NOW - 1000,
    expiresAt: HOUSEKEEPING_NOW - 1,
    ...overrides,
  };
  await database.db.insert(uploadReservations).values(row);
  if (row.state === 'open')
    await database.db
      .update(storageUsage)
      .set({
        reservedBytes: (await usage(database)).reservedBytes + row.reservedBytes,
      })
      .where(eq(storageUsage.singletonId, 1));
  return row;
}

export async function seedDeletedMedia(
  database: Database,
  overrides: Partial<typeof media.$inferInsert> = {},
) {
  const id = uuidv7();
  const row = {
    id,
    ownerId: PEOPLE.active.id,
    mediaType: 'photo' as const,
    objectKey: `media/v1/${id}/image.webp`,
    thumbKey: `media/v1/${id}/thumb.webp`,
    mimeType: 'image/webp',
    width: 1,
    height: 1,
    sizeBytes: 12,
    thumbSizeBytes: 8,
    sha256: 'a'.repeat(64),
    thumbSha256: 'b'.repeat(64),
    createdAt: HOUSEKEEPING_NOW - 1000,
    deletedAt: HOUSEKEEPING_NOW - 8 * 86_400_000,
    ...overrides,
  };
  await database.db.insert(media).values(row);
  if (!row.purgedAt)
    await database.db
      .update(storageUsage)
      .set({
        committedBytes: (await usage(database)).committedBytes + row.sizeBytes + row.thumbSizeBytes,
      })
      .where(eq(storageUsage.singletonId, 1));
  return row;
}

export async function usage(database: Database) {
  return (
    await database.db.select().from(storageUsage).where(eq(storageUsage.singletonId, 1)).limit(1)
  )[0]!;
}
