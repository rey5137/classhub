import type { Page } from '@playwright/test';

// Synthetic image fixtures, generated at test time (builder notes 9): the browser
// paints and encodes a JPEG, and an EXIF segment with GPS tags is spliced in here.

/** A tag value in the fixture's EXIF that a stored copy must not carry. */
export const GPS_DATUM = 'WGS-84';

/** APP1 "Exif" with IFD0 → GPS IFD: latitude/longitude refs and values, map datum. */
function exifWithGps(): Uint8Array {
  const tiff: number[] = [];
  const u16 = (value: number) => tiff.push((value >> 8) & 255, value & 255);
  const u32 = (value: number) =>
    tiff.push((value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255);
  const entry = (tag: number, type: number, count: number, value: number) => {
    u16(tag);
    u16(type);
    u32(count);
    u32(value);
  };
  const ASCII = 2;
  const LONG = 4;
  const RATIONAL = 5;
  // Layout: header 8 | IFD0 (2 + 12 + 4) = 18 | GPS IFD (2 + 5 × 12 + 4) = 66 | data.
  const gpsIfd = 8 + 18;
  const data = gpsIfd + 66;
  const latitude = data;
  const longitude = latitude + 24;
  const datum = longitude + 24;
  tiff.push(0x4d, 0x4d, 0, 42);
  u32(8);
  u16(1);
  entry(0x8825, LONG, 1, gpsIfd);
  u32(0);
  u16(5);
  entry(0x0001, ASCII, 2, 0x4e000000); // 'N'
  entry(0x0002, RATIONAL, 3, latitude);
  entry(0x0003, ASCII, 2, 0x45000000); // 'E'
  entry(0x0004, RATIONAL, 3, longitude);
  entry(0x0012, ASCII, GPS_DATUM.length + 1, datum);
  u32(0);
  for (const [whole, minutes, seconds] of [
    [21, 1, 4],
    [105, 51, 9],
  ]) {
    for (const value of [whole, minutes, seconds]) {
      u32(value!);
      u32(1);
    }
  }
  for (const char of `${GPS_DATUM}\0`) tiff.push(char.charCodeAt(0));
  const body = [...Array.from('Exif\0\0', (char) => char.charCodeAt(0)), ...tiff];
  const length = body.length + 2;
  return new Uint8Array([0xff, 0xe1, length >> 8, length & 255, ...body]);
}

/** A `width`×`height` JPEG painted in the page, with GPS EXIF right after SOI. */
export async function jpegWithGps(page: Page, width: number, height: number): Promise<Buffer> {
  const painted = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w!;
      canvas.height = h!;
      const context = canvas.getContext('2d')!;
      const gradient = context.createLinearGradient(0, 0, w!, h!);
      gradient.addColorStop(0, '#2b4c7e');
      gradient.addColorStop(0.5, '#e8c07d');
      gradient.addColorStop(1, '#7e2b4c');
      context.fillStyle = gradient;
      context.fillRect(0, 0, w!, h!);
      // Seeded shapes give the encoder real detail without making it incompressible.
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
      for (let index = 0; index < 600; index += 1) {
        context.fillStyle = `hsl(${Math.floor(random() * 360)} 60% ${30 + Math.floor(random() * 50)}%)`;
        context.beginPath();
        context.arc(random() * w!, random() * h!, 10 + random() * 180, 0, Math.PI * 2);
        context.fill();
      }
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((value) => resolve(value!), 'image/jpeg', 0.92),
      );
      // Base64 crosses the page boundary far faster than an array of numbers.
      return new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]!);
        reader.readAsDataURL(blob);
      });
    },
    [width, height],
  );
  const jpeg = Buffer.from(painted, 'base64');
  return Buffer.concat([jpeg.subarray(0, 2), exifWithGps(), jpeg.subarray(2)]);
}

const contains = (bytes: Uint8Array, text: string) =>
  Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

/**
 * The metadata a file carries: JPEG APP1 (EXIF/XMP) and APP13 (IPTC) segments, WebP
 * EXIF and XMP chunks, and the EXIF header or GPS datum anywhere in the bytes.
 */
export function metadataMarkers(bytes: Uint8Array): string[] {
  const found = new Set<string>();
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 4 <= bytes.length && bytes[offset] === 0xff;) {
      const marker = bytes[offset + 1]!;
      if (marker === 0xda) break;
      if (marker === 0xe1) found.add('APP1');
      if (marker === 0xed) found.add('APP13');
      offset += 2 + ((bytes[offset + 2]! << 8) | bytes[offset + 3]!);
    }
  } else if (contains(bytes.subarray(0, 4), 'RIFF')) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (chunk === 'EXIF' || chunk === 'XMP ') found.add(chunk.trim());
      offset += 8 + view.getUint32(offset + 4, true) + (view.getUint32(offset + 4, true) % 2);
    }
  }
  if (contains(bytes, 'Exif')) found.add('Exif');
  if (contains(bytes, GPS_DATUM)) found.add('GPS');
  return [...found].sort();
}

/** The type a file's first bytes say it is. */
export function signature(bytes: Uint8Array): 'jpeg' | 'webp' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (contains(bytes.subarray(0, 4), 'RIFF') && contains(bytes.subarray(8, 12), 'WEBP'))
    return 'webp';
  return null;
}

/** Decoded size of an image the page can fetch. */
export function decodedSize(page: Page, url: string): Promise<{ width: number; height: number }> {
  return page.evaluate(async (path) => {
    const bitmap = await createImageBitmap(await (await fetch(path)).blob());
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }, url);
}
