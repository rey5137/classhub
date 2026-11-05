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

export interface ObjectStorage {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    opts: { contentType: string; maxBytes: number },
  ): Promise<{ size: number; sha256: string }>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  /**
   * `ifNoneMatch` is the content SHA-256 returned by `put`; surrounding quotes
   * and a `W/` prefix are ignored. A match returns `{ body: null, size,
   * contentType }`, never `null` (which means the key is missing).
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
