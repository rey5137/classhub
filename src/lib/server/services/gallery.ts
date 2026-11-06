import { siteConfig } from '../../config';
import {
  albumCreateSchema,
  albumPatchSchema,
  albumSchema,
  galleryItemSchema,
  galleryPageSchema,
  galleryQuerySchema,
  mediaIdSchema,
  mediaMutationResponseSchema,
  mediaPatchSchema,
  type Album,
  type GalleryItem,
  type GalleryPage,
} from '../../contracts/media';
import type { Features } from '../../contracts/settings';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import { decodeCursor, encodeCursor } from '../cursor';
import {
  countPhotos,
  findGalleryPhoto,
  insertAlbum,
  listGallery,
  listGalleryYears,
  softDeletePhoto,
  updateAlbum,
  updatePhoto,
  type GalleryRow,
} from '../repositories/gallery';
import {
  findAlbum,
  findLiveMedia,
  listAlbumChoices,
  readStorageUsage,
} from '../repositories/media';
import { softDeleteUnusedSiteMedia } from '../repositories/settings';
import { readOperations } from '../repositories/operations';
import { parse, type AdminFailure, type AdminResult } from './admin';
import { monthKey } from './operations';
import { projectProfile } from './projection';

// R-MEM-14, R-MEM-20 and §3.3: the gallery, albums and a photo's edits, shared by
// `/api/v1/albums`, `/api/v1/media` and the `/memories` form actions.

export const GALLERY_PAGE = 30;
const YEAR_CHIPS = 50;
// One answer for an unknown, deleted or someone else's photo or album, so a refusal
// never says whether the id exists.
const denied: AdminFailure = { ok: false, code: 'forbidden' };
const invalidAlbum: AdminFailure = { ok: false, code: 'validation', fields: { albumId: 'custom' } };

function toItem(viewer: Member, row: GalleryRow): GalleryItem {
  // INV-5: the uploader goes through the one projection, like every member payload.
  const { id, displayName, avatarMediaId } = projectProfile(viewer, row.owner);
  return galleryItemSchema.parse({
    id: row.id,
    caption: row.caption,
    album: row.albumId && row.albumName ? { id: row.albumId, name: row.albumName } : null,
    year: row.year,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    uploader: { id, displayName, ...(avatarMediaId ? { avatarMediaId } : {}) },
    canEdit: can(viewer, 'content.edit', { ownerId: row.ownerId }),
  });
}

function decodeGalleryCursor(cursor: string): { createdAt: number; id: string } | null {
  const value = decodeCursor(cursor);
  return value?.length === 2 && Number.isSafeInteger(value[0]) && typeof value[1] === 'string'
    ? { createdAt: value[0] as number, id: value[1] }
    : null;
}

/** `GET /api/v1/media?album=&year=&cursor=` (R-MEM-14, R-DB-07). */
export async function listPhotos(
  context: AppContext,
  viewer: Member,
  input: unknown,
): Promise<AdminResult<GalleryPage>> {
  if (!can(viewer, 'content.read')) return denied;
  const parsed = parse(galleryQuerySchema, input);
  if (!parsed.ok) return parsed;
  const after = parsed.data.cursor ? decodeGalleryCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor && !after)
    return { ok: false, code: 'validation', fields: { cursor: 'custom' } };
  const { rows, more } = await listGallery(context.database, {
    albumId: parsed.data.album,
    year: parsed.data.year,
    after,
    limit: GALLERY_PAGE,
  });
  const last = rows.at(-1);
  return {
    ok: true,
    status: 200,
    body: galleryPageSchema.parse({
      items: rows.map((row) => toItem(viewer, row)),
      nextCursor: more && last ? encodeCursor([last.createdAt, last.id]) : null,
    }),
  };
}

/** `/memories/[id]`: a live photo, or `undefined` for anything else. */
export async function getPhoto(context: AppContext, viewer: Member, id: string) {
  if (!can(viewer, 'content.read') || !mediaIdSchema.safeParse({ id }).success) return undefined;
  const row = await findGalleryPhoto(context.database, id);
  return row ? toItem(viewer, row) : undefined;
}

export async function listYears(context: AppContext, viewer: Member): Promise<number[]> {
  return can(viewer, 'content.read') ? listGalleryYears(context.database, YEAR_CHIPS) : [];
}

/** `GET /api/v1/albums`: every album by name, with whether the viewer may edit it. */
export async function listAlbums(context: AppContext, viewer: Member): Promise<Album[]> {
  if (!can(viewer, 'content.read')) return [];
  const rows = await listAlbumChoices(context.database);
  return rows.map((row) =>
    albumSchema.parse({
      id: row.id,
      name: row.name,
      yearTag: row.yearTag,
      description: row.description,
      canEdit: can(viewer, 'album.edit', { ownerId: row.createdBy }),
    }),
  );
}

