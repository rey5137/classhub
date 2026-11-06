import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsObjectStorage } from '../../src/lib/server/adapters/local/fs-storage';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { seedDemo } from '../../src/lib/server/db/seed-demo';
import {
  albums,
  infoPages,
  invites,
  media,
  storageUsage,
  users,
} from '../../src/lib/server/db/schema';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'classhub-seed-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('seedDemo', () => {
  it('R-PLAT-10 seeds synthetic members and invites idempotently', async () => {
    const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
    const storage = new FsObjectStorage(join(directory, 'objects'));
    try {
      const first = await seedDemo(database, storage);
      const second = await seedDemo(database, storage);
      expect(first).toEqual({ members: 12, invites: 12, photos: 10 });
      expect(second).toEqual({ members: 0, invites: 0, photos: 0 });

      const members = await database.db.select().from(users);
      const rows = await database.db.select().from(invites);

      expect(members).toHaveLength(12);
      expect(rows).toHaveLength(12);
      expect(members.filter((member) => member.role === 'admin')).toHaveLength(1);
      expect(members.every((member) => member.status === 'active')).toBe(true);
      expect(members.every((member) => member.authEmail.endsWith('@example.com'))).toBe(true);
      expect(rows.every((row) => row.email.endsWith('@example.com'))).toBe(true);

      // The painted photos are stored, counted in the ledger and carry their album's year.
      const photos = await database.db.select().from(media);
      expect(photos).toHaveLength(10);
      const [usage] = await database.db.select().from(storageUsage);
      expect(usage?.committedBytes).toBe(
        photos.reduce((sum, row) => sum + row.sizeBytes + row.thumbSizeBytes, 0),
      );
      const stored = await storage.head(photos[0]!.objectKey);
      expect(stored).toEqual({ size: photos[0]!.sizeBytes, contentType: 'image/jpeg' });
      const albumYears = await database.db.select().from(albums);
      for (const photo of photos.filter((row) => row.albumId)) {
        const album = albumYears.find((row) => row.id === photo.albumId)!;
        expect(photo.effectiveYear).toBe(album.yearTag ?? photo.takenYear);
      }
      // R-BRD-02: the demo info pages, once, with the reunion page pinned.
      const pages = await database.db.select().from(infoPages);
      expect(pages.map((page) => page.slug).sort()).toEqual(['quy-lop', 'reunion']);
      expect(pages.find((page) => page.slug === 'reunion')?.isPinned).toBe(true);
    } finally {
      database.close();
    }
  });

  it('R-PLAT-10 a run whose object write fails leaves nothing behind, and the next run seeds every photo', async () => {
    const database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
    const storage = new FsObjectStorage(join(directory, 'objects'));
    try {
      let puts = 0;
      const realPut = storage.put.bind(storage);
      const failing = Object.assign(Object.create(storage) as FsObjectStorage, {
        put: (...args: Parameters<FsObjectStorage['put']>) => {
          puts += 1;
          if (puts === 5) return Promise.reject(new Error('disk full'));
          return realPut(...args);
        },
      });
      await expect(seedDemo(database, failing)).rejects.toThrow('disk full');
      expect(await database.db.select().from(albums)).toEqual([]);
      expect(await database.db.select().from(media)).toEqual([]);
      expect((await storage.list('')).objects).toEqual([]);

      const retry = await seedDemo(database, storage);
      expect(retry.photos).toBe(10);
      expect(await database.db.select().from(albums)).toHaveLength(3);
      expect((await storage.list('')).objects).toHaveLength(20);
    } finally {
      database.close();
    }
  });
});
