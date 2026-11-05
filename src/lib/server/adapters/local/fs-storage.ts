import { createReadStream } from 'node:fs';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Sha256 } from '../../sha256';
import {
  normalizeValidator,
  ObjectTooLargeError,
  type ObjectStorage,
} from '../../ports/object-storage';

interface Metadata {
  size: number;
  contentType: string;
  sha256: string;
}

const META_DIR = '.meta';
const TMP_DIR = '.tmp';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Local dev storage under a directory; keys map to file paths below it. */
export class FsObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly pageSize = 100,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    opts: { contentType: string; maxBytes: number },
  ): Promise<{ size: number; sha256: string }> {
    const objectPath = this.pathFor(key);
    const metaPath = this.metaPathFor(key);
    const tempPath = join(this.root, TMP_DIR, `${crypto.randomUUID()}.part`);
    const tempMetaPath = join(this.root, TMP_DIR, `${crypto.randomUUID()}.meta`);
    mkdirSync(dirname(objectPath), { recursive: true });
    mkdirSync(dirname(metaPath), { recursive: true });
    mkdirSync(dirname(tempPath), { recursive: true });

    const handle = await open(tempPath, 'w');
    const reader = body.getReader();
    const hash = new Sha256();
    let size = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        // R-API-07/AC-API-05: stop before writing past the limit.
        if (size > opts.maxBytes) throw new ObjectTooLargeError(opts.maxBytes);
        hash.update(value);
        await handle.write(value);
      }
      const sha256 = hash.digestHex();
      await handle.close();
      // Metadata lands before the object appears, so a crash never leaves an
      // object whose size or hash cannot be reported.
      await writeFile(
        tempMetaPath,
        JSON.stringify({ size, contentType: opts.contentType, sha256 }),
      );
      await rename(tempPath, objectPath);
      await rename(tempMetaPath, metaPath);
      return { size, sha256 };
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true });
      await rm(tempMetaPath, { force: true });
      throw error;
    }
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    const metadata = this.readMetadata(key);
    if (!metadata) return null;
    return { size: metadata.size, contentType: metadata.contentType };
  }

  async get(
    key: string,
    opts: { ifNoneMatch?: string } = {},
  ): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size: number;
    contentType: string;
  } | null> {
    const metadata = this.readMetadata(key);
    if (!metadata) return null;
    if (
      opts.ifNoneMatch &&
      metadata.sha256 &&
      normalizeValidator(opts.ifNoneMatch) === normalizeValidator(metadata.sha256)
    ) {
      return { body: null, size: metadata.size, contentType: metadata.contentType };
    }

    const web = Readable.toWeb(createReadStream(this.pathFor(key)));
    return {
      body: web as ReadableStream<Uint8Array>,
      size: metadata.size,
      contentType: metadata.contentType,
    };
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      await rm(this.pathFor(key), { force: true });
      await rm(this.metaPathFor(key), { force: true });
    }
  }

  async list(
    prefix: string,
    cursor?: string,
  ): Promise<{ objects: { key: string; size: number }[]; cursor?: string }> {
    const keys = this.walk('')
      .filter((key) => key.startsWith(prefix) && (cursor === undefined || key > cursor))
      .sort();
    const page = keys.slice(0, this.pageSize).map((key) => ({
      key,
      size: statSync(this.pathFor(key)).size,
    }));
    const hasMore = keys.length > this.pageSize;
    return {
      objects: page,
      ...(hasMore ? { cursor: page[page.length - 1]!.key } : {}),
    };
  }

  private pathFor(key: string): string {
    const segments = key.split('/');
    if (
      !key ||
      key.includes('\\') ||
      key.startsWith('/') ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
      segments[0] === META_DIR ||
      segments[0] === TMP_DIR
    ) {
      throw new Error(`invalid object key: ${key}`);
    }
    const path = resolve(this.root, ...segments);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new Error(`object key escapes storage root: ${key}`);
    }
    return path;
  }

  private metaPathFor(key: string): string {
    return join(this.root, META_DIR, `${key}.json`);
  }

  private readMetadata(key: string): Metadata | null {
    const objectPath = this.pathFor(key);
    try {
      const stat = statSync(objectPath);
      const stored = JSON.parse(readFileSync(this.metaPathFor(key), 'utf8')) as Metadata;
      return { ...stored, size: stat.size };
    } catch {
      try {
        const stat = statSync(objectPath);
        return { size: stat.size, contentType: DEFAULT_CONTENT_TYPE, sha256: '' };
      } catch {
        return null;
      }
    }
  }

  private walk(prefix: string): string[] {
    const directory = join(this.root, prefix);
    const keys: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && (entry.name === META_DIR || entry.name === TMP_DIR)) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) keys.push(...this.walk(key));
      else if (entry.isFile()) keys.push(key);
    }
    return keys;
  }
}
