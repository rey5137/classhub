import { and, desc, eq, inArray, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import type { AlbumPatch, MediaPatch } from '../../contracts/media';
import { albums, media, profileContacts, schemaMeta, users } from '../db/schema';
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
// `live` for a query that must walk `media_album_idx`: the unary plus keeps the planner off
// `media_type_deleted_created_idx`, which would read every live photo of every album.
const liveInAlbum = and(sql`+${media.mediaType} = 'photo'`, sql`+${media.deletedAt} is null`);

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
  const rawRows = await database.db
    .select({
      id: media.id,
      ownerId: media.ownerId,
      caption: media.caption,
      albumId: media.albumId,
      year: media.effectiveYear,
      width: media.width,
      height: media.height,
      createdAt: media.createdAt,
    })
    .from(media)
    .where(and(...conditions))
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(options.limit + 1);
  const slice = rawRows.slice(0, options.limit);
  if (slice.length === 0) return { rows: [], more: false };
  const ownerIds = [...new Set(slice.map((row) => row.ownerId))];
  const albumIds = [...new Set(slice.flatMap((row) => (row.albumId ? [row.albumId] : [])))];
  const [ownerRows, albumRows] = await Promise.all([
    database.db
      .select({
        id: users.id,
        displayName: users.displayName,
        status: users.status,
        preferredName: users.preferredName,
        avatarMediaId: users.avatarMediaId,
        deletionRequestedAt: users.deletionRequestedAt,
        visibilityJson: profileContacts.visibilityJson,
      })
      .from(users)
      .leftJoin(profileContacts, eq(profileContacts.userId, users.id))
      .where(inArray(users.id, ownerIds)),
    albumIds.length > 0
      ? database.db
          .select({ id: albums.id, name: albums.name })
          .from(albums)
          .where(inArray(albums.id, albumIds))
      : Promise.resolve([]),
  ]);
  const ownersById = new Map(ownerRows.map((owner) => [owner.id, owner]));
  const albumsById = new Map(albumRows.map((album) => [album.id, album.name]));
  const rows: GalleryRow[] = slice.flatMap((row) => {
    const owner = ownersById.get(row.ownerId);
    if (!owner) return [];
    return [
      toRow({
        ...row,
        albumName: row.albumId ? (albumsById.get(row.albumId) ?? null) : null,
        displayName: owner.displayName,
        status: owner.status,
        preferredName: owner.preferredName,
        avatarMediaId: owner.avatarMediaId,
        deletionRequestedAt: owner.deletionRequestedAt,
        visibilityJson: owner.visibilityJson,
      }),
    ];
  });
  return { rows, more: rawRows.length > options.limit };
}

export async function findGalleryPhoto(database: Database, id: string) {
  const [row] = await select(database)
    .where(and(eq(media.id, id), live))
    .limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * The year chips: the years live photos carry, newest first. A skip-scan over
 * `media_effective_year_idx` (each step jumps to the next lower year), so the read scales with
 * the number of years, not photos (R-BUD-01); `select distinct` would read every photo.
 */
export async function listGalleryYears(database: Database, limit: number): Promise<number[]> {
  const liveYear = sql`${media.mediaType} = 'photo' and ${media.deletedAt} is null`;
  const rows = await database.db.all<{ year: number | null }>(sql`
    with recursive years(year) as (
      select max(${media.effectiveYear}) from ${media} indexed by media_effective_year_idx
        where ${liveYear}
      union all
      select (select max(${media.effectiveYear}) from ${media} indexed by media_effective_year_idx
        where ${media.effectiveYear} < years.year and ${liveYear})
      from years where years.year is not null
    )
    select year from years where year is not null limit ${limit}`);
  return rows.flatMap((row) => (row.year === null ? [] : [Number(row.year)]));
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
/** R-MEM-14: `,id,id,` of the albums whose year-tag rewrite may be unfinished; row absent when none. */
export const YEAR_REWRITE_FLAG = 'year_rewrite_pending';

/**
 * The one stale-year predicate (R-MEM-14): the next ≤ 500 live photos of the album whose
 * `effective_year` differs from the album's current year tag, else their own `taken_year`.
 * Read through `media_album_idx`, so it never scans other albums' photos.
 */
export function staleYearRows(database: Database, albumId: string) {
  return database.db
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        eq(media.albumId, albumId),
        liveInAlbum,
        sql`${media.effectiveYear} is not ${albumYear(albumId)}`,
      ),
    )
    .limit(YEAR_REWRITE_CHUNK);
}

