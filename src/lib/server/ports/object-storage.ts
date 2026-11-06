/** Strips `W/` and surrounding quotes so both adapters compare validators alike. */
export function normalizeValidator(value: string): string {
  return value.trim().replace(/^W\//i, '').replace(/^"|"$/g, '').toLowerCase();
}

export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`object exceeds maxBytes (${maxBytes})`);
    this.name = 'ObjectTooLargeError';
  }
}

/** A cap that isn't a non-negative integer would make the streaming check never fire. */
export function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative integer (${maxBytes})`);
  }
}

export interface ObjectStorage {
  /**
   * `onWrite` runs once before each billed write request the put makes (R-MEM-18): one
   * for a single put; create, each part and complete for a multipart one. An abort is
   * not billed and not reported.
   */
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    opts: { contentType: string; maxBytes: number; onWrite?: () => void },
  ): Promise<{ size: number; sha256: string }>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  /**
   * `ifNoneMatch` is the content SHA-256 returned by `put`; surrounding quotes
   * and a `W/` prefix are ignored. A match returns `{ body: null, size,
   * contentType }`, never `null` (which means the key is missing). An object
   * the adapter holds no hash for always returns its body.
   */
  get(
    key: string,
    opts?: { ifNoneMatch?: string },
  ): Promise<{
    body: ReadableStream<Uint8Array> | null;
    size: number;
    contentType: string;
  } | null>;
  delete(keys: string[]): Promise<void>;
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{ objects: { key: string; size: number }[]; cursor?: string }>;
}
