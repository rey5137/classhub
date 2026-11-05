import { describe, expect, it } from 'vitest';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import { ObjectTooLargeError } from '../../src/lib/server/ports/object-storage';
import { sha256Hex } from '../../src/lib/server/sha256';

type Bucket = ConstructorParameters<typeof R2ObjectStorage>[0];

/** Records what the adapter hands the binding; only the calls `put` makes exist. */
function fakeBucket() {
  const calls = {
    puts: [] as { key: string; bytes: number; sha256?: string }[],
    parts: [] as number[],
    created: 0,
    completed: 0,
    aborted: 0,
  };
  const bucket = {
    async put(key: string, value: Uint8Array, opts: { customMetadata?: { sha256?: string } }) {
      calls.puts.push({ key, bytes: value.byteLength, sha256: opts.customMetadata?.sha256 });
      return null;
    },
    async createMultipartUpload() {
      calls.created += 1;
      return {
        async uploadPart(partNumber: number, value: Uint8Array) {
          calls.parts.push(value.byteLength);
          return { partNumber, etag: `e${partNumber}` };
        },
        async complete() {
          calls.completed += 1;
          return null;
        },
        async abort() {
          calls.aborted += 1;
        },
      };
    },
  };
  return { bucket: bucket as unknown as Bucket, calls };
}

function stream(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

const BYTES = Uint8Array.from({ length: 30 }, (_, index) => index);

describe('R2ObjectStorage streaming put', () => {
  it('AC-API-05 streams a body over one part as fixed-size parts, never buffering it whole', async () => {
    const { bucket, calls } = fakeBucket();
    const storage = new R2ObjectStorage(bucket, 100, 8);

    const result = await storage.put('k', stream(BYTES, 5), { contentType: 'x/y', maxBytes: 30 });

    expect(result).toEqual({ size: 30, sha256: sha256Hex(BYTES) });
    expect(calls.puts).toEqual([]);
    expect(calls.parts).toEqual([8, 8, 8, 6]);
    expect(calls).toMatchObject({ created: 1, completed: 1, aborted: 0 });
  });

  it('AC-API-05 aborts the multipart upload when the body passes maxBytes', async () => {
    const { bucket, calls } = fakeBucket();
    const storage = new R2ObjectStorage(bucket, 100, 8);

    await expect(
      storage.put('k', stream(BYTES, 5), { contentType: 'x/y', maxBytes: 20 }),
    ).rejects.toBeInstanceOf(ObjectTooLargeError);

    expect(calls.puts).toEqual([]);
    expect(calls).toMatchObject({ created: 1, completed: 0, aborted: 1 });
  });

  it('R-API-07 a body within one part is a single put carrying its SHA-256', async () => {
    const { bucket, calls } = fakeBucket();
    const storage = new R2ObjectStorage(bucket, 100, 64);

    await storage.put('k', stream(BYTES, 7), { contentType: 'x/y', maxBytes: 1000 });

    expect(calls.puts).toEqual([{ key: 'k', bytes: 30, sha256: sha256Hex(BYTES) }]);
    expect(calls.created).toBe(0);
  });
});
