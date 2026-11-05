import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import {
  media,
  schemaMeta,
  storageUsage,
  uploadReservations,
} from '../../src/lib/server/db/schema';
import { releaseExpired } from '../../src/lib/server/repositories/housekeeping';
import {
  completeReservation,
  finalKeys,
  findReservation,
} from '../../src/lib/server/repositories/media';
import { JobRunner } from '../../src/lib/server/services/job-runner';
import {
  HOUSEKEEPING_NOW as now,
  seedDeletedMedia,
  seedReservation,
  usage,
} from '../fixtures/housekeeping';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness } from '../fixtures/pipeline-harness';
import { runHousekeeping } from '../../scripts/lib/housekeeping.mjs';

let database: ReturnType<typeof createD1Database>;
let storage: R2ObjectStorage;
const bytes = (size: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(size));
      c.close();
    },
  });
const write = (key: string, size: number) =>
  storage.put(key, bytes(size), { contentType: 'image/webp', maxBytes: size });
const runner = () => new JobRunner({ database, storage });
const keys = async () => (await storage.list('')).objects.map((object) => object.key).sort();
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  storage = new R2ObjectStorage(
    env.MEDIA as unknown as ConstructorParameters<typeof R2ObjectStorage>[0],
  );
  await seedMembership(database);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await storage.delete(await keys());
  await database.db.delete(media);
  await database.db.delete(uploadReservations);
  await database.db
    .update(storageUsage)
    .set({ committedBytes: 0, reservedBytes: 0, lastReconciledAt: null });
  await database.db
    .update(schemaMeta)
    .set({ value: '0' })
    .where(eq(schemaMeta.key, 'housekeeping_last_run_at'));
});

