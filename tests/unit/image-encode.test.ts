import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeImage, EncodeRefusal, type Surface } from '../../src/lib/client/image/encode';

// §7.1: the encoder's control flow on a fake canvas, so the WebP→JPEG fallback, the
// size steps and the refusals are checked without a browser (R-MEM-01..03, 13).

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const file = (head: number[] | string, type = 'image/jpeg', name = 'a.jpg') =>
  new File([typeof head === 'string' ? head : new Uint8Array(head)], name, { type });

interface Drawn {
  width: number;
  height: number;
  type: string;
  quality: number;
  source: number[];
}

/** A canvas that writes `bytes(drawn)` bytes and, unless told, really writes WebP. */
function fakeSurface(bytes: (drawn: Drawn) => number, webp = true) {
  const drawn: Drawn[] = [];
  const surface: Surface = {
    create(width, height) {
      const canvas = {
        width,
        height,
        source: [] as number[],
        getContext: () => ({
          drawImage: (_bitmap: unknown, ...args: number[]) => (canvas.source = args.slice(0, 4)),
        }),
      };
      return canvas as unknown as OffscreenCanvas;
    },
    async toBlob(canvas, type, quality) {
      const { width, height, source } = canvas as unknown as Drawn;
      const actual = type === 'image/webp' && !webp ? 'image/png' : type;
      const entry = { width, height, type: actual, quality, source };
      drawn.push(entry);
      return new Blob([new Uint8Array(bytes(entry))], { type: actual });
    },
  };
  return { surface, drawn };
}

function decodesAs(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close })),
  );
  return close;
}

afterEach(() => vi.unstubAllGlobals());

describe('R-MEM-01 refusals before any work', () => {
  it('refuses a file without a known signature without decoding it', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    const { surface } = fakeSurface(() => 10);
    await expect(
      encodeImage(file('plain text', 'text/plain', 'a.txt'), { kind: 'photo' }, surface),
    ).rejects.toEqual(new EncodeRefusal('unsupported'));
    expect(decode).not.toHaveBeenCalled();
  });

  it('refuses a HEIC the browser cannot decode with the HEIC reason', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('bad', 'InvalidStateError');
      }),
    );
    const { surface } = fakeSurface(() => 10);
    const heic = file(
      [0, 0, 0, 24, ...Array.from('ftypheic', (c) => c.charCodeAt(0))],
      '',
      'x.heic',
    );
    await expect(encodeImage(heic, { kind: 'photo' }, surface)).rejects.toMatchObject({
      reason: 'heic_undecodable',
    });
  });

  it('decodes with EXIF orientation applied', async () => {
    decodesAs(100, 100);
    const { surface } = fakeSurface(() => 10);
    await encodeImage(file(JPEG_HEAD), { kind: 'photo' }, surface);
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      imageOrientation: 'from-image',
    });
  });
});

describe('R-MEM-02 photo encode', () => {
  it('writes a ≤ 2000 px WebP at 0.82 and a ≤ 480 px thumb at 0.75, hashed', async () => {
    const close = decodesAs(4000, 3000);
    const { surface, drawn } = fakeSurface(() => 1000);
    const progress = vi.fn();
    const result = await encodeImage(file(JPEG_HEAD), { kind: 'photo' }, surface, progress);
    expect(drawn.map(({ width, height, type, quality }) => [width, height, type, quality])).toEqual(
      [
        [2000, 1500, 'image/webp', 0.82],
        [480, 360, 'image/webp', 0.75],
      ],
    );
    expect(result).toMatchObject({ mimeType: 'image/webp', width: 2000, height: 1500 });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.thumb?.size).toBe(1000);
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(close).toHaveBeenCalled();
  });

  it('falls back to JPEG for both variants when the canvas cannot write WebP', async () => {
    decodesAs(4000, 3000);
    const { surface, drawn } = fakeSurface(() => 1000, false);
    const result = await encodeImage(file(JPEG_HEAD), { kind: 'photo' }, surface);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.image.type).toBe('image/jpeg');
    expect(result.thumb?.type).toBe('image/jpeg');
    expect(drawn.map((entry) => entry.type)).toEqual(['image/png', 'image/jpeg', 'image/jpeg']);
  });
});

describe('R-MEM-03 size steps', () => {
  it('steps quality to 0.70, then the edge to 1600 px, until image + thumb fit', async () => {
    decodesAs(4000, 3000);
    const { surface, drawn } = fakeSurface(({ width, quality }) =>
      width === 480 ? 50_000 : width === 2000 ? (quality > 0.8 ? 3_000_000 : 2_500_000) : 1_900_000,
    );
    const result = await encodeImage(file(JPEG_HEAD), { kind: 'photo' }, surface);
    expect(drawn.map(({ width, quality }) => [width, quality])).toEqual([
      [2000, 0.82],
      [480, 0.75],
      [2000, 0.7],
      [1600, 0.7],
    ]);
    expect(result).toMatchObject({ width: 1600, height: 1200 });
    expect(result.image.size + result.thumb!.size).toBeLessThanOrEqual(2_000_000);
  });

  it('refuses with an explanation when the last step is still too large', async () => {
    const close = decodesAs(4000, 3000);
    const { surface } = fakeSurface(() => 1_500_000);
    await expect(encodeImage(file(JPEG_HEAD), { kind: 'photo' }, surface)).rejects.toMatchObject({
      reason: 'too_large',
    });
    expect(close).toHaveBeenCalled();
  });
});

describe('R-MEM-13 avatar', () => {
  it('draws one 512 px square from the crop, with no thumbnail', async () => {
    decodesAs(4000, 3000);
    const { surface, drawn } = fakeSurface(() => 1000);
    const result = await encodeImage(
      file(JPEG_HEAD),
      { kind: 'avatar', zoom: 2, centerX: 0, centerY: 0.5 },
      surface,
    );
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatchObject({ width: 512, height: 512, source: [0, 750, 1500, 1500] });
    expect(result).toMatchObject({ width: 512, height: 512, thumb: null });
    // The reservation still carries a hash for the empty thumb (R-MEM-06).
    expect(result.thumbSha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
