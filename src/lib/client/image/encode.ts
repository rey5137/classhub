import {
  AVATAR_EDGE,
  AVATAR_QUALITY,
  decodeRefusal,
  encodedMime,
  fitWithin,
  hex,
  nextStep,
  PHOTO_STEPS,
  SNIFF_BYTES,
  sniffKind,
  squareCrop,
  THUMB_EDGE,
  THUMB_QUALITY,
  type OutputMime,
  type Refusal,
} from './policy';

// §7.1: the encoder itself, the same code in the worker and on the main thread; only
// the canvas it draws on differs (R-MEM-04).

export type EncodeMode =
  | { kind: 'photo' }
  /** A scaled copy for the avatar crop screen, nothing is uploaded from it. */
  | { kind: 'preview'; edge: number }
  | { kind: 'avatar'; zoom: number; centerX: number; centerY: number };

export interface Encoded {
  image: Blob;
  /** Null for an avatar or a preview (R-MEM-13). */
  thumb: Blob | null;
  mimeType: OutputMime;
  width: number;
  height: number;
  sha256: string;
  thumbSha256: string;
}

/** A file the encoder turns down, with the reason the screen shows (R-MEM-01, 03). */
export class EncodeRefusal extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

export interface Surface {
  create(width: number, height: number): Canvas;
  toBlob(canvas: Canvas, type: OutputMime, quality: number): Promise<Blob>;
}

export const offscreenSurface: Surface = {
  create: (width, height) => new OffscreenCanvas(width, height),
  toBlob: (canvas, type, quality) => (canvas as OffscreenCanvas).convertToBlob({ type, quality }),
};

export const domSurface: Surface = {
  create(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  toBlob: (canvas, type, quality) =>
    new Promise((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))),
        type,
        quality,
      ),
    ),
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function render(
  surface: Surface,
  bitmap: ImageBitmap,
  source: Rect,
  size: { width: number; height: number },
  type: OutputMime,
  quality: number,
): Promise<Blob> {
  const canvas = surface.create(size.width, size.height);
  const context = canvas.getContext('2d') as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!context) throw new Error('no 2d context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    bitmap,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    size.width,
    size.height,
  );
  return surface.toBlob(canvas, type, quality);
}

/** R-MEM-02: WebP where the canvas really writes it, JPEG otherwise; both variants share it. */
async function renderPreferred(
  surface: Surface,
  bitmap: ImageBitmap,
  source: Rect,
  size: { width: number; height: number },
  quality: number,
  mime: OutputMime | undefined,
): Promise<{ blob: Blob; mime: OutputMime }> {
  for (const type of mime ? [mime] : (['image/webp', 'image/jpeg'] as const)) {
    const blob = await render(surface, bitmap, source, size, type, quality);
    if (encodedMime(blob.type) === type) return { blob, mime: type };
  }
  throw new Error('no WebP or JPEG encoder');
}

const sha256 = async (blob: Blob) =>
  hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));

/**
 * R-MEM-01..03: sniff, decode with EXIF orientation applied, scale and re-encode, which
 * drops EXIF, GPS and every other metadata block; `progress` runs from 0 to 1.
 */
export async function encodeImage(
  file: Blob & { name?: string },
  mode: EncodeMode,
  surface: Surface,
  progress: (fraction: number) => void = () => undefined,
): Promise<Encoded> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const kind = sniffKind(head, file.type, file.name ?? '');
  if (!kind) throw new EncodeRefusal('unsupported');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new EncodeRefusal(decodeRefusal(kind));
  }
  try {
    progress(0.2);
    const full = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
    if (mode.kind !== 'photo') {
      let source: Rect = full;
      let size = { width: AVATAR_EDGE, height: AVATAR_EDGE };
      if (mode.kind === 'avatar') {
        const crop = squareCrop(bitmap.width, bitmap.height, mode.zoom, mode.centerX, mode.centerY);
        source = { x: crop.x, y: crop.y, width: crop.size, height: crop.size };
      } else size = fitWithin(bitmap.width, bitmap.height, mode.edge);
      const { blob, mime } = await renderPreferred(
        surface,
        bitmap,
        source,
        size,
        AVATAR_QUALITY,
        undefined,
      );
      progress(0.8);
      const result = {
        image: blob,
        thumb: null,
        mimeType: mime,
        ...size,
        sha256: await sha256(blob),
        thumbSha256: await sha256(new Blob([])),
      };
      progress(1);
      return result;
    }

    let mime: OutputMime | undefined;
    let thumb: Blob | undefined;
    for (let index = 0; ;) {
      const step = PHOTO_STEPS[index]!;
      const size = fitWithin(bitmap.width, bitmap.height, step.edge);
      const encoded = await renderPreferred(surface, bitmap, full, size, step.quality, mime);
      mime = encoded.mime;
      thumb ??= (
        await renderPreferred(
          surface,
          bitmap,
          full,
          fitWithin(bitmap.width, bitmap.height, THUMB_EDGE),
          THUMB_QUALITY,
          mime,
        )
      ).blob;
      progress(0.2 + (0.6 * (index + 1)) / PHOTO_STEPS.length);
      const decision = nextStep(index, encoded.blob.size + thumb.size);
      if (decision === 'refuse') throw new EncodeRefusal('too_large');
      if (decision === 'done') {
        const result = {
          image: encoded.blob,
          thumb,
          mimeType: mime,
          ...size,
          sha256: await sha256(encoded.blob),
          thumbSha256: await sha256(thumb),
        };
        progress(1);
        return result;
      }
      index = decision;
    }
  } finally {
    bitmap.close();
  }
}
