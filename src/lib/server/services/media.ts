import { siteConfig } from '../../config';
import {
  completeSchema,
  mediaCompleteResponseSchema,
  mediaMimeSchema,
  mediaMutationResponseSchema,
  mediaPathSchema,
  reservationPathSchema,
  reservationResponseSchema,
  reservationSchema,
  type MediaVariant,
} from '../../contracts/media';
import type { Member } from '../auth/membership';
import { can } from '../auth/permissions';
import type { AppContext } from '../context';
import { ObjectTooLargeError } from '../ports/object-storage';
import { findProfile } from '../repositories/profiles';
import {
  completeReservation,
  finalKeys,
  findAlbum,
  findLiveMedia,
  findMedia,
  findReservation,
  releaseReservation,
  reservationKeys,
  reserve,
  soonestOpenExpiry,
  uploadLimited,
  type Reservation,
  type StoredMedia,
} from '../repositories/media';
import { parse, type AdminFailure, type AdminResult } from './admin';
import { projectProfile } from './projection';

const forbidden: AdminFailure = { ok: false, code: 'forbidden' };
const conflict: AdminFailure = { ok: false, code: 'conflict' };
const invalid: AdminFailure = { ok: false, code: 'validation' };
const notFound: AdminFailure = { ok: false, code: 'not_found' };
class InvalidImage extends Error {}

/** R-MEM-08: sniff before forwarding any byte, keeping only the signature across chunks. */
function imageStream(body: ReadableStream<Uint8Array>, mime: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const length = mime === 'image/webp' ? 12 : 3;
  const signature = new Uint8Array(length);
  let filled = 0;
  let checked = false;
  let tail: Uint8Array | undefined;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (tail) {
          controller.enqueue(tail);
          tail = undefined;
          return;
        }
        while (!checked) {
          const { value, done } = await reader.read();
          if (done) throw new InvalidImage();
          const take = Math.min(length - filled, value.byteLength);
          signature.set(value.subarray(0, take), filled);
          filled += take;
          if (filled < length) continue;
          const matches =
            mime === 'image/jpeg'
              ? signature[0] === 255 && signature[1] === 216 && signature[2] === 255
              : String.fromCharCode(...signature.subarray(0, 4)) === 'RIFF' &&
                String.fromCharCode(...signature.subarray(8, 12)) === 'WEBP';
          if (!matches) throw new InvalidImage();
          checked = true;
          if (take < value.byteLength) tail = value.subarray(take);
          controller.enqueue(signature);
          return;
        }
        const { value, done } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      reader.releaseLock();
    },
  });
}

/** The staging key, declared size and hash of one variant of a reservation. */
function reservedVariant(row: Reservation, variant: MediaVariant) {
  return variant === 'image'
    ? { key: row.objectKey, expected: row.imageBytes, hash: row.sha256 }
    : { key: row.thumbKey, expected: row.thumbBytes, hash: row.thumbSha256 };
}

function reservationAccess(
  row: Reservation | undefined,
  member: Member,
  now: number,
): AdminFailure | null {
  if (!row || row.ownerId !== member.id) return forbidden;
  return row.state !== 'open' || row.expiresAt <= now ? conflict : null;
}

/** R-MEM-13: a concurrent slot frees when its reservation expires; the daily count has no single moment, so 900 s. */
async function uploadRefusal(
  context: AppContext,
  member: Member,
  reason: 'daily' | 'concurrent',
  now: number,
): Promise<AdminFailure> {
  const soonest =
    reason === 'concurrent' ? await soonestOpenExpiry(context.database, member.id, now) : null;
  const retryAfterSeconds =
    soonest === null ? 900 : Math.min(900, Math.max(1, Math.ceil((soonest - now) / 1000)));
  return {
    ok: false,
    code: 'rate_limited',
    reason,
    messageKey: `upload.error.rate_limited_${reason}`,
    retryAfterSeconds,
  };
}

export async function createReservation(
  context: AppContext,
  member: Member,
  input: unknown,
  now = Date.now(),
): Promise<AdminResult<unknown>> {
  if (!can(member, 'content.create')) return forbidden;
  const parsed = parse(reservationSchema, input);
  if (!parsed.ok) return parsed;
  if (parsed.data.purpose === 'site' && !can(member, 'settings.edit')) return forbidden;
  const limited = await uploadLimited(context.database, member.id, parsed.data.purpose, now);
  if (limited) return uploadRefusal(context, member, limited, now);
  const row = await reserve(context.database, member.id, parsed.data, now);
  if (!row) {
    const raced = await uploadLimited(context.database, member.id, parsed.data.purpose, now);
    if (raced) return uploadRefusal(context, member, raced, now);
    return { ok: false, code: 'storage_full' };
  }
  return { ok: true, status: 201, body: reservationResponseSchema.parse(row) };
}

export async function uploadVariant(
  context: AppContext,
  member: Member,
  params: unknown,
  request: Request,
  now = Date.now(),
): Promise<AdminResult<unknown>> {
  const parsed = parse(mediaPathSchema, params);
  if (!parsed.ok) return parsed;
  const row = await findReservation(context.database, parsed.data.id);
  const refusal = reservationAccess(row, member, now);
  if (refusal || !row) return refusal ?? forbidden;
  const { key, expected, hash } = reservedVariant(row, parsed.data.variant);
  if (!key) return notFound;
  const mime = request.headers.get('content-type');
  if (!mediaMimeSchema.safeParse(mime).success || mime !== row.mimeType || !request.body)
    return invalid;
  try {
    const measured = await context.storage.put(key, imageStream(request.body, row.mimeType), {
      contentType: row.mimeType,
      maxBytes: Math.min(expected, siteConfig.uploads.maxImageBytes),
    });
    if (measured.size !== expected || measured.sha256 !== hash) throw new InvalidImage();
  } catch (error) {
    await context.storage.delete([key]);
    if (error instanceof InvalidImage) return invalid;
    if (error instanceof ObjectTooLargeError) return { ok: false, code: 'payload_too_large' };
    throw error;
  }
  return { ok: true, status: 200, body: mediaMutationResponseSchema.parse({ ok: true }) };
}

