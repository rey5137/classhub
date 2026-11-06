import { applyD1Migrations, env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { createRemoteDatabase } from '../../src/lib/server/adapters/cloudflare/remote-database';
import { R2ObjectStorage } from '../../src/lib/server/adapters/cloudflare/r2-storage';
import {
  media,
  schemaMeta,
  storageUsage,
  uploadReservations,
  users,
} from '../../src/lib/server/db/schema';
import { staleYearRows } from '../../src/lib/server/repositories/gallery';
import {
  releaseExpired,
  retainedObjectKeys,
  retireOrphanAvatars,
} from '../../src/lib/server/repositories/housekeeping';
import { uuidv7 } from '../../src/lib/server/ids';
import {
  completeReservation,
  finalKeys,
  findReservation,
} from '../../src/lib/server/repositories/media';
import { readOperations } from '../../src/lib/server/repositories/operations';
import { JobRunner } from '../../src/lib/server/services/job-runner';
import { monthKey } from '../../src/lib/server/services/operations';
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
  const avatar = (overrides: Partial<typeof media.$inferInsert> = {}) =>
    seedDeletedMedia(database, {
      mediaType: 'avatar',
      thumbKey: '',
      thumbSizeBytes: 0,
      deletedAt: null,
      createdAt: now - 2 * 3_600_000,
      ...overrides,
    });
  const live = async () =>
    (await database.db.select().from(media).where(eq(media.mediaType, 'avatar'))).filter(
      (row) => row.deletedAt === null,
    ).length;

  it('R-MEM-13 retireOrphanAvatars retires old non-current avatars, keeps the current and recent ones', async () => {
    const current = await avatar();
    const old = await avatar();
    const recent = await avatar({ createdAt: now - 60_000 });
    const photo = await seedDeletedMedia(database, {
      deletedAt: null,
      createdAt: now - 2 * 3_600_000,
    });
    await database.db
      .update(users)
      .set({ avatarMediaId: current.id })
      .where(eq(users.id, PEOPLE.active.id));
    await retireOrphanAvatars(database, now);
    const rows = await database.db.select().from(media);
    const deleted = (id: string) => rows.find((row) => row.id === id)!.deletedAt;
    expect(deleted(old.id)).toBe(now);
    expect(deleted(current.id)).toBeNull();
    expect(deleted(recent.id)).toBeNull();
    expect(deleted(photo.id)).toBeNull();
    await database.db
      .update(users)
      .set({ avatarMediaId: null })
      .where(eq(users.id, PEOPLE.active.id));
  });

  it('R-MEM-13 retireOrphanAvatars takes at most 20 per run, and a traffic run does it while the CLI run does not', async () => {
    for (let n = 0; n < 25; n++) await avatar();
    await retireOrphanAvatars(database, now);
    expect(await live()).toBe(5);
    await runner().run(now);
    expect(await live()).toBe(5);
    await runner().trigger(now);
    expect(await live()).toBe(0);
  });

  it('R-MEM-13 the orphan-avatar lookup uses the media index, not a media scan', async () => {
    const plan = await env.DB.prepare(
      `explain query plan select id from media where media_type = 'avatar' and deleted_at is null and created_at <= ?1 and not exists (select 1 from users where avatar_media_id = media.id) order by created_at limit 20`,
    )
      .bind(now)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    expect(details.some((detail) => /SEARCH media USING (COVERING )?INDEX/.test(detail))).toBe(
      true,
    );
    expect(details.some((detail) => /SCAN media\b(?! USING)/.test(detail))).toBe(false);
  });

  it('R-MEM-18 a traffic run counts its listing as Class A and its deletes as nothing; a CLI run counts nothing', async () => {
    await write('staging/v1/orphan-a/image.webp', 4);
    await write('staging/v1/orphan-b/image.webp', 4);
    const before = await readOperations(database, monthKey(now));
    await runner().trigger(now);
    const after = await readOperations(database, monthKey(now));
    // One listing page; deleting the two orphans is not billed.
    expect(after.classA - before.classA).toBe(1);
    await write('staging/v1/orphan-c/image.webp', 4);
    await runner().run(now);
    expect(await readOperations(database, monthKey(now))).toEqual(after);
  });

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
  await write(`media/v1/${uuidv7()}/image.webp`, 10);
  await write(`avatars/v1/owner/${uuidv7()}.webp`, 10);
  await write('staging/orphan', 10);
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
  // The open reservation's copied finals (20 bytes) are still in reserved_bytes, not counted twice.
  expect((await usage(database)).committedBytes).toBe(
    (await storage.list('')).objects
      .filter((object) => !object.key.startsWith('staging/'))
      .reduce((sum, object) => sum + object.size, 0) - 20,
  );
  expect((await usage(database)).lastReconciledAt).toBe(now);
  expect((await usage(database)).reservedBytes).toBe(20);
  expect(await runHousekeeping(['--reconcile'], { ...deps, now: now + 1 })).toBe(0);
  expect((await usage(database)).committedBytes).toBe(40);
  expect((await usage(database)).lastReconciledAt).toBe(now + 1);
});

it('AC-MEM-09 the reconcile key lookups use the primary key and the open-state index, never a media scan', async () => {
  const recorded: { sql: string; params: unknown[] }[] = [];
  const remote = createRemoteDatabase(async (statement) => {
    recorded.push(statement);
    return [{ success: true, results: { columns: [], rows: [] }, meta: { changes: 0 } }];
  });
  const keys = [
    ...Array.from({ length: 3 }, () => `media/v1/${uuidv7()}/image.webp`),
    `avatars/v1/owner/${uuidv7()}.jpg`,
    'staging/v1/a/image.webp',
  ];
  await retainedObjectKeys(remote, keys, now);
  expect(recorded.some((statement) => statement.sql.includes('from "media"'))).toBe(true);
  for (const { sql, params } of recorded) {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join('\n');
    expect(details).not.toMatch(/SCAN (media|upload_reservations)\b(?! USING)/);
    if (sql.includes('from "media"'))
      expect(details).toMatch(/SEARCH media USING INDEX sqlite_autoindex_media_1/);
  }
});

it('AC-MEM-09 the year-rewrite sweep select searches media_album_idx, never a media scan', async () => {
  const { sql, params } = staleYearRows(database, uuidv7()).toSQL();
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join('\n');
  expect(details).toMatch(/SEARCH media USING INDEX media_album_idx/);
  expect(details).not.toMatch(/SCAN media\b(?! USING)/);
});
