// §7.1: the pure decisions of the browser encoder, kept apart from canvas and worker
// code so they can be unit tested in Node.

export type InputKind = 'jpeg' | 'png' | 'webp' | 'heic';
export type OutputMime = 'image/webp' | 'image/jpeg';
export type Refusal = 'unsupported' | 'heic_undecodable' | 'undecodable' | 'too_large';

/** R-MEM-03: image + thumbnail, in the decimal units of `site.config.ts`. */
export const PHOTO_TARGET_BYTES = 2_000_000;
export const THUMB_EDGE = 480;
export const THUMB_QUALITY = 0.75;
/** R-MEM-13: one square, no thumbnail. */
export const AVATAR_EDGE = 512;
export const AVATAR_QUALITY = 0.82;
/** The file picker's `accept` list: what `sniffKind` can recognise (R-MEM-01). */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
/** How many leading bytes `sniffKind` needs. */
export const SNIFF_BYTES = 16;

export interface EncodeStep {
  edge: number;
  quality: number;
}

/** R-MEM-02, R-MEM-03: the first attempt, then quality 0.70, then a 1600 px long edge. */
export const PHOTO_STEPS: readonly EncodeStep[] = [
  { edge: 2000, quality: 0.82 },
  { edge: 2000, quality: 0.7 },
  { edge: 1600, quality: 0.7 },
];

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const HEIC_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

/**
 * R-MEM-01: what the file is, by its first bytes. The declared type and name only
 * matter for HEIC, which a browser may hand over with an empty type; anything without
 * a known signature is refused whatever it claims to be.
 */
export function sniffKind(head: Uint8Array, mime: string, name: string): InputKind | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (ascii(head, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'webp';
  if (ascii(head, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(head, 8, 12))) return 'heic';
  // A HEIC whose brand we don't list still gets its decode attempt, and its own reason.
  if (HEIC_TYPES.has(mime.toLowerCase()) || /\.hei[cf]$/i.test(name)) return 'heic';
  return null;
}

/** The reason shown when a file of this kind can't be decoded. */
export const decodeRefusal = (kind: InputKind): Refusal =>
  kind === 'heic' ? 'heic_undecodable' : 'undecodable';

/** Scale to a long edge of at most `edge`, never up, never below 1 px. */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** R-MEM-03: the step to try after `index` produced `combined` bytes. */
export function nextStep(index: number, combined: number): 'done' | 'refuse' | number {
  if (combined <= PHOTO_TARGET_BYTES) return 'done';
  return index + 1 < PHOTO_STEPS.length ? index + 1 : 'refuse';
}

/**
 * R-MEM-02: the type an encoder really produced. A canvas that can't write WebP hands
 * back PNG instead of failing, so the output's type, not the request, decides.
 */
export function encodedMime(blobType: string): OutputMime | null {
  return blobType === 'image/webp' || blobType === 'image/jpeg' ? blobType : null;
}

export interface SquareCrop {
  x: number;
  y: number;
  size: number;
}

/** The largest zoom the avatar crop offers; past it a 512 px square would be upscaled a lot. */
export const MAX_ZOOM = 4;

/**
 * R-MEM-13: the square cut from a `width`×`height` image at `zoom` (1 = the shorter
 * side), centred on the fractions `centerX`, `centerY` and kept inside the image.
 */
export function squareCrop(
  width: number,
  height: number,
  zoom: number,
  centerX: number,
  centerY: number,
): SquareCrop {
  const clampedZoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
  const size = Math.max(1, Math.round(Math.min(width, height) / clampedZoom));
  const place = (center: number, extent: number) =>
    Math.round(Math.min(extent - size, Math.max(0, center * extent - size / 2)));
  return { x: place(centerX, width), y: place(centerY, height), size };
}

/** The centre a crop really has once `squareCrop` kept it inside the image. */
export function cropCenter(width: number, height: number, crop: SquareCrop) {
  return { centerX: (crop.x + crop.size / 2) / width, centerY: (crop.y + crop.size / 2) / height };
}

/** Lowercase hex of a digest, the form the reservation's `sha256` takes. */
export function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
