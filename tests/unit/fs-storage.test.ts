import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'classhub-fs-storage-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('FsObjectStorage keys', () => {
  it.each(['..', '../escape.txt', '/absolute.txt', 'nested/../../escape.txt', 'back\\slash.txt'])(
    'rejects %s, which would leave the storage root',
    async (key) => {
      const storage = new FsObjectStorage(directory);
      await expect(
        storage.put(key, stream('x'), { contentType: 'text/plain', maxBytes: 64 }),
      ).rejects.toThrow(/invalid object key|escapes storage root/);
      await expect(storage.head(key)).rejects.toThrow(/invalid object key|escapes storage root/);
    },
  );

  it('AC-API-05 leaves no temp file when a stream passes maxBytes', async () => {
    const storage = new FsObjectStorage(directory);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    });

    await expect(
      storage.put('too/big.bin', body, { contentType: 'application/octet-stream', maxBytes: 5 }),
    ).rejects.toThrow();

    expect(pulled).toBeLessThanOrEqual(4);
    expect(readdirSync(join(directory, '.tmp'))).toEqual([]);
    await expect(storage.head('too/big.bin')).resolves.toBeNull();
  });

  it('stores nested keys below the root', async () => {
    const storage = new FsObjectStorage(directory);
    const result = await storage.put('a/b/c.txt', stream('hello'), {
      contentType: 'text/plain',
      maxBytes: 64,
    });
    expect(result.size).toBe(5);
    await expect(storage.head('a/b/c.txt')).resolves.toEqual({
      size: 5,
      contentType: 'text/plain',
    });
  });
});
