import { errorBodySchema, type ErrorCode } from '../contracts/errors';
import type { Encoded } from './image/encode';

// §7.2 from the browser: reserve → PUT image (and thumb) → complete, one file at a
// time so a member never holds more than one of their two open reservations (R-MEM-13).
// Any failure after the reservation releases it (R-MEM-10).

export type UploadFailure =
  | 'storage_full'
  | 'rate_limited'
  | 'validation'
  | 'payload_too_large'
  | 'conflict'
  | 'denied'
  | 'locked'
  | 'unavailable'
  | 'network'
  | 'internal';

export class UploadError extends Error {
  constructor(readonly code: UploadFailure) {
    super(code);
  }
}

export interface CompleteFields {
  caption?: string;
  albumId?: string;
  takenYear?: number;
}

const BASE = '/api/v1/media/reservations';
/** No request waits forever; a PUT gets longer for a slow phone connection. */
const JSON_TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 120_000;

/** R-API-02: the body's stable `code` decides; the status answers when the body has none. */
const byCode: Record<ErrorCode, UploadFailure> = {
  unauthenticated: 'denied',
  forbidden: 'denied',
  feature_disabled: 'denied',
  locked: 'locked',
  // A reservation that expired or was released answers 404 (R-MEM-11).
  not_found: 'conflict',
  conflict: 'conflict',
  validation: 'validation',
  rate_limited: 'rate_limited',
  storage_full: 'storage_full',
  payload_too_large: 'payload_too_large',
  unavailable: 'unavailable',
  internal: 'internal',
};

const byStatus: Record<number, UploadFailure> = {
  400: 'validation',
  401: 'denied',
  403: 'denied',
  404: 'conflict',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'validation',
  423: 'locked',
  429: 'rate_limited',
  503: 'unavailable',
  507: 'storage_full',
};

/** Exported for its unit test: the failure a refused response stands for. */
export async function failureOf(response: Response): Promise<UploadFailure> {
  const body = errorBodySchema.safeParse(await response.json().catch(() => null));
  if (body.success) return byCode[body.data.error.code];
  return byStatus[response.status] ?? 'internal';
}

async function send(path: string, init: RequestInit, timeout = JSON_TIMEOUT_MS) {
  let response: Response;
  try {
    response = await fetch(path, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new UploadError('network');
  }
  if (!response.ok) throw new UploadError(await failureOf(response));
  return response;
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Uploads one encoded picture and answers its media id; `progress` runs from 0 to 1. */
export async function uploadEncoded(
  encoded: Encoded,
  purpose: 'photo' | 'avatar',
  fields: CompleteFields,
  progress: (fraction: number) => void = () => undefined,
): Promise<string> {
  const reserved = (await (
    await send(BASE, {
      method: 'POST',
      ...json({
        purpose,
        imageBytes: encoded.image.size,
        thumbBytes: encoded.thumb?.size ?? 0,
        sha256: encoded.sha256,
        thumbSha256: encoded.thumbSha256,
        mimeType: encoded.mimeType,
        width: encoded.width,
        height: encoded.height,
      }),
    })
  ).json()) as { id: string };
  progress(0.05);
  try {
    const total = encoded.image.size + (encoded.thumb?.size ?? 0);
    const put = (variant: 'image' | 'thumb', blob: Blob) =>
      send(
        `${BASE}/${reserved.id}/${variant}`,
        { method: 'PUT', headers: { 'content-type': encoded.mimeType }, body: blob },
        PUT_TIMEOUT_MS,
      );
    await put('image', encoded.image);
    progress(0.05 + (0.9 * encoded.image.size) / total);
    if (encoded.thumb) await put('thumb', encoded.thumb);
    progress(0.95);
    const completed = (await (
      await send(`${BASE}/${reserved.id}/complete`, { method: 'POST', ...json(fields) })
    ).json()) as { id: string };
    progress(1);
    return completed.id;
  } catch (error) {
    // Best effort: an unreleased reservation expires and housekeeping sweeps it (R-MEM-11).
    await fetch(`${BASE}/${reserved.id}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    }).catch(() => undefined);
    throw error instanceof UploadError ? error : new UploadError('internal');
  }
}

/** R-MEM-13: points the profile at a completed avatar; the server retires the one before. */
export async function setAvatar(mediaId: string): Promise<void> {
  await send('/api/v1/me', { method: 'PATCH', ...json({ avatarMediaId: mediaId }) });
}
