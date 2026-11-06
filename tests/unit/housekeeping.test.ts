import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../../src/lib/server/adapters/local/sqlite-database';
import { createRemoteDatabase } from '../../src/lib/server/adapters/cloudflare/remote-database';
import {
  media,
  schemaMeta,
  storageUsage,
  uploadReservations,
} from '../../src/lib/server/db/schema';
import {
  finishYearRewrite,
  insertAlbum,
  updateAlbum,
  YEAR_REWRITE_CHUNK,
  YEAR_REWRITE_FLAG,
} from '../../src/lib/server/repositories/gallery';
import { releaseExpired, retainedObjectKeys } from '../../src/lib/server/repositories/housekeeping';
import { uuidv7 } from '../../src/lib/server/ids';
import { completeReservation, findReservation } from '../../src/lib/server/repositories/media';
import { claimHousekeeping } from '../../src/lib/server/repositories/settings';
import { JobRunner } from '../../src/lib/server/services/job-runner';
import {
  HOUSEKEEPING_NOW as now,
  seedDeletedMedia,
  seedReservation,
  usage,
} from '../fixtures/housekeeping';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHousekeepingWrites } from '../../scripts/lib/housekeeping-writes.mjs';
import { finalKeys } from '../../src/lib/server/repositories/media';
import { runHousekeeping } from '../../scripts/lib/housekeeping.mjs';

