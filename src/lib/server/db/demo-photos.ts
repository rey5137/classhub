// INV-6: the demo wall's photos are painted here, not taken by anyone. Each is a
// baseline JPEG whose 8 × 8 blocks are flat colours (DC only, every AC run is one
// end-of-block), so a few dozen lines encode it with no image library.

class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private filled = 0;

  write(code: number, length: number): void {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.current = (this.current << 1) | ((code >> bit) & 1);
      this.filled += 1;
      if (this.filled === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.current);
    // T.81 B.1.1.5: a 0xFF in entropy-coded data is followed by a stuffed zero.
    if (this.current === 0xff) this.bytes.push(0);
    this.current = 0;
    this.filled = 0;
  }

  finish(): number[] {
    // Pad the last byte with 1-bits (T.81 F.1.2.3).
    while (this.filled !== 0) this.write(1, 1);
    return this.bytes;
  }
}

// T.81 Annex K.3, table K.3: luminance DC code lengths for categories 0–11.
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CODES: { code: number; length: number }[] = [];
{
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let index = 0; index < DC_COUNTS[length - 1]!; index += 1) {
      DC_CODES.push({ code, length });
      code += 1;
    }
    code <<= 1;
  }
}

const segment = (marker: number, body: number[]) => [
  0xff,
  marker,
  (body.length + 2) >> 8,
  (body.length + 2) & 0xff,
  ...body,
];

/** A JPEG of `width` × `height` (multiples of 8) whose block colour `paint` picks. */
export function encodeBlockJpeg(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Uint8Array<ArrayBuffer> {
  const header = [
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    // One all-ones quantisation table: a flat block's DC is 8 × (level − 128).
    ...segment(0xdb, [0, ...new Array<number>(64).fill(1)]),
    ...segment(
      0xc0,
      [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3].concat([
        1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
      ]),
    ),
    ...segment(0xc4, [0x00, ...DC_COUNTS, ...DC_CODES.map((_, index) => index)]),
    // The AC table holds only end-of-block, coded as the single bit 0.
    ...segment(0xc4, [0x10, 1, ...new Array<number>(15).fill(0), 0x00]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]),
  ];
  const bits = new BitWriter();
  const previous = [0, 0, 0];
  for (let by = 0; by < height / 8; by += 1) {
    for (let bx = 0; bx < width / 8; bx += 1) {
      const [r, g, b] = paint(bx * 8 + 4, by * 8 + 4);
      const ycc = [
        0.299 * r + 0.587 * g + 0.114 * b,
        128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
        128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
      ];
      ycc.forEach((level, component) => {
        const dc = Math.round(8 * (Math.min(255, Math.max(0, level)) - 128));
        const diff = dc - previous[component]!;
        previous[component] = dc;
        const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
        bits.write(DC_CODES[size]!.code, DC_CODES[size]!.length);
        if (size) bits.write(diff > 0 ? diff : diff + (1 << size) - 1, size);
        bits.write(0, 1);
      });
    }
  }
  return new Uint8Array([...header, ...bits.finish(), 0xff, 0xd9]);
}

type Rgb = [number, number, number];

/** A soft two-colour scene with a sun: synthetic, recognisable as "a photo" on the wall. */
export function demoPhoto(
  width: number,
  height: number,
  sky: Rgb,
  ground: Rgb,
): Uint8Array<ArrayBuffer> {
  const sun = { x: width * 0.7, y: height * 0.32, r: Math.min(width, height) * 0.14 };
  return encodeBlockJpeg(width, height, (x, y) => {
    const t = y / height;
    const base = sky.map((value, index) => value + (ground[index]! - value) * t) as Rgb;
    const distance = Math.hypot(x - sun.x, y - sun.y);
    if (distance < sun.r) return [250, 236, 200];
    const horizon = height * (0.62 + 0.05 * Math.sin((x / width) * Math.PI * 3));
    return y > horizon ? (base.map((value) => value * 0.72) as Rgb) : base;
  });
}