export async function finishReservation(
  context: AppContext,
  member: Member,
  params: unknown,
  input: unknown,
  now = Date.now(),
): Promise<AdminResult<unknown>> {
  const path = parse(reservationPathSchema, params);
  if (!path.ok) return path;
  const parsed = parse(completeSchema, input);
  if (!parsed.ok) return parsed;
  const row = await findReservation(context.database, path.data.id);
  const refusal = reservationAccess(row, member, now);
  if (refusal || !row) return refusal ?? forbidden;
  if (!row.mediaId) return conflict;
  if (parsed.data.albumId && !(await findAlbum(context.database, parsed.data.albumId)))
    return invalid;
  const keys = finalKeys(row);
  const variants: MediaVariant[] = row.purpose === 'avatar' ? ['image'] : ['image', 'thumb'];
  const finals = [keys.objectKey, keys.thumbKey].filter(Boolean);
  const cleanFinals = async () => {
    // A racing complete may already own these immutable keys. Its objects must survive.
    const current = await findReservation(context.database, row.id);
    if (current?.state !== 'open' && !(await findMedia(context.database, row.mediaId!)))
      await context.storage.delete(finals);
  };
  try {
    for (const variant of variants) {
      const { key, expected } = reservedVariant(row, variant);
      const head = await context.storage.head(key);
      if (!head || head.size !== expected || head.contentType !== row.mimeType)
        throw new InvalidImage();
    }
    for (const variant of variants) {
      const { key, expected, hash } = reservedVariant(row, variant);
      const destination = variant === 'image' ? keys.objectKey : keys.thumbKey;
      const object = await context.storage.get(key);
      if (!object?.body) throw new InvalidImage();
      const measured = await context.storage.put(
        destination,
        imageStream(object.body, row.mimeType),
        { contentType: row.mimeType, maxBytes: expected },
      );
      if (measured.size !== expected || measured.sha256 !== hash) throw new InvalidImage();
    }
    if (!(await completeReservation(context.database, row, parsed.data, Date.now()))) {
      await cleanFinals();
      return conflict;
    }
  } catch (error) {
    await cleanFinals();
    if (error instanceof InvalidImage || error instanceof ObjectTooLargeError) {
      await context.storage.delete(reservationKeys(row));
      return invalid;
    }
    throw error;
  }
  // R-MEM-09: after commit a failed staging delete is left to housekeeping.
  await context.storage.delete(reservationKeys(row)).catch(() => undefined);
  return { ok: true, status: 201, body: mediaCompleteResponseSchema.parse({ id: row.mediaId }) };
}

export async function abandonReservation(
  context: AppContext,
  member: Member,
  params: unknown,
  now = Date.now(),
): Promise<AdminResult<unknown>> {
  const parsed = parse(reservationPathSchema, params);
  if (!parsed.ok) return parsed;
  const row = await findReservation(context.database, parsed.data.id);
  if (!row || row.ownerId !== member.id) return forbidden;
  await releaseReservation(context.database, row, now);
  await context.storage.delete(reservationKeys(row));
  return { ok: true, status: 200, body: mediaMutationResponseSchema.parse({ ok: true }) };
}

/** R-MEM-16: an avatar's bytes follow the owner's current, projected avatar, like every payload (INV-5). */
async function avatarShownTo(context: AppContext, viewer: Member, row: StoredMedia) {
  const owner = await findProfile(context.database.db, row.ownerId);
  return (
    !!owner &&
    owner.avatarMediaId === row.id &&
    projectProfile(viewer, owner).avatarMediaId === row.id
  );
}

export async function deliverMedia(
  context: AppContext,
  member: Member,
  params: unknown,
  request: Request,
): Promise<Response | AdminFailure> {
  if (!can(member, 'content.read')) return forbidden;
  const parsed = parse(mediaPathSchema, params);
  if (!parsed.ok) return parsed;
  const row = await findLiveMedia(context.database, parsed.data.id);
  if (!row || !mediaMimeSchema.safeParse(row.mimeType).success) return notFound;
  if (row.mediaType === 'avatar' && !(await avatarShownTo(context, member, row))) return notFound;
  const variant = parsed.data.variant;
  const key = variant === 'image' ? row.objectKey : row.thumbKey;
  if (!key) return notFound;
  const hash = variant === 'image' ? row.sha256 : row.thumbSha256;
  const headers = new Headers({
    'cache-control':
      variant === 'thumb' || row.mediaType === 'avatar'
        ? 'private, max-age=300'
        : 'private, no-cache',
    etag: `"${hash}"`,
    'content-type': row.mimeType,
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
  });
  // R-MEM-17: multipart R2 objects have no stored validator. A 304 must not read storage.
  const validators =
    request.headers
      .get('if-none-match')
      ?.split(',')
      .map((value) => value.trim().replace(/^W\//, '')) ?? [];
  if (validators.includes('*') || validators.includes(`"${hash}"`))
    return new Response(null, { status: 304, headers });
  const object = await context.storage.get(key);
  if (!object?.body) return notFound;
  headers.set('content-length', String(variant === 'image' ? row.sizeBytes : row.thumbSizeBytes));
  return new Response(object.body, { headers });
}
