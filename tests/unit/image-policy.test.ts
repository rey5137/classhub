import { describe, expect, it } from 'vitest';
import {
  cropCenter,
  decodeRefusal,
  encodedMime,
  fitWithin,
  hex,
  MAX_ZOOM,
  nextStep,
  PHOTO_STEPS,
  PHOTO_TARGET_BYTES,
  sniffKind,
  squareCrop,
} from '../../src/lib/client/image/policy';

// §7.1: the encoder's pure decisions (R-MEM-01..03, R-MEM-13).

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === 'string' ? Array.from(part, (char) => char.charCodeAt(0)) : part,
    ),
  );

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe1], 'Exif');
const PNG = bytes([0x89], 'PNG\r\n\x1a\n', [0, 0, 0, 13]);
const WEBP = bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ');
const HEIC = bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0]);
const GIF = bytes('GIF89a', [1, 0, 1, 0]);
const TEXT = bytes('hello, classmates');

describe('R-MEM-01 accept and refuse', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg', 'a.jpg', 'jpeg'],
    ['PNG', PNG, 'image/png', 'a.png', 'png'],
    ['WebP', WEBP, 'image/webp', 'a.webp', 'webp'],
    ['HEIC by brand, no type', HEIC, '', 'IMG_0001', 'heic'],
    ['HEIF by type', bytes('garbage bytes...'), 'image/heif', 'x', 'heic'],
    ['HEIC by name', bytes('garbage bytes...'), '', 'IMG_0001.HEIC', 'heic'],
    ['JPEG bytes named .png', JPEG, 'image/png', 'a.png', 'jpeg'],
    ['GIF', GIF, 'image/gif', 'a.gif', null],
    ['text', TEXT, 'text/plain', 'notes.txt', null],
    ['text claiming JPEG', TEXT, 'image/jpeg', 'a.jpg', null],
    ['empty file', new Uint8Array(), 'image/jpeg', 'a.jpg', null],
  ] as const)('%s', (_label, head, mime, name, kind) => {
    expect(sniffKind(head, mime, name)).toBe(kind);
  });

  it('a HEIC that will not decode gets its own reason', () => {
    expect(decodeRefusal('heic')).toBe('heic_undecodable');
    expect(decodeRefusal('jpeg')).toBe('undecodable');
  });
});

describe('R-MEM-02 dimensions', () => {
  it('scales the long edge down to the limit, keeping the aspect ratio', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000, 480)).toEqual({ width: 360, height: 480 });
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it('never upscales and never reaches zero', () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(20000, 1, 480)).toEqual({ width: 480, height: 1 });
  });

  it('keeps only WebP or JPEG output, so a canvas that fell back to PNG is caught', () => {
    expect(encodedMime('image/webp')).toBe('image/webp');
    expect(encodedMime('image/jpeg')).toBe('image/jpeg');
    expect(encodedMime('image/png')).toBeNull();
    expect(encodedMime('')).toBeNull();
  });
});

describe('R-MEM-03 size steps', () => {
  it('starts at 2000 px q0.82, then q0.70, then 1600 px', () => {
    expect(PHOTO_STEPS).toEqual([
      { edge: 2000, quality: 0.82 },
      { edge: 2000, quality: 0.7 },
      { edge: 1600, quality: 0.7 },
    ]);
    expect(PHOTO_TARGET_BYTES).toBe(2_000_000);
  });

  it('stops at the target, steps while over it, refuses after the last step', () => {
    expect(nextStep(0, PHOTO_TARGET_BYTES)).toBe('done');
    expect(nextStep(0, PHOTO_TARGET_BYTES + 1)).toBe(1);
    expect(nextStep(1, PHOTO_TARGET_BYTES + 1)).toBe(2);
    expect(nextStep(2, PHOTO_TARGET_BYTES)).toBe('done');
    expect(nextStep(2, PHOTO_TARGET_BYTES + 1)).toBe('refuse');
  });
});

describe('R-MEM-13 avatar crop', () => {
  it('zoom 1 is the largest centred square', () => {
    expect(squareCrop(4000, 3000, 1, 0.5, 0.5)).toEqual({ x: 500, y: 0, size: 3000 });
    expect(squareCrop(3000, 4000, 1, 0.5, 0.5)).toEqual({ x: 0, y: 500, size: 3000 });
  });

  it('zoom shrinks the square around the centre', () => {
    expect(squareCrop(4000, 3000, 2, 0.5, 0.5)).toEqual({ x: 1250, y: 750, size: 1500 });
  });

  it('keeps the square inside the image, whatever the centre', () => {
    expect(squareCrop(4000, 3000, 2, 0, 0)).toEqual({ x: 0, y: 0, size: 1500 });
    expect(squareCrop(4000, 3000, 2, 1, 1)).toEqual({ x: 2500, y: 1500, size: 1500 });
    expect(squareCrop(4000, 3000, 1, 0.9, 0.1)).toEqual({ x: 1000, y: 0, size: 3000 });
  });

  it('clamps the zoom to 1…MAX_ZOOM', () => {
    expect(squareCrop(1000, 1000, 0.2, 0.5, 0.5).size).toBe(1000);
    expect(squareCrop(1000, 1000, 99, 0.5, 0.5).size).toBe(1000 / MAX_ZOOM);
  });

  it('reports the centre a clamped crop really has', () => {
    const crop = squareCrop(4000, 3000, 2, 0, 1);
    expect(cropCenter(4000, 3000, crop)).toEqual({ centerX: 0.1875, centerY: 0.75 });
  });
});

it('hex renders a digest as lowercase hex', () => {
  expect(hex(new Uint8Array([0, 15, 171, 255]).buffer)).toBe('000fabff');
});
