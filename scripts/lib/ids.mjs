import { getRandomValues } from 'node:crypto';

/** §5.1 ids: UUIDv7 (48-bit ms timestamp, version and variant bits, random rest). */
export function uuidv7() {
  const bytes = getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((now >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
