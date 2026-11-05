import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Hex } from '../../src/lib/server/sha256';

describe('Sha256', () => {
  it('matches the known vectors for empty and short input', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto across chunk boundaries', () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37) % 256;

    for (const chunk of [1, 3, 63, 64, 65, 1_000]) {
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        hash.update(bytes.subarray(offset, offset + chunk));
      }
      const expected = createHash('sha256').update(bytes).digest('hex');
      expect(hash.digestHex()).toBe(expected);
    }
  });
});
