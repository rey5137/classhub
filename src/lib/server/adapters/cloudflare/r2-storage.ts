import type { R2Bucket } from '@cloudflare/workers-types';
import {
  normalizeValidator,
  ObjectTooLargeError,
  type ObjectStorage,
} from '../../ports/object-storage';
import { Sha256 } from '../../sha256';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** INV-4: the only place R2 types and the native binding are named. */
export class R2ObjectStorage implements ObjectStorage {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly pageSize = 100,
  ) {}

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    opts: { contentType: string; maxBytes: number },
  ): Promise<{ size: number; sha256: string }> {
    const hash = new Sha256();
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    let size = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        // R-API-07/AC-API-05: stop before the write, so nothing is left behind.
        if (size > opts.maxBytes) throw new ObjectTooLargeError(opts.maxBytes);
        hash.update(value);
        chunks.push(value);
      }

      // The R2 binding requires a known body length, so a stream body cannot be
      // passed through directly. Every chunk is still counted and hashed as it
      // arrives, and the buffer is bounded by maxBytes.
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const sha256 = hash.digestHex();
      await this.bucket.put(key, bytes, {
        httpMetadata: { contentType: opts.contentType },
        customMetadata: { sha256 },
      });
      return { size, sha256 };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
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
