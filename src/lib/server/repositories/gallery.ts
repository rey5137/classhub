import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { AlbumPatch, MediaPatch } from '../../contracts/media';
import { albums, media, profileContacts, users } from '../db/schema';
import { uuidv7 } from '../ids';
import type { Database } from '../ports/database';
import type { ProfileOwner } from '../services/projection';

// R-MEM-14 / R-DB-06, 07: the gallery reads live photos only, newest first, keyset on
// `(created_at, id)` over the index its filter picks (album, year or the default).

export interface GalleryRow {
  id: string;
  ownerId: string;
  caption: string | null;
  albumId: string | null;
  albumName: string | null;
  year: number | null;
  width: number;
  height: number;
  createdAt: number;
  owner: ProfileOwner;
}

const live = and(eq(media.mediaType, 'photo'), isNull(media.deletedAt));

function select(database: Database) {
  return database.db
    .select({
      id: media.id,
      ownerId: media.ownerId,
      caption: media.caption,
      albumId: media.albumId,
      albumName: albums.name,
      year: media.effectiveYear,
      width: media.width,
      height: media.height,
      createdAt: media.createdAt,
      displayName: users.displayName,
      status: users.status,
      preferredName: users.preferredName,
      avatarMediaId: users.avatarMediaId,
      deletionRequestedAt: users.deletionRequestedAt,
      visibilityJson: profileContacts.visibilityJson,
    })
    .from(media)
    .innerJoin(users, eq(users.id, media.ownerId))
    .leftJoin(albums, eq(albums.id, media.albumId))
    .leftJoin(profileContacts, eq(profileContacts.userId, media.ownerId));
}

type Selected = Awaited<ReturnType<ReturnType<typeof select>['limit']>>[number];

function toRow(row: Selected): GalleryRow {
  const {
    displayName,
    status,
    preferredName,
    avatarMediaId,
    deletionRequestedAt,
    visibilityJson,
    ...rest
  } = row;
  return {
    ...rest,
    // The gallery needs the name and avatar only, so the contact values are never read;
    // the owner's visibility map is, or a hidden avatar would show (R-PROF-02, INV-5).
    owner: {
      id: row.ownerId,
      displayName,
      status,
      preferredName,
      avatarMediaId,
      deletionRequestedAt,
      contacts:
        visibilityJson === null
          ? null
          : {
              contactEmail: null,
              phone: null,
              messagingUrl: null,
              city: null,
              bio: null,
              visibilityJson,
            },
    },
  };
}

export async function listGallery(
  database: Database,
  options: {
    albumId?: string;
    year?: number;
    after: { createdAt: number; id: string } | null;
    limit: number;
  },
): Promise<{ rows: GalleryRow[]; more: boolean }> {
  const conditions: (SQL | undefined)[] = [live];
  if (options.albumId) conditions.push(eq(media.albumId, options.albumId));
  if (options.year !== undefined) conditions.push(eq(media.effectiveYear, options.year));
  if (options.after) {
    conditions.push(
      sql`(${media.createdAt}, ${media.id}) < (${options.after.createdAt}, ${options.after.id})`,
    );
  }
  const rows = await select(database)
    .where(and(...conditions))
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(options.limit + 1);
  return { rows: rows.slice(0, options.limit).map(toRow), more: rows.length > options.limit };
}

export async function findGalleryPhoto(database: Database, id: string) {
  const [row] = await select(database)
    .where(and(eq(media.id, id), live))
    .limit(1);
  return row ? toRow(row) : undefined;
}

/** The year chips: the years live photos carry, newest first. */
export async function listGalleryYears(database: Database, limit: number): Promise<number[]> {
  const rows = await database.db
    .selectDistinct({ year: media.effectiveYear })
    .from(media)
    .where(and(isNotNull(media.effectiveYear), live))
    .orderBy(desc(media.effectiveYear))
    .limit(limit);
  return rows.flatMap((row) => (row.year === null ? [] : [row.year]));
}

/** R-MEM-18: counted over the default gallery index, on the admin screen only. */
export async function countPhotos(database: Database): Promise<number> {
  const [row] = await database.db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(media)
    .where(live)
    .limit(1);
  return row?.count ?? 0;
}

export async function insertAlbum(
  database: Database,
  createdBy: string,
  input: { name: string; yearTag?: number | null; description?: string | null },
  now: number,
) {
  const row = {
    id: uuidv7(now),
    name: input.name,
    yearTag: input.yearTag ?? null,
    description: input.description || null,
    createdBy,
    createdAt: now,
  };
  await database.db.insert(albums).values(row);
  return row;
}

/** R-BUD-08: rows one year-tag rewrite statement may touch, and per request. */
export const YEAR_REWRITE_CHUNK = 500;
export const YEAR_REWRITE_LIMIT = 20_000;

/** The next ≤ 500 live photos of the album whose `effective_year` is stale. */
function rewriteYearChunk(database: Database, albumId: string, yearTag: number | null) {
  const target = sql`coalesce(${yearTag}, ${media.takenYear})`;
  const stale = database.db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.albumId, albumId), live, sql`${media.effectiveYear} is not ${target}`))
    .limit(YEAR_REWRITE_CHUNK);
  return database.db.update(media).set({ effectiveYear: target }).where(inArray(media.id, stale));
}

/**
 * R-MEM-14 / R-BUD-08: a new year tag rewrites the album's photos' `effective_year`;
 * the album row and the first chunk go in one batch, later chunks follow until none
 * are stale or the per-request cap is reached. Each chunk picks only stale rows, so a
 * retry or the next PATCH finishes an interrupted rewrite.
 */
export async function updateAlbum(database: Database, id: string, patch: AlbumPatch) {
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.yearTag !== undefined ? { yearTag: patch.yearTag } : {}),
    ...(patch.description !== undefined ? { description: patch.description || null } : {}),
  };
  const update = database.db.update(albums).set(set).where(eq(albums.id, id));
  if (patch.yearTag === undefined) return void (await update);
  const yearTag = patch.yearTag ?? null;
  const [, first] = await database.batch([update, rewriteYearChunk(database, id, yearTag)]);
  let changed = first?.changes ?? 0;
  let written = changed;
  while (changed === YEAR_REWRITE_CHUNK && written < YEAR_REWRITE_LIMIT) {
    changed = (await database.batch([rewriteYearChunk(database, id, yearTag)]))[0]?.changes ?? 0;
    written += changed;
  }
}

/** A moved photo takes its new album's year tag, else its own `taken_year` (R-MEM-14). */
export async function updatePhoto(database: Database, id: string, patch: MediaPatch) {
  const albumYear = patch.albumId
    ? sql`(select ${albums.yearTag} from ${albums} where ${albums.id} = ${patch.albumId})`
    : sql`null`;
  const result = await database.db
    .update(media)
    .set({
      ...(patch.caption !== undefined ? { caption: patch.caption || null } : {}),
      ...(patch.albumId !== undefined
        ? {
            albumId: patch.albumId,
            effectiveYear: sql`coalesce(${albumYear}, ${media.takenYear})`,
          }
        : {}),
    })
    .where(and(eq(media.id, id), live))
    .returning({ id: media.id });
  return result.length > 0;
}

/** R-MEM-20: hidden at once; the objects and their bytes stay until housekeeping purges. */
export async function softDeletePhoto(database: Database, id: string, now: number) {
  const result = await database.db
    .update(media)
    .set({ deletedAt: now })
    .where(and(eq(media.id, id), live))
    .returning({ id: media.id });
  return result.length > 0;
}