function albumYear(albumId: string) {
  return sql`coalesce((select ${albums.yearTag} from ${albums} where ${albums.id} = ${albumId}), ${media.takenYear})`;
}

function rewriteYearChunk(database: Database, albumId: string) {
  return database.db
    .update(media)
    .set({ effectiveYear: albumYear(albumId) })
    .where(inArray(media.id, staleYearRows(database, albumId)));
}

/**
 * R-MEM-14 / R-BUD-08: a new year tag rewrites the album's photos' `effective_year`;
 * the album row and the first chunk go in one batch, later chunks follow until none
 * are stale or the per-request cap is reached. Each chunk picks only stale rows, so a
 * retry, the next PATCH or the flagged housekeeping sweep finishes an interrupted rewrite.
 * The album's id joins the flag's pending list; only housekeeping removes it.
 */
export async function updateAlbum(database: Database, id: string, patch: AlbumPatch) {
  const set = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.yearTag !== undefined ? { yearTag: patch.yearTag } : {}),
    ...(patch.description !== undefined ? { description: patch.description || null } : {}),
  };
  const update = database.db.update(albums).set(set).where(eq(albums.id, id));
  if (patch.yearTag === undefined) return void (await update);
  // The id goes in with the album row, so a request that dies after any chunk is finished by housekeeping.
  const flag = database.db
    .insert(schemaMeta)
    .values({ key: YEAR_REWRITE_FLAG, value: `,${id},` })
    .onConflictDoUpdate({
      target: schemaMeta.key,
      set: {
        value: sql`case when instr(${schemaMeta.value}, ${`,${id},`}) > 0 then ${schemaMeta.value} else ${schemaMeta.value} || ${`${id},`} end`,
      },
    });
  const [, , first] = await database.batch([update, flag, rewriteYearChunk(database, id)]);
  let changed = first?.changes ?? 0;
  let written = changed;
  while (changed === YEAR_REWRITE_CHUNK && written < YEAR_REWRITE_LIMIT) {
    changed = (await database.batch([rewriteYearChunk(database, id)]))[0]?.changes ?? 0;
    written += changed;
  }
}

/**
 * R-MEM-14: while the flag lists an album, finish one interrupted rewrite chunk of the first
 * listed album per housekeeping run (the same `staleYearRows` predicate as the PATCH). The
 * album's id leaves the list in the same batch once no stale photo remains, and the row is
 * deleted when the list is empty.
 */
export async function finishYearRewrite(database: Database) {
  const [flag] = await database.db
    .select({ value: schemaMeta.value })
    .from(schemaMeta)
    .where(eq(schemaMeta.key, YEAR_REWRITE_FLAG))
    .limit(1);
  if (!flag) return;
  // Anything but `,id,…,` (a leftover `1`) names no album: drop it, no work this run.
  const albumId = /^(?:,[^,]+)+,$/.test(flag.value) ? flag.value.split(',')[1] : undefined;
  if (!albumId) {
    await database.db.delete(schemaMeta).where(eq(schemaMeta.key, YEAR_REWRITE_FLAG));
    return;
  }
  await database.batch([
    rewriteYearChunk(database, albumId),
    database.db
      .update(schemaMeta)
      .set({ value: sql`replace(${schemaMeta.value}, ${`,${albumId},`}, ',')` })
      .where(
        and(eq(schemaMeta.key, YEAR_REWRITE_FLAG), notExists(staleYearRows(database, albumId))),
      ),
    database.db
      .delete(schemaMeta)
      .where(and(eq(schemaMeta.key, YEAR_REWRITE_FLAG), eq(schemaMeta.value, ','))),
  ]);
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
