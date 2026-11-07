import { applyD1Migrations, env } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createD1Database } from '../../src/lib/server/adapters/cloudflare/d1-database';
import { chatArchives, chatMessages } from '../../src/lib/server/db/schema';
import {
  chatOverRetention,
  exportCandidates,
  ndjsonSha256,
  pruneArchived,
  recordVerifiedArchive,
  toNdjson,
  type CandidateRange,
} from '../../src/lib/server/repositories/chat-archive';
import { load as adminLoad } from '../../src/routes/admin/+page.server';
import { PEOPLE, seedMembership } from '../fixtures/membership';
import { createHarness } from '../fixtures/pipeline-harness';

// Synthetic only (INV-6): fixture members and generated message text.
const NOW = Date.UTC(2026, 10, 6, 12);
const HOUR = 3_600_000;
const policy = { retainDays: 365, maxMessages: 5 };
let database: ReturnType<typeof createD1Database>;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  database = createD1Database(env.DB as unknown as Parameters<typeof createD1Database>[0]);
  await seedMembership(database);
});
beforeEach(async () => {
  await database.db.delete(chatArchives);
  await database.db.delete(chatMessages);
});

/**
 * `count` hourly messages on one day, ids `m00…` in time order from `first`; `deleted` are
 * tombstones.
 */
async function seed(count: number, deleted: number[] = [], first = 0) {
  const start = NOW - 3 * 24 * HOUR;
  for (let index = first; index < first + count; index += 1) {
    const createdAt = start + index * HOUR;
    await database.db.insert(chatMessages).values({
      id: `m${String(index).padStart(2, '0')}`,
      roomId: 'main',
      senderId: PEOPLE.active.id,
      clientNonce: `n${index}`,
      body: deleted.includes(index) ? '' : `synthetic ${index}`,
      createdAt,
      deletedAt: deleted.includes(index) ? createdAt : null,
    });
  }
}

/** What export-chat records once the written file has been read back (R-CHAT-14). */
async function archive(): Promise<CandidateRange> {
  const [range, ...rest] = await exportCandidates(database, policy, NOW);
  expect(rest).toEqual([]);
  await recordVerifiedArchive(database, {
    range: range!,
    sha256: ndjsonSha256(toNdjson(range!.records)),
    exportedAt: NOW,
    verifiedAt: NOW,
  });
  return range!;
}

const ids = async () =>
  (
    await database.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .orderBy(asc(chatMessages.id))
  ).map((row) => row.id);
const purgedAt = async () =>
  (await database.db.select({ purgedAt: chatArchives.purgedAt }).from(chatArchives)).map(
    (row) => row.purgedAt,
  );
const run = (options: Partial<Parameters<typeof pruneArchived>[1]> = {}) =>
  pruneArchived(database, { now: () => NOW + 1, pause: async () => {}, ...options });