export async function createAlbum(
  context: AppContext,
  member: Member,
  input: unknown,
  now = Date.now(),
): Promise<AdminResult<Album>> {
  if (!can(member, 'album.create')) return denied;
  const parsed = parse(albumCreateSchema, input);
  if (!parsed.ok) return parsed;
  const row = await insertAlbum(context.database, member.id, parsed.data, now);
  return {
    ok: true,
    status: 201,
    body: albumSchema.parse({ ...row, canEdit: true }),
  };
}

/** `PATCH /api/v1/albums/:id`: creator or admin (§3.3). */
export async function editAlbum(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
): Promise<AdminResult<unknown>> {
  const path = parse(mediaIdSchema, params);
  if (!path.ok) return denied;
  const album = await findAlbum(context.database, path.data.id);
  if (!album || !can(member, 'album.edit', { ownerId: album.createdBy })) return denied;
  const parsed = parse(albumPatchSchema, input);
  if (!parsed.ok) return parsed;
  await updateAlbum(context.database, album.id, parsed.data);
  return { ok: true, status: 200, body: mediaMutationResponseSchema.parse({ ok: true }) };
}

async function ownPhoto(
  context: AppContext,
  member: Member,
  params: unknown,
  action: 'edit' | 'delete',
) {
  const path = parse(mediaIdSchema, params);
  if (!path.ok) return null;
  const row = await findGalleryPhoto(context.database, path.data.id);
  if (!row) return null;
  return can(member, action === 'edit' ? 'content.edit' : 'content.delete', {
    ownerId: row.ownerId,
  })
    ? row
    : null;
}

/** `PATCH /api/v1/media/:id`: caption and album, owner or admin (R-MEM-14). */
export async function editPhoto(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
  features: Features,
): Promise<AdminResult<unknown>> {
  const row = await ownPhoto(context, member, params, 'edit');
  // R-NAV-02: with memories off a photo answers like an unknown id, so ids can't be probed.
  if (!row || !features.memories) return denied;
  const parsed = parse(mediaPatchSchema, input);
  if (!parsed.ok) return parsed;
  if (parsed.data.albumId && !(await findAlbum(context.database, parsed.data.albumId)))
    return invalidAlbum;
  if (!(await updatePhoto(context.database, row.id, parsed.data))) return denied;
  return { ok: true, status: 200, body: mediaMutationResponseSchema.parse({ ok: true }) };
}

/** `DELETE /api/v1/media/:id`: owner or admin; a second delete finds nothing (R-MEM-20). */
export async function deletePhoto(
  context: AppContext,
  member: Member,
  params: unknown,
  features: Features,
  now = Date.now(),
): Promise<AdminResult<unknown>> {
  const row = await ownPhoto(context, member, params, 'delete');
  // R-NAV-02: a site picture is not the gallery's, so it goes whatever the memories flag.
  if (!row) return deleteSiteMedia(context, member, params, now);
  // A gallery photo with memories off answers like an unknown id (no probing).
  if (!features.memories) return denied;
  if (!(await softDeletePhoto(context.database, row.id, now))) return denied;
  return { ok: true, status: 200, body: mediaMutationResponseSchema.parse({ ok: true }) };
}

/** R-UI-01: an admin removes an unused site picture; one a setting still names is refused. */
async function deleteSiteMedia(
  context: AppContext,
  member: Member,
  params: unknown,
  now: number,
): Promise<AdminResult<unknown>> {
  const path = parse(mediaIdSchema, params);
  if (!path.ok || !can(member, 'settings.edit')) return denied;
  const row = await findLiveMedia(context.database, path.data.id);
  if (row?.mediaType !== 'site') return denied;
  if (!(await softDeleteUnusedSiteMedia(context.database, row.id, now))) {
    return { ok: false, code: 'conflict', messageKey: 'admin.refusal.site_media_in_use' };
  }
  return { ok: true, status: 200, body: mediaMutationResponseSchema.parse({ ok: true }) };
}

/** R-MEM-18: the `/admin` usage card. */
export async function usageSummary(context: AppContext, member: Member, now = Date.now()) {
  if (!can(member, 'usage.view')) return null;
  const month = monthKey(now);
  const [usage, photos, operations] = await Promise.all([
    readStorageUsage(context.database),
    countPhotos(context.database),
    readOperations(context.database, month),
  ]);
  const used = usage.committedBytes + usage.reservedBytes;
  return {
    committedBytes: usage.committedBytes,
    reservedBytes: usage.reservedBytes,
    usedBytes: used,
    warnBytes: siteConfig.limits.mediaWarnBytes,
    stopBytes: siteConfig.limits.mediaStopBytes,
    warning: used >= siteConfig.limits.mediaWarnBytes,
    photos,
    lastReconciledAt: usage.lastReconciledAt,
    operations,
  };
}

/** R-MEM-15: whether this request's admin sees the storage banner; members never read it. */
export async function storageWarning(context: AppContext, member: Member): Promise<boolean> {
  if (!can(member, 'usage.view')) return false;
  const usage = await readStorageUsage(context.database);
  return usage.committedBytes + usage.reservedBytes >= siteConfig.limits.mediaWarnBytes;
}