let database: ReturnType<typeof createLocalDatabase>;
let objects: Map<string, number>;
const fakeList = async (
  _prefix: string,
  _cursor?: string,
): Promise<{ objects: { key: string; size: number }[]; cursor?: string }> => ({
  objects: [...objects]
    .filter(([key]) => key.startsWith(_prefix) && (!_cursor || key > _cursor))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, size]) => ({ key, size })),
});
const storage = {
  list: vi.fn(fakeList),
  delete: vi.fn(async (keys: string[]) => {
    for (const key of keys) objects.delete(key);
  }),
};
beforeEach(async () => {
  database = createLocalDatabase(':memory:', { migrationsDir: 'migrations' });
  await seedMembership(database);
  objects = new Map();
  vi.clearAllMocks();
  storage.list.mockImplementation(fakeList);
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

const runner = () => new JobRunner({ database, storage });

describe('bounded media housekeeping', () => {
  it('AC-MEM-09 claims one hourly traffic slot across concurrent requests and permits a later run', async () => {
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => claimHousekeeping(database.db, now)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimHousekeeping(database.db, now + 3_600_000)).toBe(false);
    expect(await claimHousekeeping(database.db, now + 3_600_001)).toBe(true);
  });

  it('AC-MEM-09 releases at most 20 expired reservations per run and duplicate runs subtract once', async () => {
    for (let n = 0; n < 21; n++) await seedReservation(database);
    await runner().run(now);
    expect((await usage(database)).reservedBytes).toBe(20);
    const released = await database.db
      .select()
      .from(uploadReservations)
      .where(eq(uploadReservations.state, 'released'))
      .limit(50);
    expect(released).toHaveLength(20);
    expect(new Set(released.map((row) => row.stateRunId)).size).toBe(1);
    await runner().run(now);
    await runner().run(now);
    expect((await usage(database)).reservedBytes).toBe(0);
  });

  it('AC-MEM-12 expiry only subtracts rows this run released when complete wins the race', async () => {
    const row = await seedReservation(database);
    const reservation = (await findReservation(database, row.id))!;
    expect(await completeReservation(database, reservation, {}, now - 2)).toBe(true);
    await releaseExpired(database, [row.id], now);
    await releaseExpired(database, [row.id], now);
    expect((await usage(database)).reservedBytes).toBe(0);
    expect((await usage(database)).committedBytes).toBe(20);
    expect((await findReservation(database, row.id))!.state).toBe('completed');
  });

  it('AC-MEM-09 sweeps orphan and non-open staging keys while retaining open reservations', async () => {
    const open = await seedReservation(database, { expiresAt: now + 60_000 });
    const released = await seedReservation(database, { state: 'released' });
    const completed = await seedReservation(database, { state: 'completed' });
    for (const row of [open, released, completed]) objects.set(row.objectKey, 12);
    objects.set('staging/no-row', 1);
    objects.set('media/keep', 2);
    await runner().run(now);
    expect([...objects.keys()].sort()).toEqual(['media/keep', open.objectKey].sort());
    expect((await usage(database)).reservedBytes).toBe(20);
  });

  it('AC-MEM-13 retains grace-period media; failed object deletes retry and purge bytes once', async () => {
    const old = await seedDeletedMedia(database);
    const recent = await seedDeletedMedia(database, { deletedAt: now - 1 });
    for (const row of [old, recent]) {
      objects.set(row.objectKey, 12);
      objects.set(row.thumbKey, 8);
    }
    storage.delete.mockRejectedValueOnce(new Error('delete failed'));
    await expect(runner().run(now)).rejects.toThrow('delete failed');
    expect((await usage(database)).committedBytes).toBe(40);
    expect(
      (await database.db.select().from(media).where(eq(media.id, old.id)).limit(1))[0]!.purgedAt,
    ).toBeNull();
    await runner().run(now);
    await runner().run(now);
    expect((await usage(database)).committedBytes).toBe(20);
    expect([...objects.keys()].sort()).toEqual([recent.objectKey, recent.thumbKey].sort());
  });

  it('AC-MEM-09 trigger runs once hourly and reports listing failures to its caller', async () => {
    await Promise.all([runner().trigger(now), runner().trigger(now)]);
    expect(storage.list).toHaveBeenCalledTimes(1);
    storage.list.mockRejectedValueOnce(new Error('list failed'));
    await expect(runner().trigger(now + 3_600_001)).rejects.toThrow('list failed');
  });
});

describe('housekeeping CLI with fake object storage', () => {
  const deps = () => ({ database, storage, now, out: vi.fn() });
  it('AC-MEM-09 rejects unsupported CLI flags without accessing storage', async () => {
    expect(await runHousekeeping(['--remote'], deps())).toBe(1);
    expect(storage.list).not.toHaveBeenCalled();
  });

  it('AC-MEM-09 reconcile removes orphan media, avatars and staging; keeps live, grace and open keys; rewrites usage on every run', async () => {
    const live = await seedDeletedMedia(database, { deletedAt: null });
    const grace = await seedDeletedMedia(database, { deletedAt: now - 1 });
    const avatarId = uuidv7();
    const avatar = await seedDeletedMedia(database, {
      id: avatarId,
      deletedAt: null,
      mediaType: 'avatar',
      objectKey: `avatars/v1/owner/${avatarId}.webp`,
      thumbKey: '',
      thumbSizeBytes: 0,
    });
    const open = await seedReservation(database, { expiresAt: now + 60_000 });
    const purged = await seedDeletedMedia(database, { deletedAt: now - 1, purgedAt: now - 1 });
    for (const row of [live, grace, avatar, purged]) {
      objects.set(row.objectKey, 12);
      if (row.thumbKey) objects.set(row.thumbKey, 8);
    }
    objects.set(open.objectKey, 12);
    objects.set(`media/v1/${uuidv7()}/image.webp`, 99);
    objects.set(`avatars/v1/owner/${uuidv7()}.webp`, 99);
    objects.set('staging/orphan', 99);
    // Not a key this build writes: kept, counted and reported, never deleted.
    objects.set('media/odd', 7);
    objects.set('unrelated/keep', 100);
    const options = deps();
    expect(await runHousekeeping(['--reconcile'], options)).toBe(0);
    expect(options.out).toHaveBeenCalledWith('housekeeping: unrecognised object kept: media/odd');
    expect((await usage(database)).committedBytes).toBe(59);
    expect((await usage(database)).lastReconciledAt).toBe(now);
    expect((await usage(database)).reservedBytes).toBe(20);
    expect([...objects.keys()].sort()).toEqual(
      [
        live.objectKey,
        live.thumbKey,
        grace.objectKey,
        grace.thumbKey,
        avatar.objectKey,
        open.objectKey,
        'media/odd',
        'unrelated/keep',
      ].sort(),
    );
    objects.set(live.objectKey, 15);
    expect(await runHousekeeping(['--reconcile'], deps())).toBe(0);
    expect((await usage(database)).committedBytes).toBe(62);
  });

  it('AC-MEM-09 reconcile retains final photo and avatar keys of open reservations until they leave open', async () => {
    const photo = await seedReservation(database, { expiresAt: now + 60_000 });
    const avatar = await seedReservation(database, {
      purpose: 'avatar',
      thumbKey: '',
      expiresAt: now + 60_000,
    });
    const finals = [
      finalKeys((await findReservation(database, photo.id))!).objectKey,
      finalKeys((await findReservation(database, photo.id))!).thumbKey,
      finalKeys((await findReservation(database, avatar.id))!).objectKey,
    ];
    for (const key of finals) objects.set(key, 5);
    objects.set(photo.objectKey, 12);
    await runHousekeeping(['--reconcile'], deps());
    expect([...objects.keys()].sort()).toEqual([...finals, photo.objectKey].sort());
    // The finals' bytes are still in reserved_bytes until `complete` commits them (R-MEM-11).
    expect((await usage(database)).committedBytes).toBe(0);
    await database.db.update(uploadReservations).set({ state: 'released' });
    await runHousekeeping(['--reconcile'], deps());
    expect(objects.size).toBe(0);
    expect((await usage(database)).committedBytes).toBe(0);
  });

  it('AC-MEM-09 REST writes recover a crash after row marking, without atomic batches or duplicate subtraction', async () => {
    const expired = await seedReservation(database);
    const old = await seedDeletedMedia(database);
    const live = await seedDeletedMedia(database, { deletedAt: null });
    const writes = createHousekeepingWrites(database);
    const update = database.db.update.bind(database.db);
    const crashAfterMark = () =>
      vi
        .spyOn(database.db, 'update')
        .mockImplementationOnce(update)
        .mockImplementationOnce(() => {
          throw new Error('crash');
        });
    crashAfterMark();
    await expect(writes.releaseExpired(database, [expired.id], now)).rejects.toThrow('crash');
    vi.restoreAllMocks();
    expect((await findReservation(database, expired.id))!.state).toBe('released');
    expect((await usage(database)).reservedBytes).toBe(20);
    await writes.repairUsage(now);
    await writes.releaseExpired(database, [expired.id], now);
    expect((await usage(database)).reservedBytes).toBe(0);
    crashAfterMark();
    await expect(writes.markPurged(database, [old.id], now, now)).rejects.toThrow('crash');
    vi.restoreAllMocks();
    expect(
      (await database.db.select().from(media).where(eq(media.id, old.id)).limit(1))[0]!.purgedAt,
    ).toBe(now);
    vi.spyOn(database, 'batch').mockRejectedValue(new Error('REST cannot batch'));
    objects.set(live.objectKey, 12);
    objects.set(live.thumbKey, 8);
    await runHousekeeping([], { ...deps(), writes, repairUsage: writes.repairUsage });
    await writes.markPurged(database, [old.id], now, now);
    expect((await usage(database)).committedBytes).toBe(20);
    expect((await usage(database)).reservedBytes).toBe(0);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it('AC-MEM-09 a plain run after a reconcile leaves the bucket total; before any reconcile it rebuilds from rows', async () => {
    const live = await seedDeletedMedia(database, { deletedAt: null });
    const writes = createHousekeepingWrites(database);
    await database.db.update(storageUsage).set({ committedBytes: 999 });
    await runHousekeeping([], { ...deps(), writes, repairUsage: writes.repairUsage });
    expect((await usage(database)).committedBytes).toBe(20);
    objects.set(live.objectKey, 15);
    objects.set(live.thumbKey, 8);
    await runHousekeeping(['--reconcile'], deps());
    expect((await usage(database)).committedBytes).toBe(23);
    await runHousekeeping([], { ...deps(), writes, repairUsage: writes.repairUsage });
    expect((await usage(database)).committedBytes).toBe(23);
    expect((await usage(database)).lastReconciledAt).toBe(now);
  });

  it('AC-MEM-09 after a reconcile the REST purge subtracts the flipped rows once, even when retried', async () => {
    const old = await seedDeletedMedia(database);
    await seedDeletedMedia(database, { deletedAt: null });
    await database.db.update(storageUsage).set({ lastReconciledAt: now });
    const writes = createHousekeepingWrites(database);
    await writes.markPurged(database, [old.id], now, now);
    await writes.markPurged(database, [old.id], now, now);
    expect((await usage(database)).committedBytes).toBe(20);
  });

  it('AC-MEM-09 the key lookup costs one media statement, and each staging chunk of 49 keys stays within 100 bound parameters', async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const remote = createRemoteDatabase(async (statement) => {
      statements.push(statement);
      return [{ success: true, results: { columns: [], rows: [] }, meta: { changes: 0 } }];
    });
    const media90 = Array.from({ length: 90 }, () => `media/v1/${uuidv7()}/image.webp`);
    await retainedObjectKeys(remote, media90, now);
    expect(statements.filter(({ sql }) => sql.includes('from "media"'))).toHaveLength(1);
    expect(statements).toHaveLength(2);
    statements.length = 0;
    await retainedObjectKeys(remote, ['staging/v1/a/image.webp'], now);
    expect(statements).toHaveLength(1);
    // Staging, media and avatar keys in one call: 90 of each page is the worst case.
    statements.length = 0;
    const staging90 = Array.from({ length: 90 }, () => `staging/v1/${uuidv7()}/image.webp`);
    const avatars = Array.from({ length: 5 }, () => `avatars/v1/owner/${uuidv7()}.jpg`);
    await retainedObjectKeys(remote, [...staging90, ...media90.slice(0, 40), ...avatars], now);
    expect(statements.length).toBeGreaterThan(0);
    for (const { params } of statements) expect(params.length).toBeLessThanOrEqual(100);
    // 90 staging keys are two chunks (49 + 41), plus the reservation and media lookups by id.
    expect(
      statements.filter(
        ({ sql }) => sql.includes('"object_key" in') || sql.includes('"thumb_key" in'),
      ),
    ).toHaveLength(2);
    // The media lookup is by primary key (R-DB-07), not by object/thumb key.
    const mediaLookup = statements.find(({ sql }) => sql.includes('from "media"'))!;
    expect(mediaLookup.sql).toContain('"media"."id" in');
    expect(mediaLookup.sql).not.toMatch(/"object_key" in|"thumb_key" in/);
    expect(mediaLookup.params.length).toBeLessThanOrEqual(100);
  });

  it('AC-MEM-09 a stale album year is finished by housekeeping only while the flag is set', async () => {
    const album = await insertAlbum(database, PEOPLE.active.id, { name: 'A', yearTag: 2020 }, now);
    const photo = await seedDeletedMedia(database, {
      deletedAt: null,
      albumId: album.id,
      effectiveYear: 1999,
    });
    const year = async () =>
      (await database.db.select().from(media).where(eq(media.id, photo.id)).limit(1))[0]!
        .effectiveYear;
    await finishYearRewrite(database);
    expect(await year()).toBe(1999);
    await database.db.insert(schemaMeta).values({ key: YEAR_REWRITE_FLAG, value: `,${album.id},` });
    await finishYearRewrite(database);
    expect(await year()).toBe(2020);
    const flag = () =>
      database.db.select().from(schemaMeta).where(eq(schemaMeta.key, YEAR_REWRITE_FLAG));
    expect(await flag()).toHaveLength(0);
  });

  it('AC-MEM-09 the album PATCH sets the flag and a full chunk keeps it for the next run', async () => {
    const album = await insertAlbum(database, PEOPLE.active.id, { name: 'A', yearTag: null }, now);
    for (let n = 0; n <= YEAR_REWRITE_CHUNK; n++)
      await seedDeletedMedia(database, { deletedAt: null, albumId: album.id, takenYear: 1999 });
    await updateAlbum(database, album.id, { yearTag: 2021 });
    const flag = () =>
      database.db.select().from(schemaMeta).where(eq(schemaMeta.key, YEAR_REWRITE_FLAG));
    expect(await flag()).toHaveLength(1);
    const stale = async () =>
      (await database.db.select().from(media).where(eq(media.effectiveYear, 2021)).limit(600))
        .length;
    expect(await stale()).toBe(YEAR_REWRITE_CHUNK + 1);
    // A request that died after the flag: reset some photos and let housekeeping finish.
    await database.db.update(media).set({ effectiveYear: 1999 });
    await finishYearRewrite(database);
    expect(await flag()).toHaveLength(1);
    expect(await stale()).toBe(YEAR_REWRITE_CHUNK);
    await runner().trigger(now + 3_600_001);
    expect(await stale()).toBe(YEAR_REWRITE_CHUNK + 1);
    expect(await flag()).toHaveLength(0);
  });

  it('AC-MEM-09 the sweep takes one listed album per run, removes only its id and deletes the row when empty', async () => {
    const first = await insertAlbum(database, PEOPLE.active.id, { name: 'A', yearTag: 2020 }, now);
    const second = await insertAlbum(database, PEOPLE.active.id, { name: 'B', yearTag: 2021 }, now);
    const other = await insertAlbum(database, PEOPLE.active.id, { name: 'C', yearTag: 2022 }, now);
    const seed = (albumId: string) =>
      seedDeletedMedia(database, { deletedAt: null, albumId, effectiveYear: 1999 });
    const [one, two, three] = [await seed(first.id), await seed(second.id), await seed(other.id)];
    const year = async (id: string) =>
      (await database.db.select().from(media).where(eq(media.id, id)).limit(1))[0]!.effectiveYear;
    const flag = async () =>
      (await database.db.select().from(schemaMeta).where(eq(schemaMeta.key, YEAR_REWRITE_FLAG)))[0]
        ?.value;
    // PATCH adds its id once, never twice, and keeps the others.
    await updateAlbum(database, first.id, { yearTag: 2020 });
    await database.db.update(media).set({ effectiveYear: 1999 });
    await updateAlbum(database, second.id, { yearTag: 2021 });
    await updateAlbum(database, second.id, { yearTag: 2021 });
    await database.db.update(media).set({ effectiveYear: 1999 });
    expect(await flag()).toBe(`,${first.id},${second.id},`);
    await finishYearRewrite(database);
    expect(await year(one.id)).toBe(2020);
    expect(await year(two.id)).toBe(1999);
    expect(await year(three.id)).toBe(1999);
    expect(await flag()).toBe(`,${second.id},`);
    await finishYearRewrite(database);
    expect(await year(two.id)).toBe(2021);
    expect(await year(three.id)).toBe(1999);
    expect(await flag()).toBeUndefined();
  });

  it('AC-MEM-09 a flag value not shaped like a list of album ids is deleted without work', async () => {
    const album = await insertAlbum(database, PEOPLE.active.id, { name: 'A', yearTag: 2020 }, now);
    const photo = await seedDeletedMedia(database, {
      deletedAt: null,
      albumId: album.id,
      effectiveYear: 1999,
    });
    await database.db.insert(schemaMeta).values({ key: YEAR_REWRITE_FLAG, value: '1' });
    await finishYearRewrite(database);
    expect(
      await database.db.select().from(schemaMeta).where(eq(schemaMeta.key, YEAR_REWRITE_FLAG)),
    ).toHaveLength(0);
    expect(
      (await database.db.select().from(media).where(eq(media.id, photo.id)).limit(1))[0]!
        .effectiveYear,
    ).toBe(1999);
  });

  it('AC-MEM-09 reconcile drains the purge backlog before rewriting the counter and a later traffic purge cannot subtract it again', async () => {
    for (let n = 0; n < 21; n++) {
      const row = await seedDeletedMedia(database);
      objects.set(row.objectKey, 12);
      objects.set(row.thumbKey, 8);
    }
    await runHousekeeping(['--reconcile'], deps());
    await runner().run(now);
    expect((await usage(database)).committedBytes).toBe(0);
    expect(objects.size).toBe(0);
  });

  it('AC-MEM-09 reconcile follows listing cursors and fails a stuck listing without marking the ledger reconciled', async () => {
    const row = await seedDeletedMedia(database, { deletedAt: null });
    objects.set(row.objectKey, 12);
    objects.set(row.thumbKey, 8);
    objects.set(`media/v1/${uuidv7()}/image.webp`, 99);
    const list = storage.list.getMockImplementation()!;
    storage.list.mockImplementation(async (prefix, cursor) => {
      const page = await list(prefix, cursor);
      return {
        objects: page.objects.slice(0, 1),
        ...(page.objects.length > 1 ? { cursor: page.objects[0]!.key } : {}),
      };
    });
    await runHousekeeping(['--reconcile'], deps());
    expect((await usage(database)).committedBytes).toBe(20);
    storage.list.mockImplementation(async () => ({ objects: [], cursor: 'stuck' }));
    await expect(runHousekeeping(['--reconcile'], { ...deps(), now: now + 1 })).rejects.toThrow(
      'did not advance',
    );
    expect((await usage(database)).lastReconciledAt).toBe(now);
  });

  it('AC-MEM-09 a failed reconcile delete never stamps a successful reconciliation', async () => {
    objects.set(`media/v1/${uuidv7()}/image.webp`, 10);
    storage.delete.mockRejectedValueOnce(new Error('delete failed'));
    await expect(runHousekeeping(['--reconcile'], deps())).rejects.toThrow('delete failed');
    expect((await usage(database)).lastReconciledAt).toBeNull();
  });
});
