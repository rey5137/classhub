import type { R2Bucket, R2MultipartUpload, R2UploadedPart } from '@cloudflare/workers-types';
import {
  assertMaxBytes,
  normalizeValidator,
  ObjectTooLargeError,
  type ObjectStorage,
} from '../../ports/object-storage';
import { Sha256 } from '../../sha256';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** R2's smallest non-final multipart part; every part but the last has this size. */
export const R2_PART_BYTES = 5 * 1024 * 1024;

/** INV-4: the only place R2 types and the native binding are named. */
export class R2ObjectStorage implements ObjectStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly pageSize = 100,
    private readonly partBytes = R2_PART_BYTES,
  ) {}

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    opts: { contentType: string; maxBytes: number },
  ): Promise<{ size: number; sha256: string }> {
    // The binding needs a known length, so a body of unknown length streams as
    // fixed-size multipart parts: at most one part is held in memory whatever
    // maxBytes is. A body that fits one part is a single put.
    assertMaxBytes(opts.maxBytes);
    const hash = new Sha256();
    const reader = body.getReader();
    const httpMetadata = { contentType: opts.contentType };
    let part = new Uint8Array(Math.max(0, Math.min(this.partBytes, opts.maxBytes)));
    let filled = 0;
    let size = 0;
    let upload: R2MultipartUpload | null = null;
    const parts: R2UploadedPart[] = [];

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        // R-API-07/AC-API-05: stop before the write, so nothing is left behind.
        if (size > opts.maxBytes) throw new ObjectTooLargeError(opts.maxBytes);
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const take = Math.min(part.byteLength - filled, value.byteLength - offset);
          part.set(value.subarray(offset, offset + take), filled);
          filled += take;
          offset += take;
          if (filled === this.partBytes) {
            upload ??= await this.bucket.createMultipartUpload(key, { httpMetadata });
            parts.push(await upload.uploadPart(parts.length + 1, part));
            part = new Uint8Array(this.partBytes);
            filled = 0;
          }
        }
      }

      const sha256 = hash.digestHex();
      if (!upload) {
        await this.bucket.put(key, part.subarray(0, filled), {
          httpMetadata,
          customMetadata: { sha256 },
        });
      } else {
        if (filled > 0)
          parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, filled)));
        // A multipart upload's metadata is fixed when it starts, before the hash
        // is known, so these objects carry no stored validator (see `get`).
        await upload.complete(parts);
      }
      return { size, sha256 };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      // An aborted multipart upload leaves no object and no billed parts.
      if (upload) await upload.abort().catch(() => undefined);
      throw error;
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    const object = await this.bucket.head(key);
    if (!object) return null;
    return {
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
    };
  }

  async get(
    key: string,
    opts: { ifNoneMatch?: string } = {},
  ): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size: number;
    contentType: string;
  } | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    const contentType = object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE;
    // Objects written in parts have no stored hash, so they always return the
    // body; the media route answers If-None-Match from its own row (R-MEM-17).
    const stored = object.customMetadata?.sha256;
    if (
      opts.ifNoneMatch &&
      stored &&
      normalizeValidator(opts.ifNoneMatch) === normalizeValidator(stored)
    ) {
      await object.body.cancel().catch(() => undefined);
      return { body: null, size: object.size, contentType };
    }
    return {
      body: object.body as unknown as ReadableStream<Uint8Array>,
      size: object.size,
      contentType,
    };
  }

  async delete(keys: string[]): Promise<void> {
    // R2 caps a single delete call at 1000 keys.
    for (let index = 0; index < keys.length; index += 1000) {
      await this.bucket.delete(keys.slice(index, index + 1000));
    }
  }

  async list(
    prefix: string,
    cursor?: string,
  ): Promise<{ objects: { key: string; size: number }[]; cursor?: string }> {
    const page = await this.bucket.list({ prefix, cursor, limit: this.pageSize });
    return {
      objects: page.objects.map((object) => ({ key: object.key, size: object.size })),
      ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
    };
  }
}

export function createR2Storage(bucket: R2Bucket): ObjectStorage {
  return new R2ObjectStorage(bucket);
}
