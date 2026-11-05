import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/lib/server/ids';
import { ObjectTooLargeError, type ObjectStorage } from '../../src/lib/server/ports/object-storage';

export interface ObjectStorageHarness {
  storage: ObjectStorage;
  dispose(): Promise<void>;
}

export type ObjectStorageFactory = () => Promise<ObjectStorageHarness>;

const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** An unbounded pull-based stream: it only yields when the adapter asks for more. */
function pullStream(chunk: Uint8Array, counter: { pulled: number }): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      counter.pulled += 1;
      controller.enqueue(chunk);
    },
  });
}

async function readBody(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  return new Response(body).text();
}

async function withStorage(
  create: ObjectStorageFactory,
  run: (storage: ObjectStorage) => Promise<void>,
): Promise<void> {
  const harness = await create();
  try {
    await run(harness.storage);
  } finally {
    await harness.dispose();
  }
}

export function objectStorageContract(label: string, create: ObjectStorageFactory): void {
  describe(`AC-PLAT-03 ObjectStorage contract (${label})`, () => {
    it('R-API-07 put, head and get return the measured size and SHA-256', async () => {
      await withStorage(create, async (storage) => {
        const key = `${uuidv7()}/hello.txt`;
        const bytes = new TextEncoder().encode('hello');

        const result = await storage.put(key, stream([bytes]), {
          contentType: 'text/plain',
          maxBytes: 1024,
        });
        expect(result).toEqual({ size: 5, sha256: HELLO_SHA256 });

        await expect(storage.head(key)).resolves.toEqual({
          size: 5,
          contentType: 'text/plain',
        });
        const object = await storage.get(key);
        expect(object?.size).toBe(5);
        expect(object?.contentType).toBe('text/plain');
        expect(await readBody(object?.body ?? null)).toBe('hello');
      });
    });

    it('AC-API-05 put stops streaming at maxBytes and leaves no object behind', async () => {
      await withStorage(create, async (storage) => {
        const key = `${uuidv7()}/too-big.bin`;
        const counter = { pulled: 0 };

        await expect(
          storage.put(key, pullStream(new Uint8Array([1, 2, 3, 4]), counter), {
            contentType: 'application/octet-stream',
            maxBytes: 5,
          }),
        ).rejects.toBeInstanceOf(ObjectTooLargeError);

        // 4-byte chunks against a 5-byte cap: the second chunk crosses the
        // limit, so an adapter that reads on demand stops after a few pulls.
        expect(counter.pulled).toBeGreaterThan(0);
        expect(counter.pulled).toBeLessThanOrEqual(4);

        await expect(storage.head(key)).resolves.toBeNull();
        const listed = await storage.list(key.slice(0, key.indexOf('/') + 1));
        expect(listed.objects).toEqual([]);
      });
    });

    it('R-API-07 ifNoneMatch returns a null body on a match and the body otherwise', async () => {
      await withStorage(create, async (storage) => {
        const key = `${uuidv7()}/conditional.txt`;
        const { sha256 } = await storage.put(key, stream([new TextEncoder().encode('hello')]), {
          contentType: 'text/plain',
          maxBytes: 64,
        });

        await expect(storage.get(key, { ifNoneMatch: `W/"${sha256}"` })).resolves.toEqual({
          body: null,
          size: 5,
          contentType: 'text/plain',
        });

        const other = await storage.get(key, { ifNoneMatch: '0'.repeat(64) });
        expect(other).not.toBeNull();
        expect(await readBody(other?.body ?? null)).toBe('hello');
      });
    });

    it('R-API-07 missing keys return null', async () => {
      await withStorage(create, async (storage) => {
        const key = `${uuidv7()}/missing.txt`;
        await expect(storage.head(key)).resolves.toBeNull();
        await expect(storage.get(key)).resolves.toBeNull();
      });
    });

    it('R-API-07 list pages with a cursor', async () => {
      await withStorage(create, async (storage) => {
        const prefix = `${uuidv7()}/`;
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
          await storage.put(`${prefix}${name}`, stream([new TextEncoder().encode(name)]), {
            contentType: 'text/plain',
            maxBytes: 64,
          });
        }

        const first = await storage.list(prefix);
        expect(first.objects.map((object) => object.key)).toEqual([
          `${prefix}a.txt`,
          `${prefix}b.txt`,
        ]);
        expect(first.cursor).toBeDefined();

        const second = await storage.list(prefix, first.cursor);
        expect(second.objects.map((object) => object.key)).toEqual([`${prefix}c.txt`]);
        expect(second.cursor).toBeUndefined();
      });
    });

    it('R-API-07 deletes more than 1000 keys in one call', async () => {
      await withStorage(create, async (storage) => {
        const prefix = `${uuidv7()}/`;
        const realKeys = [`${prefix}keep-a`, `${prefix}keep-b`];
        for (const key of realKeys) {
          await storage.put(key, stream([new TextEncoder().encode('x')]), {
            contentType: 'text/plain',
            maxBytes: 64,
          });
        }

        const keys = [
          ...realKeys,
          ...Array.from({ length: 1001 }, (_, index) => `${prefix}missing-${index}`),
        ];
        await storage.delete(keys);

        for (const key of realKeys) await expect(storage.head(key)).resolves.toBeNull();
        const listed = await storage.list(prefix);
        expect(listed.objects).toEqual([]);
      });
    });

    it('R-API-07 delete removes keys and their metadata', async () => {
      await withStorage(create, async (storage) => {
        const key = `${uuidv7()}/delete-me.txt`;
        await storage.put(key, stream([new TextEncoder().encode('x')]), {
          contentType: 'text/plain',
          maxBytes: 64,
        });

        await storage.delete([key]);

        await expect(storage.head(key)).resolves.toBeNull();
        const listed = await storage.list(key.slice(0, key.indexOf('/') + 1));
        expect(listed.objects).toEqual([]);
      });
    });
  });
}
