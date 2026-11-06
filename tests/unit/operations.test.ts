import { afterAll, describe, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import type { ObjectStorage } from '../../src/lib/server/ports/object-storage';
import { readOperations } from '../../src/lib/server/repositories/operations';
import {
  CLASS_B_FLUSH_MS,
  ClassBTally,
  meterStorage,
  monthKey,
  recordOperations,
} from '../../src/lib/server/services/operations';

const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
afterAll(() => database.close());

const MAY_31 = Date.UTC(2027, 4, 31, 23, 59, 30);
const JUNE_1 = Date.UTC(2027, 5, 1, 0, 0, 40);

describe('R-MEM-18 Class B tally', () => {
  it('R-MEM-18 releases reads at most once a minute after the first unwritten read', () => {
    const tally = new ClassBTally();
    expect(tally.take(MAY_31)).toEqual([]);
    tally.add(2, MAY_31);
    expect(tally.take(MAY_31 + CLASS_B_FLUSH_MS - 1)).toEqual([]);
    tally.add(1, MAY_31 + 10);
    expect(tally.take(MAY_31 + CLASS_B_FLUSH_MS)).toEqual([
      { month: '2027-05', classA: 0, classB: 3 },
    ]);
    // The next window starts at the next read, not at the flush.
    expect(tally.take(MAY_31 + 3 * CLASS_B_FLUSH_MS)).toEqual([]);
    tally.add(0, MAY_31 + 3 * CLASS_B_FLUSH_MS);
    expect(tally.take(MAY_31 + 5 * CLASS_B_FLUSH_MS)).toEqual([]);
  });

  it('R-MEM-18 keeps reads in the month they happened across a month boundary', () => {
    const tally = new ClassBTally();
    tally.add(4, MAY_31);
    tally.add(1, JUNE_1);
    expect(monthKey(MAY_31)).toBe('2027-05');
    expect(tally.take(JUNE_1 + CLASS_B_FLUSH_MS)).toEqual([
      { month: '2027-05', classA: 0, classB: 4 },
      { month: '2027-06', classA: 0, classB: 1 },
    ]);
  });

  it('R-MEM-18 writes Class A at once, rolls the tally into its own months, and keeps reads a failed write lost', async () => {
    const tally = new ClassBTally();
    await recordOperations(database, { classA: 2, classB: 5 }, MAY_31, tally);
    expect(await readOperations(database, '2027-05')).toEqual({
      month: '2027-05',
      classA: 2,
      classB: 0,
    });
    expect(recordOperations(database, { classA: 0, classB: 0 }, MAY_31 + 1, tally)).toBeNull();

    const failing = vi.spyOn(database, 'batch').mockRejectedValueOnce(new Error('d1 down'));
    await expect(
      recordOperations(database, { classA: 1, classB: 1 }, JUNE_1, tally),
    ).rejects.toThrow('d1 down');
    failing.mockRestore();
    await recordOperations(database, { classA: 0, classB: 0 }, JUNE_1 + CLASS_B_FLUSH_MS, tally);
    expect(await readOperations(database, '2027-05')).toMatchObject({ classA: 2, classB: 5 });
    // The failed request's own Class A is lost with its write; its read went back in the tally.
    expect(await readOperations(database, '2027-06')).toMatchObject({ classA: 0, classB: 1 });
  });
});

describe('R-MEM-18 metered storage', () => {
  it('R-MEM-18 counts put and list as Class A, head and get as Class B, and a delete as nothing', async () => {
    const inner = {
      put: vi.fn(async (_key: string, _body: unknown, opts: { onWrite?: () => void }) => {
        opts.onWrite?.();
        return { size: 1, sha256: 'a' };
      }),
      head: vi.fn(async () => null),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ objects: [] })),
    } satisfies ObjectStorage;
    const count = { classA: 0, classB: 0 };
    const storage = meterStorage(inner, count);
    await storage.put('k', new ReadableStream(), { contentType: 'image/webp', maxBytes: 1 });
    await storage.delete(['a', 'b', 'c']);
    await storage.list('staging/');
    await storage.head('k');
    await storage.get('k', { ifNoneMatch: 'x' });
    expect(count).toEqual({ classA: 2, classB: 2 });
    expect(inner.delete).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(inner.get).toHaveBeenCalledWith('k', { ifNoneMatch: 'x' });
  });
});