describe('housekeeping on D1/R2', () => {
  it('AC-MEM-09 expiry releases only open rows once and sweeps orphan staging without touching live objects', async () => {
    const expired = await seedReservation(database);
    const live = await seedReservation(database, { expiresAt: now + 60_000 });
    await write(expired.objectKey, 12);
    await write(expired.thumbKey, 8);
    await write(live.objectKey, 12);
    await write('staging/no-row', 3);
    await write('media/unrelated', 5);
    await runner().run(now);
    expect((await findReservation(database, expired.id))!.state).toBe('released');
    expect((await usage(database)).reservedBytes).toBe(20);
    expect(await keys()).toEqual(['media/unrelated', live.objectKey].sort());
    await runner().run(now);
    expect((await usage(database)).reservedBytes).toBe(20);
  });

  it('AC-MEM-09 authenticated traffic triggers housekeeping at most hourly; denied traffic cannot claim a slot', async () => {
    const harness = await createHarness(database, { storage, now: () => now });
    await harness.send('/api/v1/me');
    const [before] = await database.db
      .select()
      .from(schemaMeta)
      .where(eq(schemaMeta.key, 'housekeeping_last_run_at'))
      .limit(1);
    expect(before!.value).toBe('0');
    const auth = await harness.as(PEOPLE.active.email);
    const list = vi.spyOn(storage, 'list');
    await Promise.all(
      Array.from({ length: 10 }, () => harness.send('/api/v1/me', { headers: auth })),
    );
    await harness.settleHousekeeping();
    expect(list).toHaveBeenCalledTimes(1);
    const later = await createHarness(database, { storage, now: () => now + 3_600_001 });
    await later.send('/api/v1/me', { headers: await later.as(PEOPLE.active.email) });
    await later.settleHousekeeping();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('AC-MEM-09 a pending or failed background listing leaves the request response unchanged', async () => {
    const resolve = () =>
      new Response(JSON.stringify({ ok: 'unchanged' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    const harness = await createHarness(database, { storage, now: () => now, resolve });
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => {
      reject = fail;
    });
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    vi.spyOn(storage, 'list').mockImplementationOnce(() => {
      start();
      return pending;
    });
    const response = await harness.send('/api/v1/me', {
      headers: await harness.as(PEOPLE.active.email),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: 'unchanged' });
    await started;
    reject(new Error('synthetic list failure'));
    await harness.settleHousekeeping();
    const later = await harness.send('/api/v1/me', {
      headers: await harness.as(PEOPLE.active.email),
    });
    expect(later.status).toBe(202);
    expect(await later.json()).toEqual({ ok: 'unchanged' });
    await harness.settleHousekeeping();
  });

  it('AC-MEM-12 a complete racing housekeeping preserves committed bytes and cannot double release', async () => {
    const seeded = await seedReservation(database);
    const row = (await findReservation(database, seeded.id))!;
    await Promise.all([
      completeReservation(database, row, {}, now - 2),
      releaseExpired(database, [row.id], now),
    ]);
    await releaseExpired(database, [row.id], now);
    const state = (await findReservation(database, row.id))!.state;
    const totals = await usage(database);
    expect(totals.reservedBytes).toBe(0);
    expect(totals.committedBytes).toBe(state === 'completed' ? 20 : 0);
    expect((await database.db.select().from(media).limit(50)).length).toBe(
      state === 'completed' ? 1 : 0,
    );
  });

  it('AC-MEM-13 retains grace-period objects, retries a failed delete, and subtracts purged bytes only once', async () => {
    const old = await seedDeletedMedia(database);
    const recent = await seedDeletedMedia(database, { deletedAt: now - 1 });
    for (const row of [old, recent]) {
      await write(row.objectKey, 12);
      await write(row.thumbKey, 8);
    }
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'));
    await expect(runner().run(now)).rejects.toThrow('R2 unavailable');
    expect((await usage(database)).committedBytes).toBe(40);
    expect(
      (await database.db.select().from(media).where(eq(media.id, old.id)).limit(1))[0]!.purgedAt,
    ).toBeNull();
    await Promise.all([runner().run(now), runner().run(now)]);
    await runner().run(now);
    expect((await usage(database)).committedBytes).toBe(20);
    expect(await keys()).toEqual([recent.objectKey, recent.thumbKey].sort());
  });
});

it('AC-MEM-09 CLI reconcile on D1/R2 retains live keys, deletes orphans and matches the bucket on repeated runs', async () => {
  const live = await seedDeletedMedia(database, { deletedAt: null });
  const grace = await seedDeletedMedia(database, { deletedAt: now - 1 });
  const purged = await seedDeletedMedia(database, { deletedAt: now - 1, purgedAt: now - 1 });
  for (const row of [live, grace, purged]) {
    await write(row.objectKey, 12);
    await write(row.thumbKey, 8);
  }
  for (const prefix of ['media/', 'avatars/', 'staging/']) await write(`${prefix}orphan`, 10);
  const open = await seedReservation(database, { expiresAt: now + 60_000 });
  const finals = finalKeys((await findReservation(database, open.id))!);
  for (const key of [open.objectKey, finals.objectKey]) await write(key, 12);
  for (const key of [open.thumbKey, finals.thumbKey]) await write(key, 8);
  const deps = { database, storage, now, out: () => {} };
  expect(await runHousekeeping(['--reconcile'], deps)).toBe(0);
  expect(await keys()).toEqual(
    [
      live.objectKey,
      live.thumbKey,
      grace.objectKey,
      grace.thumbKey,
      open.objectKey,
      open.thumbKey,
      finals.objectKey,
      finals.thumbKey,
    ].sort(),
  );
  expect((await usage(database)).committedBytes).toBe(
    (await storage.list('')).objects
      .filter((object) => !object.key.startsWith('staging/'))
      .reduce((sum, object) => sum + object.size, 0),
  );
  expect((await usage(database)).lastReconciledAt).toBe(now);
  expect((await usage(database)).reservedBytes).toBe(20);
  expect(await runHousekeeping(['--reconcile'], { ...deps, now: now + 1 })).toBe(0);
  expect((await usage(database)).committedBytes).toBe(60);
  expect((await usage(database)).lastReconciledAt).toBe(now + 1);
});