describe('prune-chat', () => {
  it('AC-CHAT-09 deletes nothing without a verified archive', async () => {
    await seed(10);
    expect(await run()).toEqual({ status: 'no-archive' });

    // An archive row never verified does not count either.
    const [range] = await exportCandidates(database, policy, NOW);
    await database.db.insert(chatArchives).values({
      id: 'a1',
      fileName: range!.fileName,
      fromId: range!.from.id,
      toId: range!.to.id,
      rangeStart: range!.from.createdAt,
      rangeEnd: range!.to.createdAt,
      recordCount: range!.records.length,
      sha256: 'x',
      exportedAt: NOW,
    });
    expect(await run()).toEqual({ status: 'no-archive' });
    expect(await ids()).toHaveLength(10);
  });

  it('AC-CHAT-09 deletes exactly the archived range, rows left out of the file included', async () => {
    // m01 and m03 are tombstones: not in the file (R-CHAT-15), still inside the id range.
    await seed(10, [1, 3]);
    const range = await archive();
    expect(range).toMatchObject({ from: { id: 'm00' }, to: { id: 'm04' } });
    expect(range.records.map((record) => record.id)).toEqual(['m00', 'm02', 'm04']);

    expect(await run()).toEqual({
      status: 'pruned',
      deleted: 5,
      purged: [range.fileName],
      remaining: false,
    });

    expect(await ids()).toEqual(['m05', 'm06', 'm07', 'm08', 'm09']);
    expect(await purgedAt()).toEqual([NOW + 1]);
    // Purged ranges are done: a second run has no archive to work on and deletes nothing.
    expect(await run()).toEqual({ status: 'no-archive' });
    expect(await ids()).toHaveLength(5);
  });

  it('AC-CHAT-17 deletes in bounded chunks and resumes after an interruption without losing or double-purging rows', async () => {
    await seed(12);
    const range = await exportCandidates(database, { retainDays: 365, maxMessages: 4 }, NOW);
    await recordVerifiedArchive(database, {
      range: range[0]!,
      sha256: ndjsonSha256(toNdjson(range[0]!.records)),
      exportedAt: NOW,
      verifiedAt: NOW,
    });
    let pauses = 0;
    const interrupted = vi.fn(async () => {
      pauses += 1;
      // The run dies after its second chunk.
      if (pauses === 2) throw new Error('interrupted');
    });

    await expect(run({ chunk: 3, pause: interrupted })).rejects.toThrow('interrupted');

    expect(await ids()).toEqual(['m06', 'm07', 'm08', 'm09', 'm10', 'm11']);
    expect(await purgedAt()).toEqual([null]);

    const resumed = vi.fn(async () => {});
    expect(await run({ chunk: 3, pause: resumed })).toEqual({
      status: 'pruned',
      deleted: 2,
      purged: [range[0]!.fileName],
      remaining: false,
    });
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(await ids()).toEqual(['m08', 'm09', 'm10', 'm11']);
    expect(await purgedAt()).toEqual([NOW + 1]);
  });

  it('AC-CHAT-17 stops at the per-run cap with purged_at unset, and the next run finishes', async () => {
    await seed(12);
    const range = await archive();

    expect(await run({ chunk: 2, maxRows: 3 })).toEqual({
      status: 'pruned',
      deleted: 3,
      purged: [],
      remaining: true,
    });
    expect(await purgedAt()).toEqual([null]);

    // Seven archived rows: 3, then 3, then the last one and the purge.
    expect(await run({ chunk: 2, maxRows: 3 })).toMatchObject({ deleted: 3, remaining: true });
    expect(await purgedAt()).toEqual([null]);
    expect(await run({ chunk: 2, maxRows: 3 })).toEqual({
      status: 'pruned',
      deleted: 1,
      purged: [range.fileName],
      remaining: false,
    });
    expect(await ids()).toEqual(['m07', 'm08', 'm09', 'm10', 'm11']);
  });

  it('INV-7 deletes nothing from a range that gained a message after verification', async () => {
    await seed(10);
    const range = await archive();
    await database.db.insert(chatMessages).values({
      id: 'm02a',
      roomId: 'main',
      senderId: PEOPLE.active.id,
      clientNonce: 'late',
      body: 'not in the archive',
      createdAt: range.from.createdAt + 2 * HOUR,
    });

    expect(await run()).toMatchObject({ status: 'grown', fileName: range.fileName, deleted: 0 });
    expect(await ids()).toHaveLength(11);
    expect(await purgedAt()).toEqual([null]);
  });

  it('INV-7 a deletion after the export cannot hide a late message in the range', async () => {
    await seed(10);
    const range = await archive();
    // m02 was in the file and is deleted afterwards; m02a arrives late and is in no file.
    await database.db
      .update(chatMessages)
      .set({ body: '', deletedAt: NOW + 5 })
      .where(eq(chatMessages.id, 'm02'));
    await database.db.insert(chatMessages).values({
      id: 'm02a',
      roomId: 'main',
      senderId: PEOPLE.active.id,
      clientNonce: 'late',
      body: 'not in the archive',
      createdAt: range.from.createdAt + 2 * HOUR,
    });

    expect(await run()).toMatchObject({ status: 'grown', fileName: range.fileName, deleted: 0 });
    expect(await ids()).toHaveLength(11);
    expect(await purgedAt()).toEqual([null]);
  });

  it('R-CHAT-14, INV-7 keeps a message deleted after the export as its tombstone and clears the rest', async () => {
    await seed(10);
    const first = await archive();
    expect(first).toMatchObject({ from: { id: 'm00' }, to: { id: 'm04' } });
    // m02 was in the file; its author deleted it after the export.
    await database.db
      .update(chatMessages)
      .set({ body: '', deletedAt: NOW + 5 })
      .where(eq(chatMessages.id, 'm02'));

    expect(await run()).toEqual({
      status: 'pruned',
      deleted: 4,
      purged: [first.fileName],
      remaining: false,
    });
    // The tombstone stays, so restore --chat finds its id and cannot bring the text back.
    expect(await ids()).toEqual(['m02', 'm05', 'm06', 'm07', 'm08', 'm09']);
    const [kept] = await database.db
      .select({ body: chatMessages.body, deletedAt: chatMessages.deletedAt })
      .from(chatMessages)
      .where(eq(chatMessages.id, 'm02'));
    expect(kept).toEqual({ body: '', deletedAt: NOW + 5 });
    expect(await purgedAt()).toEqual([NOW + 1]);

    // Not stuck: the next candidates archive and prune past the kept tombstone.
    await seed(5, [], 10);
    const second = await archive();
    expect(second).toMatchObject({ from: { id: 'm05' }, to: { id: 'm09' } });
    expect(await run()).toEqual({
      status: 'pruned',
      deleted: 5,
      purged: [second.fileName],
      remaining: false,
    });
    expect(await ids()).toEqual(['m02', 'm10', 'm11', 'm12', 'm13', 'm14']);
  });

  it('R-CHAT-14 the /admin banner shows while candidates have no verified archive', async () => {
    expect(await chatOverRetention(database, policy, NOW)).toBe(false);
    await seed(10);
    expect(await chatOverRetention(database, { retainDays: 365, maxMessages: 10 }, NOW)).toBe(
      false,
    );
    expect(await chatOverRetention(database, policy, NOW)).toBe(true);
    await archive();
    expect(await chatOverRetention(database, policy, NOW)).toBe(false);
    // Older than retainDays shows it even under maxMessages.
    expect(await chatOverRetention(database, { retainDays: 1, maxMessages: 100 }, NOW)).toBe(true);
  });

  it('R-CHAT-14 /admin loads the over-retention flag for the banner', async () => {
    const harness = await createHarness(database, {
      resolve: async (event) => {
        const data = (await adminLoad(event as never)) as { chatOverRetention: boolean };
        return Response.json({ chatOverRetention: data.chatOverRetention });
      },
    });
    const view = async () =>
      (await (
        await harness.send('/admin', {
          headers: await harness.as(PEOPLE.admin.email),
          routeId: '/admin',
        })
      ).json()) as { chatOverRetention: boolean };

    expect(await view()).toEqual({ chatOverRetention: false });
    // Older than site.config's retainDays (365).
    await database.db.insert(chatMessages).values({
      id: 'old',
      roomId: 'main',
      senderId: PEOPLE.active.id,
      clientNonce: 'old',
      body: 'synthetic old message',
      createdAt: Date.now() - 400 * 24 * HOUR,
    });
    expect(await view()).toEqual({ chatOverRetention: true });
  });
});
